# @contextberg/agent-history

**Review all your AI coding agent conversation histories in one place.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
[![npm](https://img.shields.io/npm/v/@contextberg/agent-history)](https://www.npmjs.com/package/@contextberg/agent-history)

AI coding agents like Claude Code, Cursor, and Codex write history to local JSONL files or SQLite databases after every conversation. These logs are packed with reasoning for bug hunting, architectural decision-making, and error recovery logs. However, without a cross-tool way to reference them, most histories lie dormant and unread.

`@contextberg/agent-history` reclaims that history via both a browser-based UI and an MCP server.

---

<!-- TODO: Screenshots (Left: Session list + Source filter, Right: Conversation details + Expanded tool calls) -->

---

## Supported Tools

| Tool | Source |
|------|--------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Cursor | `~/.cursor/projects/` |
| OpenClaw | `~/.openclaw/agents/` |
| Codex | `~/.codex/sessions/` |
| Hermes | `~/.hermes/state.db` |
| GitHub Copilot | 🚧 Contributions Welcome |

---

## Quick Start

```bash
npx @contextberg/agent-history
```

The browser will open automatically. No installation required.

**To install globally:**

```bash
npm install -g @contextberg/agent-history
agent-history
```

---

## Using as an MCP Server

Add it to your configuration file (e.g., Claude Desktop):

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

Once configured, you can bring past session content into your agent's context by calling the `get_agent_history` tool.

---

## Roadmap

coming soon

---

## Contributing

Contributions are welcome! Adding support for new agent tools is the most common way to contribute.

**Quick Start:**

```bash
git clone https://github.com/contextberg/agent-history
cd agent-history
npm install
npm run dev          # Starts API server (3847) + Vite (5173) simultaneously → opens http://localhost:5173
```

**Adding a new tool:**

Simply implement the `IReader` interface in a new file and register it in three places.

```typescript
export interface IReader {
  readonly source: AgentSource;
  isInstalled(): Promise<boolean>;
  read(options?: ReaderOptions): Promise<AgentSession[]>;
}
```

1. Create `src/readers/<toolname>.ts` and implement `IReader`.
2. Add to the `AgentSource` type (`src/readers/types.ts`).
3. Register in the reader list of `AgentHistoryService` (`src/readers/index.ts`).
4. Add to the MCP schema enum (`src/mcp/server.ts`).

Keep all source-specific logic strictly within the reader layer.

---

## License

MIT — see [LICENSE](./LICENSE). Built by [Contextberg](https://contextberg.com).
