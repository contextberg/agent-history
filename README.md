# @contextberg/agent-history

Browse, search, and reuse your AI coding agent conversations — locally, in your browser.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![npm](https://img.shields.io/npm/v/@contextberg/agent-history)

## What is this?

When you work with AI coding agents (Claude Code, Cursor, OpenClaw, etc.), every conversation is saved as local JSONL files. These files are hard to read and even harder to reuse.

`@contextberg/agent-history` gives you a local web UI to browse all your agent conversations in one place — and copy them in formats ready to paste into any AI tool.

## Features

- **Unified view** — Claude Code, Cursor, OpenClaw conversations in one UI
- **Chat-style display** — read sessions the way they happened
- **Copy for reuse** — copy as Markdown, raw JSON, or a ready-to-continue prompt
- **MCP support** — use as an MCP server to feed context directly into agents
- **100% local** — reads files on your machine, no data sent anywhere

## Quick Start

```bash
npx @contextberg/agent-history
```

Opens `http://localhost:3847` in your browser automatically.

## MCP Setup

Add to your MCP config (e.g. `claude_desktop_config.json`):

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

## Supported Tools

| Tool | Status |
|------|--------|
| Claude Code | ✅ |
| Cursor | ✅ |
| OpenClaw | ✅ |
| GitHub Copilot | 🚧 Contributions welcome |

## Powered by Contextberg

This tool is built and maintained by [Contextberg](https://contextberg.com) — an app that automatically builds long-term memory from your AI agent activity.
