# コミット紐付けロジック

**By commit** ビューが、どのエージェントセッションをどの git コミットに結
び付けるかを決めるルール。リーダー / スコアラ / アグリゲータをいじるとき
に「なぜこの判定なのか」を辿るための文書。

## このビューが答えていること

各コミットに対して、それに**寄与した可能性が高いセッション**を、エージェ
ント横断で並べる(claude-code, codex, cursor, openclaw, hermes, copilot)。

前提として、

- **1 コミット = 複数セッション**(別ターミナルでの作業や `--resume` を1つ
  のコミットにまとめる)
- **1 セッション = 複数コミット**(長いセッション中に何回もコミットする)

つまり N対N の関係。

紐付け結果は**保存しない**。リクエスト毎に session JSONL/SQLite と
`git log` から再計算する。マイグレーションもキャッシュ無効化も DB も
不要。コストは「リポジトリ毎に `git rev-parse` + `git log` 1往復」。

## 2 段階パイプライン

```
sessions ──┐
           ├──► 発見 ──► repo 毎の候補セッション ──► 採点 ──► commit 毎のリンク
git log ───┘
```

### 第 1 段階 — 発見 (`src/server/commits.ts`)

「このセッションはどの repo に居たか」を判定する。3 つのチャネル(加算的)。

1. **`session.cwd` が repo 内にある** — claude-code, codex, openclaw が記
   録。cursor も新しい composer なら取れる。各 distinct な cwd に対して
   `git rev-parse --show-toplevel` で repo root を引き、結果をキャッシュ。

2. **`session.turns[].touchedFiles` の*絶対*パスが repo 内にある** —
   openclaw のように `~/.openclaw/workspace` で動きながら、別 repo の絶対
   パスに `write` するエージェントを救う。
   *相対*パスは意図的に除外する。`path.resolve` がサーバープロセスの cwd
   に対して resolve し、agent-history 内の幻のマッチを作ってしまうため
   (特に `write_file` が常に相対の hermes で問題化した)。

3. **`session.referencedCommits` が repo の SHA と一致する** — cwd を記
   録しないソース(hermes)向け。tool 出力に含まれる `git log` の出力か
   ら SHA を抜き取り、「この repo で動いていた」シグナルとして使う。
   全 repo のフェッチ済みコミットから sha→repo マップを構築して照合。

アグリゲータは チャネル 1+2 で見つかった repo root を集め、各 repo から
直近 300 コミット(ウィンドウ: `since = 関連セッション最早 - 1日`)を
フェッチ → 結果から チャネル 3 を計算する。

### 第 2 段階 — 採点 (`src/linkage/scorer.ts`)

各 (session, commit) ペアを 4 軸で `[0, 1]` 採点する:

| 次元 | 重み | 内容 |
|---|---|---|
| `repo`     | 0.25 | コミットの repo にセッションが属するか(0/1) |
| `time`     | 0.35 | コミット時刻が、セッションの**編集アクティブ窓**にどれだけ近いか |
| `files`    | 0.35 | 非対称: コミットの変更ファイルのうち何割をセッションが触ったか |
| `branch`   | 0.05 | session.gitBranch ↔ commit のブランチ一致(現状ほぼ 0) |

合計 = 重み付き和。**ただし `repo === 0` なら早期リターンで合計 0** — repo
に居なかったセッションが寄与した可能性は無いため。

#### `repo`

アグリゲータが渡す `repoMatched` ヒント(チャネル 1/2/3 のいずれか)が
`true` なら 1。なければスコアラ側で再度 cwd / 絶対 touchedFiles を直接
チェック。
チャネル 3 (referencedCommits) を経由した repo 確定セッションは、その
repo の*他のあらゆる*コミットに対しても repo=1 として採点される。これ
が無いと、「hermes が SHA X を参照 → repo R に確定」しても、コミット X
以外には `repo=0` で採点されてしまう。

#### `time`

「セッションの**編集アクティブ窓**」の前後で 1 にピーク。

- 窓は `turn.startedAt`/`turn.endedAt` を、`touchedFiles` が空でない turn
  だけから min/max したもの。「10時間開いていたセッション」が「14:02 ~
  14:18 に編集」した、と絞り込める。
- per-turn timestamp を持たないソース(hermes は top-level のみ、cursor は
  user bubble に無い)はセッション全体窓にフォールバック。
- 減衰は非対称: 窓の**後**は 6 時間で線形減衰(開発者は作業後にコミット
  する)、窓の**前**は 1 時間で減衰しつつさらに ×0.3 で重く減衰(編集の
  前にコミットされたものが編集の結果であるはずがない)。

#### `files`

