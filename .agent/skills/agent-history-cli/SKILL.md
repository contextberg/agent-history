---
name: agent-history-cli
description: Use the @contextberg/agent-history CLI and MCP server to browse, retrieve, or summarize local AI coding-agent transcripts from Claude Code, Cursor, OpenClaw, Codex, Hermes, and GitHub Copilot. Use when a user asks to inspect agent history, find prior coding-agent conversations, launch the agent-history browser UI, configure agent-history as an MCP server, or call the get_agent_history MCP tool from an agent client.
---

# Agent History CLI

## Overview

Use `agent-history` to read local coding-agent transcripts through either a browser UI or an MCP tool. Prefer MCP for agent-to-agent retrieval and the browser UI for manual inspection and copying.

## Quick Decision

- For a user who wants to open the UI: run `npx @contextberg/agent-history` or `agent-history`.
- For an agent client that needs history in context: configure the MCP server with `npx -y @contextberg/agent-history --mcp`.
- For local repo verification: run `npm run build`, then `node dist/cli.js` or `node dist/cli.js --mcp`.
- Avoid starting the browser UI unless the user asked for it; the CLI opens a browser window automatically.

## Commands

Run without installing:

```bash
npx @contextberg/agent-history
```

Install globally:

```bash
npm install -g @contextberg/agent-history
agent-history
```

Run from this repository:

```bash
npm run build
node dist/cli.js
```

The Web UI listens on `127.0.0.1:3847` by default and falls back through the next five ports. It prints the actual URL, such as `http://localhost:3847`.

## MCP Setup

Add this server to the agent client's MCP configuration:

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

For local development, use the built CLI:

```json
{
  "mcpServers": {
    "agent-history": {
      "command": "node",
      "args": ["dist/cli.js", "--mcp"]
    }
  }
}
```

## MCP Tool

Call `get_agent_history` to retrieve sessions.

Supported arguments:

- `source`: one of `claude-code`, `cursor`, `openclaw`, `codex`, `hermes`, `copilot`.
- `date`: ISO date string such as `2026-05-06`; omit to search all history.
- `maxSessions`: capped at `50`; default is `10`.
- `maxTurnsPerSession`: capped at `20`; default is `5`.
- `maxCharsPerField`: capped at `2000`; default is `500`.
- `includeToolCalls`: include tool call names in assistant summaries; default is `true`.
- `includeToolOutputs`: include truncated tool result output; default is `false`.

Example request:

```json
{
  "source": "codex",
  "date": "2026-05-06",
  "maxSessions": 5,
  "maxTurnsPerSession": 8,
  "includeToolOutputs": false
}
```

## Configuration

User settings live at `~/.agent-history/config.json`. Preserve unknown settings and only write the fields that need to change.

```json
{
  "display": {
    "showToolCalls": true,
    "showToolOutputs": false
  },
  "mcp": {
    "includeToolCalls": true,
    "includeToolOutputs": false,
    "maxSessions": 10,
    "maxTurnsPerSession": 5,
    "maxCharsPerField": 500
  }
}
```

## Data Sources

The CLI reads local history from:

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Cursor: `~/.cursor/projects/`
- OpenClaw: `~/.openclaw/agents/`
- Codex: `~/.codex/sessions/`
- Hermes: `~/.hermes/state.db`
- GitHub Copilot: contribution history, when available through the reader

If no results appear, first check that the relevant source directory exists on the same machine and that the app has filesystem permission to read it.

## Troubleshooting

- If the browser UI fails with `Web UI not found`, build the project first with `npm run build` or use the published package through `npx`.
- If the default port is busy, read the printed `agent-history running at ...` URL; the server automatically tries later ports.
- If MCP output is too small, raise `maxSessions`, `maxTurnsPerSession`, or `maxCharsPerField` within the caps.
- Keep `includeToolOutputs` off unless the user specifically needs tool result text; it can make MCP responses large.
