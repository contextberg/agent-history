# AGENTS.md

Notes for AI coding agents (Claude Code, Codex, Cursor, Hermes, etc.) working on this repository. Product context lives in `README.md`; this file is the operational manual for an agent making changes.

The `agent-history` half (web UI + MCP for browsing prior agent sessions) and the `contextberg` half (commit-triggered knowledge extraction + per-commit notes + MCP export) live in the same package and share the readers / config layers.

## Architecture

```
src/cli.ts                       # entry: --mcp → MCP stdio, --dev → API only, default → web server + open browser
src/contextberg.ts               # entry: setup / learn / test / status / show-prompt / uninstall
src/config.ts                    # ~/.agent-history/config.json — single config file, mode 0o600

src/readers/                     # agent history sources (browse half)
  types.ts                       #   AgentSession / AgentTurn / IReader / ReaderOptions
  index.ts                       #   AgentHistoryService — Promise.allSettled fan-out, sorted desc
  {claude-code,cursor,openclaw,codex,hermes}.ts

src/server/index.ts              # Fastify: /api/sessions, /api/sessions/:id, /api/status, /api/settings
src/web/                         # Vite root (React 19 + Tailwind v4) → builds to dist/web

src/mcp/
  server.ts                      # MCP tools: get_agent_history, get_commit_knowledge
  knowledge-tool.ts              #   reads ~/.agent-history/knowledge/<repo>/commits/

src/knowledge/                   # commit-triggered learn pipeline
  index.ts                       #   runLearn — git → sessions → diff → prompt → provider → store
  store.ts                       #   per-commit md+json under YYYY-MM/DD/{slug}.md + .data/{slug}.json
  transcripts.ts                 #   buildPrompt — what the LLM actually sees (no tool traces)
  extractor.ts                   #   DEFAULT_SYSTEM_PROMPT — "What was done / Where it got stuck / Open"
  commit-filter.ts               #   skip merge / bot / lockfile-only commits before any LLM call
  link-cache.ts                  #   cache of (commit ↔ sessions) scoring
  run-log.ts                     #   ~/.agent-history/learn.log JSONL — one line per learn invocation
  providers/
    types.ts                     #   ProviderProfile, ProviderHooks, ResolvedAuth — the public shape
    registry.ts                  #   PROFILES: codex, google, anthropic, openai, openrouter, opencode-go
    index.ts                     #   resolveAuth + callProvider (anthropic_messages | openai_chat | openai_responses)

src/setup/                       # interactive wizard + ops commands
  wizard.ts                      #   provider → auth → model → storage stages
  prompts.ts                     #   readline helpers, raw-mode masked API key input
  codex-oauth.ts                 #   device-code flow → ~/.agent-history/codex-auth.json (mode 0o600)
  hooks.ts                       #   .git/hooks/post-commit installer (HOOK_MARKER guarded)
  test-call.ts                   #   contextberg test — one-shot provider ping
  show-prompt.ts                 #   contextberg show-prompt — print active system prompt
  index.ts                       #   runSetup / runStatus / runUninstall
```

## Key design rules

**Readers fail soft.** `AgentHistoryService` uses `Promise.allSettled`; readers return `[]` on missing or broken input — never throw. A broken JSONL file must not take down the other sources.

**One model, all sources.** Every reader collapses its format into `AgentSession`. UI / MCP / extractor code never branches on `source`. Per-source logic stays inside the reader.

**MCP caps protect the downstream agent.** Tool responses are hard-capped (`maxSessions ≤ 50`, `maxTurnsPerSession ≤ 20`, `maxCharsPerField ≤ 2000` for `get_agent_history`; `limit ≤ 20`, `maxCharsPerEntry ≤ 2000` for `get_commit_knowledge`). These outputs land in another agent's context window — raise caps deliberately.

