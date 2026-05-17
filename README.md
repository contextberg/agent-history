# @contextberg/agent-history

Local-first memory for AI coding agents.

`agent-history` reads local conversation history from Claude Code, Cursor,
Codex, OpenClaw, Hermes, and GitHub Copilot, then links those sessions to git
commits. It can also extract a short per-commit knowledge note so the next
agent can recover why a change happened without asking you to repeat the story.

The package installs two equivalent commands:

- `contextberg`
- `agent-history`

## What It Does

| Feature | Description |
| --- | --- |
| Unified history viewer | Browse local sessions from multiple coding agents in one web UI. |
| Commit linking | Group likely related sessions under recent git commits using repo, time, SHA references, and touched-file overlap. |
| Commit knowledge | Run `contextberg learn` or keep the viewer open to produce per-commit notes under `.contextberg/knowledge/`. |
| MCP handoff | Expose bounded history and learned commit notes through MCP tools for another agent. |
| Local-first storage | Config and generated notes live under `~/.agent-history/` and the target repo. |

## Install

```bash
npm install -g @contextberg/agent-history
```

You can also launch the viewer once with:

```bash
npx @contextberg/agent-history
```

## Quick Start

Launch the viewer:

```bash
contextberg
```

Set up commit knowledge for a repo:

```bash
cd /path/to/your/repo
contextberg setup
```

The setup wizard configures:

1. Provider and model
2. Authentication
3. Prompt/output limits
4. The current repo as a watched repo

While the viewer is running, watched repos are monitored for new commits and
knowledge extraction runs in the background. You can always backfill manually:

```bash
contextberg learn --commit HEAD --verbose
```

## Commands

| Command | Description |
| --- | --- |
| `contextberg` | Launch the web viewer and open a browser. |
| `contextberg --dev` | Run the API server only, for local development. |
| `contextberg --mcp` | Run the MCP stdio server. |
| `contextberg setup` | Configure provider/model/auth and register the current repo. |
| `contextberg learn --commit HEAD` | Extract knowledge for a commit. |
| `contextberg status` | Show config, watched repos, auth status, and recent learn runs. |
| `contextberg test` | Verify provider authentication with a small prompt. |
| `contextberg show-prompt` | Print the active extraction prompt. |
| `contextberg uninstall` | Stop watching the current repo and remove legacy hooks if present. |

## Supported History Sources

| Tool | Reader |
| --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Cursor | Cursor workspace storage |
| Codex | `~/.codex/sessions/` |
| OpenClaw | `~/.openclaw/agents/` |
| Hermes | `~/.hermes/state.db` and legacy session JSON |
| GitHub Copilot | local Copilot chat storage |

Readers fail soft: missing tools or malformed history files return no sessions
instead of taking down the viewer.

## MCP

Add the built package to any MCP client as a stdio server:

```json
{
  "mcpServers": {
    "agent-history": {
      "command": "contextberg",
      "args": ["--mcp"]
    }
  }
}
```

Available tools:

- `get_agent_history`: returns bounded prior sessions and turns.
- `get_commit_knowledge`: returns learned per-commit notes.

Tool outputs are capped by default so they can safely fit into another agent's
context window. Caps are configurable in the web settings and MCP arguments.

## Knowledge Storage

Per-commit notes are written to:

```text
.contextberg/knowledge/
  CHANGELOG.md
  YYYY-MM/DD/{slug}.md
  YYYY-MM/DD/.data/{slug}.json
```

A global mirror is also written under:

```text
~/.agent-history/knowledge/<repo>/
```

The repo-local `.contextberg/` directory is ignored by default in this repo, but
you can choose whether to commit generated notes in your own projects.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run dev
```

The web app is a Vite React app under `src/web`. The server and CLI build with
`tsup`.

## Security

This tool reads local agent history and may send selected transcript excerpts to
the provider you configure for knowledge extraction. API keys are stored in
`~/.agent-history/config.json`; Codex OAuth tokens are stored in
`~/.agent-history/codex-auth.json`.

See [SECURITY.md](./SECURITY.md) for the trust model and reporting process.

## License

MIT. See [LICENSE](./LICENSE).
