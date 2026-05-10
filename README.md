# @contextberg/agent-history 💤

<p align="center">
  <a href="https://www.npmjs.com/package/@contextberg/agent-history"><img src="https://img.shields.io/npm/v/@contextberg/agent-history?style=for-the-badge" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://contextberg.com"><img src="https://img.shields.io/badge/Built%20by-Contextberg-blueviolet?style=for-the-badge" alt="Built by Contextberg"></a>
</p>

**Your agents dream while you commit.**

Claude Code keeps its history. Cursor keeps its own. Codex too. None of them read each other's.

`agent-history` reads all five — Claude Code, Cursor, Codex, OpenClaw, Hermes — into one searchable view. And on every `git commit`, it picks the cross-agent reasoning behind that change, distills it into a per-commit note in your repo, and serves it back over MCP.

We call this **dreaming**: autonomous, cross-session, cross-agent consolidation while you keep coding. The bridge between vibe coding and context engineering — handled for you.

> The OSS module of [**Contextberg**](https://contextberg.com), a desktop assistant for coding agents. Use it standalone, or as part of the larger app.

---

<table>
<tr><td><b>One UI, every agent</b></td><td>Claude Code, Cursor, Codex, OpenClaw, Hermes in a single searchable view. Source filter, tool-call expansion, conversation timeline.</td></tr>
<tr><td><b>Cross-agent dreaming</b></td><td>A managed <code>post-commit</code> hook scans every agent's history, picks the turns relevant to the changed files, and writes a per-commit knowledge note. Durable, version-controlled, agent-readable.</td></tr>
<tr><td><b>MCP-native replay</b></td><td>Raw history is exposed as the <code>get_agent_history</code> MCP tool. Any MCP-aware agent inherits the context — no copy-paste, no prompt scaffolding.</td></tr>
<tr><td><b>Bring your own LLM</b></td><td>Six providers out of the box: OpenAI, Anthropic, Google (Gemini), OpenRouter, Codex (ChatGPT subscription via OAuth), OpenCode Go. Switch with one command.</td></tr>
<tr><td><b>Local-first</b></td><td>Logs, summaries, and API keys live under <code>~/.agent-history/</code> (owner-only mode). Nothing leaves your machine unless you point it at a hosted LLM.</td></tr>
<tr><td><b>~50 LOC to add an agent</b></td><td>Implement one <code>IReader</code>, register it in three places, ship a PR. GitHub Copilot reader is the obvious next contribution.</td></tr>
</table>

---

## Why

Two postures dominate AI coding today.

**Vibe coding** is fast. But every session starts from zero.

**Context engineering** is powerful. But no one keeps up the manual curation.

`agent-history` closes the gap with autonomous consolidation. You keep coding. Every commit triggers a cross-agent dream cycle. The wall between "vibe" and "engineered" disappears.

---

## Quick Start

One CLI, three things to know: install, set up dreaming, launch the viewer.

### 1. Install

```bash
npm install -g @contextberg/agent-history
```

This installs the `contextberg` command (and `agent-history` as an alias — they behave identically).

> Just want to peek at the viewer without committing to an install? `npx @contextberg/agent-history` works for the viewer-only path. Dreaming requires the global install above so the `post-commit` git hook can find the binary.

### 2. Launch the viewer

```bash
contextberg
```

Picks a free port, opens your default browser, and lists every history it can find. Five readers run in parallel; tools you don't have installed silently no-op. Stop with Ctrl+C.

### 3. Turn on dreaming for a repo

From inside the target repo (any subdirectory — `contextberg setup` auto-detects the git root via `git rev-parse --show-toplevel`):

```bash
contextberg setup
```

The wizard walks you through:

1. **Provider** — OpenAI, Anthropic, Google (Gemini), OpenRouter, Codex via ChatGPT OAuth, or OpenCode Go
2. **Auth** — paste an API key, or run the device-code flow for Codex / OpenCode Go
3. **Model + token caps** — defaults are fine; override if you want
4. **`post-commit` hook** — installed into `.git/hooks/post-commit` of the current repo

### What runs after setup — no daemon to start

There is **no separate background process to launch**. Setup wires `git` itself to do the work, and the viewer / MCP are run on demand:

- **Dreaming** — the `post-commit` hook fires automatically on every `git commit`. It runs *after* the commit object is written, so the commit itself never fails because of dreaming. The terminal waits briefly for the LLM call to return; stderr is silenced and any error is swallowed (`|| true`) so a flaky provider never breaks your `git commit` workflow. The summary lands at `.contextberg/knowledge/YYYY-MM/DD/{slug}.md` and is mirrored to `~/.agent-history/knowledge/<repo>/` for cross-repo MCP retrieval.
- **Viewer** — `contextberg` (or `agent-history`) launches the browser UI on demand. See step 2 above.
- **MCP** — to expose history to another agent (Claude Desktop, etc.), add the snippet under [Using as an MCP server](#using-as-an-mcp-server) to that agent's MCP config. The MCP server is launched on demand by the client over stdio — you don't run it yourself.

### Verify it's working

```bash
contextberg status                          # config + per-repo hook status
contextberg test                            # one-shot prompt to confirm provider auth
contextberg learn --commit HEAD --verbose   # rerun against HEAD without committing
contextberg show-prompt                     # exact prompt the LLM will receive
```

A successful run prints `[contextberg] Saved → .contextberg/knowledge/...` to stderr (suppressed by the hook, visible when you run `contextberg learn` directly).

### Adding dreaming to additional repos

`npm install -g` is one-time. For each new repo, just run `contextberg setup` inside it (or `contextberg uninstall` to remove the hook).

---

## Supported tools

| Tool | Source on disk |
|------|----------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Cursor | `~/.cursor/projects/` |
| Codex | `~/.codex/sessions/` |
| OpenClaw | `~/.openclaw/agents/` |
| Hermes | `~/.hermes/state.db` |
| GitHub Copilot | 🚧 [Contributions welcome](#contributing) |

---

## CLI

One CLI for everything. `contextberg` and `agent-history` are aliases — pick whichever you like.

| Command | What it does |
|---------|--------------|
| `contextberg` | Launch the browser UI on a free port and open it (default action) |
| `contextberg --mcp` | Run as an MCP stdio server |
| `contextberg setup` | Interactive wizard: provider, model, hook install |
| `contextberg learn` | Extract knowledge from `HEAD` (or `--commit <ref>`) |
| `contextberg status` | Show current config + per-repo hook status |
| `contextberg test` | One-shot prompt to verify provider auth |
| `contextberg show-prompt` | Print the full system prompt |
| `contextberg uninstall` | Remove the `post-commit` hook from this repo |
| `contextberg --help` | Show this command list |

---

## Using as an MCP server

```json
{
  "mcpServers": {
    "contextberg": {
      "command": "npx",
      "args": ["-y", "@contextberg/agent-history", "--mcp"]
    }
  }
}
```

Defaults: `maxSessions=10`, `maxTurnsPerSession=30`, `maxCharsPerField=100000` (≈25k tokens). All three are freely configurable per call and from the web Settings panel — there is no hard ceiling, so dial them up as your downstream context window allows. The defaults are tuned for a typical 200k-token model context; lower them on smaller models, raise them on long-context ones.

---

## How `contextberg learn` works

1. `git commit` fires the managed `post-commit` hook
2. The diff and message are inspected; trivial / vendored changes are filtered out
3. Across all installed agent histories, the turns that touched the changed files are selected
4. Those turns + the diff are sent to your chosen LLM with a structured prompt (see `contextberg show-prompt`)
5. The summary is written to `.contextberg/knowledge/YYYY-MM/DD/{slug}.md` in the repo, indexed via `CHANGELOG.md`, and mirrored to `~/.agent-history/knowledge/<repo>/` for cross-repo MCP retrieval

Filter logic, transcript packing, and prompt are all open and inspectable under `src/knowledge/`.

---

## Roadmap

- [ ] GitHub Copilot reader
- [ ] Full-text search across sessions
- [ ] Cross-repo knowledge linking (problem solved in repo A → surfaced in repo B)
- [ ] Tag / favorite sessions
- [ ] Markdown export for a selected turn-set

---

## Contributing

The most welcome contribution is a new reader. Implement the `IReader` interface and register it in three places.

```typescript
export interface IReader {
  readonly source: AgentSource;
  isInstalled(): Promise<boolean>;
  read(options?: ReaderOptions): Promise<AgentSession[]>;
}
```

1. `src/readers/<toolname>.ts` — implement `IReader`
2. `src/readers/types.ts` — extend the `AgentSource` union
3. `src/readers/index.ts` — register in `AgentHistoryService`
4. `src/mcp/server.ts` — add to the schema enum

Local development:

```bash
git clone https://github.com/contextberg/agent-history
cd agent-history
npm install
# two terminals:
npm run dev:server
npm run dev:web
```

See [.claude/CLAUDE.md](.claude/CLAUDE.md) for architectural conventions.

---

## License

MIT — see [LICENSE](./LICENSE). Built by [Contextberg](https://contextberg.com).