**Provider profiles are declarative.** Adding a provider = one entry in `registry.ts`. Cloudflare bypass headers, SSE streaming, custom OAuth — all live behind `ProviderHooks`, not in the call site. The transports (`anthropic_messages`, `openai_chat`, `openai_responses`) read `profile.outputTokenParam` per-MODEL because the param name varies (e.g. OpenAI o-series uses `max_completion_tokens`).

**Tool execution traces are NOT in the LLM prompt.** `transcripts.ts` includes only `USER` / `ASSISTANT` / `EDITED` per turn. Tool call I/O is noise that crowds context. The MCP server follows the same policy (`includeToolCalls=false`, `includeToolOutputs=false` defaults).

**Trust boundary for credentials.** `~/.codex/auth.json` belongs to the upstream Codex CLI — `detectAuth` does NOT read it (refresh-token race + cross-app trust violation). Codex auth is acquired via our own device-code flow in `src/setup/codex-oauth.ts` and persisted to `~/.agent-history/codex-auth.json` only.

**Per-commit knowledge layout.**
```
.contextberg/knowledge/                       # local repo (gitignored by default)
  CHANGELOG.md                                #   one line per commit
  YYYY-MM/DD/{slug}.md                        #   human-readable, frontmatter + 3 sections
  YYYY-MM/DD/.data/{slug}.json                #   machine-readable sidecar, hidden subdir

~/.agent-history/knowledge/<repo>/            # global mirror — what get_commit_knowledge reads
  same shape
```
Filename is the commit-subject slug (capped ~32 chars, trims trailing 1-2 char fluff). Same-day collisions for a different SHA append `-<sha4>`; same-commit re-runs overwrite (idempotent).

## Conventions

- **ESM throughout** — `"type": "module"`. Imports use `.js` extensions even from `.ts` sources (`import { foo } from './bar.js'`).
- **Vite root is `src/web`** — `outDir` resolves to `dist/web` via absolute path in `vite.config.ts`. `dist/web` is what Fastify's static plugin serves.
- **TypeScript strict** + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — array access is `T | undefined`, optional fields must be omitted (not assigned `undefined`).
- **Conventional Commits** — `fix(scope):`, `feat(scope):`, `chore(scope):`. Single quotes, semicolons, 2-space indent.
- **No third-party project names in user-facing strings or commit subjects** when avoidable. Provider brand names (Anthropic, OpenAI, Google, Codex) are unavoidable; reference implementations we drew from are not user-facing.

## Adding things

**New agent reader** (browse / MCP):
1. `src/readers/<tool>.ts` — implement `IReader`. Return `[]` on missing source.
2. Add to `AgentSource` union in `src/readers/types.ts`.
3. Register in `AgentHistoryService` (`src/readers/index.ts`).
4. Add to the MCP enum in `src/mcp/server.ts`.

**New knowledge provider**:
1. Add a `ProviderProfile` entry to `PROFILES` in `src/knowledge/providers/registry.ts`. For OpenAI-compatible endpoints with a curated catalog, that's the entire change.
2. If the upstream needs special headers, request shape, or streaming, add a `ProviderHooks` (`buildHeaders`, `prepareRequest`, `fetchModels`, `detectAuth`, `interactiveAuth`). Keep these provider-specific.
3. The wizard / runtime auto-pick up the new entry — no other changes needed.

## Local commands

```bash
npm install
npm run typecheck            # tsc --noEmit
npm run build:server         # tsup — produces dist/cli.js, dist/contextberg.js
npm run build                # build:web + build:server

npm run dev                  # API server (3847) + Vite (5173) — opens http://localhost:5173

# After build:
node dist/contextberg.js setup
node dist/contextberg.js test
node dist/contextberg.js learn --commit HEAD --verbose
node dist/contextberg.js show-prompt
node dist/contextberg.js status
node dist/cli.js --mcp       # MCP server over stdio
```

## See also

- `README.md` — user-facing intro and install
- `CONTRIBUTING.md` — contributor onboarding details
- `SECURITY.md` — vulnerability reporting + trust model
- `.claude/CLAUDE.md` — Claude Code-specific rules (subset of this file plus Claude-Code-only conventions)
