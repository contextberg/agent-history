# CLAUDE.md

Product context and user-facing documentation live in `README.md`. This file covers what's useful for an agent working inside the codebase.

## Architecture

```
src/cli.ts               # entry: --mcp → MCP stdio, default → web server + open browser
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

**MCP caps protect the downstream agent.** Responses are hard-capped (`maxSessions ≤ 50`, `maxTurnsPerSession ≤ 20`, `maxCharsPerField ≤ 2000`) on top of user config. These outputs land in another agent's context window — raise caps carefully.

## Conventions

- **ESM throughout** — `"type": "module"`, imports use `.js` extensions even from `.ts` sources
- **Vite root is `src/web`** — `outDir` resolves to `dist/web` via absolute path in `vite.config.ts`; `dist/web` is what Fastify's static plugin serves
- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — array access is `T | undefined`, optional fields must be omitted not set to `undefined`
- Conventional Commits, single quotes, semicolons, 2-space indent
