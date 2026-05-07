# 別PCで `agent-history` がサイレント終了する問題の切り分け手順

Node v24.14 環境向け。PowerShell で順番にコピペ実行してください。
**B-1 か B-2 のどちらかで必ずエラーメッセージが出る**ので、その出力を貼り付けてもらえれば原因を特定できます。

---

## 前提：npx キャッシュをクリアしておく

過去に壊れた版が `_npx` に残っていると同じ症状が再発します。

```powershell
npm cache clean --force
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_npx" -ErrorAction SilentlyContinue
```

---

## B-1. npx 経由で全ストリームを拾って実行

PowerShell の `*>&1` は **stdout / stderr / warning / verbose / debug / information すべて** を 1 本のストリームにマージするので、見落としがなくなります。

```powershell
npx --yes @contextberg/agent-history@0.1.4 *>&1 | Tee-Object ah.log
```

実行後（プロンプトが戻ってきたら）：

```powershell
Get-Content ah.log
```

---

## B-2. グローバルインストールして node から直接叩く

npx の shim 層を完全に排除します。

```powershell
npm install -g @contextberg/agent-history@0.1.4
$pkg = (npm root -g) + "\@contextberg\agent-history\dist\cli.js"
Test-Path $pkg            # True が出れば配置OK
node $pkg *>&1 | Tee-Object ah-direct.log
```

プロンプトが戻ったら：

```powershell
Get-Content ah-direct.log
$LASTEXITCODE              # 直前の node プロセスの終了コード
```

---

## 期待する出力

正常起動なら以下が表示され、プロセスは **フォアグラウンドに居続けます**：

```
agent-history running at http://localhost:3847
```

失敗時はどちらかが出るはず：

- `[agent-history] Failed to start server: <理由>` ← Fastify起動失敗
- スタックトレース ← モジュール読込失敗
- 何も出ずに即 exit → ポート占有 / アンチウイルスブロック / shim破損 を疑う

---

## 補助：環境チェック

```powershell
node --version                                            # v24.14.x のはず
node -e "console.log('ok')"                               # ok と出るか
Get-NetTCPConnection -LocalPort 3847,3848,3849,3850,3851 -ErrorAction SilentlyContinue
                                                           # 何か出たらポート占有
Get-MpPreference | Select-Object DisableRealtimeMonitoring
                                                           # Defender がブロックしていないか
```

---

## 結果の貼り方

`ah.log` または `ah-direct.log` の中身をそのまま貼ってください。
空ファイル（0バイト）の場合は **Node プロセスが起動前に kill されている** 可能性が高く、Defender ／ EDR ／ AppLocker を疑います。