非対称ジャッカード:
`|commit.files ∩ session.touchedFiles| / |commit.files|`。
意味は「**コミットの変更のうち何割をこのセッションが編集したか**」。これ
が我々の知りたいことに直接対応する — セッションは多くのファイルを*探索*
で読むが、コミットには*編集*しか入らない。

「編集」とみなすツール(ソース別):

| ソース | ツール |
|---|---|
| claude-code | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` (`Read` は除外) |
| codex       | shell コマンド中の `apply_patch` マーカー / 構造化引数の `path`/`file_path` |
| openclaw    | `write`, `edit` |
| cursor      | `diffsSinceLastApply[].relativeWorkspacePath`(直前ターンに帰属) |
| hermes      | `write_file`, `edit_file`(相対パスのみ — files スコアには寄与しない) |

#### `branch`

両側が同じ git ブランチを記録していれば 1。現状は claude-code のみが
`session.gitBranch` を populate するので、それ以外は実質 0。

### 特例 — "referenced authoring" のフロア

`session.referencedCommits` がコミットの SHA を含み、**かつ**コミット時
刻がセッション開始 *以降* なら、合計を **0.85 にフロア**する。これは
「エージェントが直前に作ったコミットを `git log` で確認した」ような状況
を捕まえる。

逆に、コミットがセッション開始 *より前* なら、SHA 参照は単に「過去の履
歴を読んだ」(`git log -n 5` で文脈確認等)に過ぎない。**この場合 0.85
フロアは適用しない**。リンクの強さは時間/ファイル軸の通常採点に任せ、
過去コミットなら結果として近 0 になる。

これが hermes の問題を直したルール。`git log -2` で過去履歴を読んだだ
けのセッションが、その3コミットに 0.85 で「authored」と pin されてしま
う誤検出が消える。

## フィルタ

- **閾値**: 合計 < 0.45 (`DEFAULT_LINK_THRESHOLD`) のリンクは捨てる。
  「同 repo だが時刻もファイルも無関係」レベルのノイズが大半。
- **空コミット**: 閾値超のリンクが 0 件のコミットは結果から落とす(空
  行を出しても情報量ゼロ)。
- **Source フィルタ(クライアント側)**: ユーザーが特定ソースを選ぶと、
  クライアント側で (a) そのソースのリンクを 1 件以上持つコミットだけ残
  し、(b) 各コミット内のリンクもそのソースのみに narrow する。
  バッジの strong/weak 数も CommitView の strong/weak グルーピングも、
  この絞り込み後で再計算される。

## UI の階層分け (`CommitView`)

コミット内で:

- **Strong matches**: スコア ≥ 0.7。先頭にアクセント色で表示。
- **Weaker candidates**: 0.45 ≤ スコア < 0.7。下に控えめに表示。
- 対象セッションがクライアントに読み込まれていないリンクは、表示はする
  がクリック不可(transcript ドリルダウンは sidebar の `maxSessions` 制
  限に縛られる)。

## ソース別カバレッジと限界

| ソース | cwd | per-turn 時刻 | 編集パス | 備考 |
|---|---|---|---|---|
| claude-code | 行毎(常時) | あり | 絶対 | 最強。全フィールド populate 済み |
| codex       | session_meta で 1 回 | あり | 相対 or 絶対 | `apply_patch` heredoc は拾える。`python script.py` 経由の編集は取りこぼす |
| openclaw    | session 開始時に 1 回 | あり | cwd で resolve | 別 repo への絶対 write は チャネル 2 で拾う |
| cursor      | per-workspace `state.vscdb` から(古い composer は ~55%) | assistant bubble のみ | workspace 相対 | 古い composer は workspace マッピング未登録。gitBranch なし |
| hermes      | **無し** | 無し(top-level のみ) | 相対のみ | repo 帰属は チャネル 3 (referencedCommits) のみ。`files` シグナルは原理的に 0 |
| copilot     | (TODO — 未配線) | — | — | workspace.json の folder URI が cwd に相当(cursor 同型) |

## コスト

- 律速は `findRepoRoot`(distinct な候補パス毎に git spawn)。アグリゲ
  ータはパス重複排除 + 既知 repo 内に入っていれば short-circuit + 16 並
  列バッチで spawn 数を抑える。
- `readCommits` は repo 毎に 1 回。アクティブ repo ~10 件 / ソース毎セ
  ッション ~50 件で実測 200ms 以下。
- 永続化レイヤは無い。スケールが問題になったら `(sessionId, commitSha)
  → score` をキャッシュするのが自然な追加箇所(議論済みの `link_cache`
  / `link_override` テーブル設計参照)。
