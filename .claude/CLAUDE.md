# CLAUDE.md

Product context and user-facing documentation live in `README.md`. This file covers what's useful for an agent working inside the codebase.

## Architecture

```
src/contextberg.ts       # SOLE CLI entry — bare → web server, --mcp → MCP stdio, --dev → API only,
                         # subcommands: setup / learn / status / test / show-prompt / uninstall
src/cli.ts               # `agent-history` bin alias — `import './contextberg.js'` only, no logic
src/config.ts            # ~/.agent-history/config.json — persisted defaults
src/readers/
  types.ts               # AgentSession / AgentTurn / IReader / ReaderOptions
  index.ts               # AgentHistoryService — Promise.allSettled fan-out, sorted desc
  {claude-code,cursor,openclaw,codex,hermes}.ts
src/server/index.ts      # Fastify: /api/sessions, /api/sessions/:id, /api/status, /api/settings
src/mcp/server.ts        # MCP tool: get_agent_history (stdio)
src/web/                 # Vite root (React 19 + Tailwind v4) → builds to dist/web
```

## Key design rules

**Readers fail soft.** `AgentHistoryService` uses `Promise.allSettled`; readers return `[]` on missing or broken input — never throw. A broken JSONL file must not take down the other sources.

**One model, all sources.** Every reader collapses its format into `AgentSession`. UI and MCP code never branch on `source`. If you need per-source logic above the reader layer, push it down into the reader.

**MCP defaults, no hard caps.** `maxSessions` (10), `maxTurnsPerSession` (30), `maxCharsPerField` (100_000) are defaults only. The user-supplied value is the upper bound — there are no remaining ceilings on the MCP request schema or in the response clamping. The output lands in another agent's context window, so when raising defaults, do it deliberately.

## Conventions

- **ESM throughout** — `"type": "module"`, imports use `.js` extensions even from `.ts` sources
- **Vite root is `src/web`** — `outDir` resolves to `dist/web` via absolute path in `vite.config.ts`; `dist/web` is what Fastify's static plugin serves
- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — array access is `T | undefined`, optional fields must be omitted not set to `undefined`
- Conventional Commits, single quotes, semicolons, 2-space indent
