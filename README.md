# @contextberg/agent-history

**AIコーディングエージェントの会話履歴を、ひとつの場所で読み返す。**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
[![npm](https://img.shields.io/npm/v/@contextberg/agent-history)](https://www.npmjs.com/package/@contextberg/agent-history)

Claude Code、Cursor、Codex などのAIコーディングエージェントは、会話のたびにローカルのJSONLファイルやSQLiteへ履歴を書き出している。そのデータには、バグの原因を掘り下げた推論、設計の判断過程、エラーからの復帰ログが詰まっている。しかしツールをまたいで参照する手段がなく、ほとんどの履歴は読まれることなく眠り続ける。

`@contextberg/agent-history` はブラウザUIとMCPサーバーの二つのかたちで、その履歴を取り戻す。

---

<!-- TODO: スクリーンショット（左: セッション一覧＋ソースフィルター、右: 会話詳細＋ツールコール展開） -->

---

## 対応ツール

| ツール | 読み取り元 |
|--------|-----------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Cursor | `~/.cursor/projects/` |
| OpenClaw | `~/.openclaw/agents/` |
| Codex | `~/.codex/sessions/` |
| Hermes | `~/.hermes/state.db` |
| GitHub Copilot | 🚧 コントリビューション歓迎 |

---

## クイックスタート

```bash
npx @contextberg/agent-history
```

ブラウザが自動で開く。インストール不要。

**グローバルインストールする場合：**

```bash
npm install -g @contextberg/agent-history
agent-history
```

---

## MCPサーバーとして使う

Claude Desktop などの設定ファイルに追加する：

```json
{
  "mcpServers": {
    "agent-history": {
      "command": "npx",
      "args": ["-y", "@contextberg/agent-history", "--mcp"]
    }
  }
}
```

設定後、エージェントから `get_agent_history` ツールを呼び出すことで過去セッションの内容をコンテキストに取り込める。

---

## ロードマップ

coming soon

---

## コントリビュート

コントリビューションを歓迎します。新しいエージェントツールの対応追加が最も典型的なコントリビューションの形です。

**クイックスタート：**

```bash
git clone https://github.com/contextberg/agent-history
cd agent-history
npm install
npm run dev:server   # Fastify on 127.0.0.1:3847
npm run dev:web      # Vite on :5173, /api をプロキシ
```

**新しいツールを追加する：**

`IReader` インターフェースを実装したファイルを1つ作り、3箇所に登録するだけです。

```typescript
export interface IReader {
  readonly source: AgentSource;
  isInstalled(): Promise<boolean>;
  read(options?: ReaderOptions): Promise<AgentSession[]>;
}
```

1. `src/readers/<toolname>.ts` を作成して `IReader` を実装
2. `AgentSource` 型に追加（`src/readers/types.ts`）
3. `AgentHistoryService` のリーダーリストに登録（`src/readers/index.ts`）
4. MCPスキーマの enum に追加（`src/mcp/server.ts`）

ソース固有のロジックはすべてリーダー層の中にとどめること。

---

## ライセンス

MIT — see [LICENSE](./LICENSE). Built by [Contextberg](https://contextberg.com).
