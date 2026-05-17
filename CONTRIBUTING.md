# Contributing to agent-history

Thank you for your interest in contributing! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Project Architecture](#project-architecture)
- [Development Workflow](#development-workflow)
- [Adding a New Reader](#adding-a-new-reader)
- [Coding Conventions](#coding-conventions)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9

### Setup

```bash
git clone https://github.com/contextberg/agent-history.git
cd agent-history
npm install
```

### Running locally

The project has two dev servers that run independently:

```bash
# Terminal 1 — API server (Fastify, port 3847)
npm run dev:server

# Terminal 2 — Web UI (Vite + React, port 5173)
npm run dev:web
```

The Vite dev server proxies `/api` requests to `localhost:3847`, so you need both running to develop the full stack.

### Useful commands

| Command | Description |
|---------|-------------|
| `npm run dev:server` | Start API server with hot reload (tsx watch) |
| `npm run dev:web` | Start Vite dev server for the web UI |
| `npm run build` | Build both web UI and server for production |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |

## Project Architecture

```
src/
├── cli.ts              # Entry point — routes to web server or MCP server
├── readers/            # Conversation history readers (one per AI tool)
│   ├── types.ts        # Shared interfaces: IReader, AgentSession, AgentTurn
│   ├── index.ts        # AgentHistoryService — aggregates all readers
│   ├── claude-code.ts  # Claude Code JSONL reader
│   ├── cursor.ts       # Cursor reader
│   ├── openclaw.ts     # OpenClaw reader
│   └── utils.ts        # Shared reader utilities
├── server/             # Fastify HTTP API
│   └── index.ts        # API routes and static file serving
├── mcp/                # MCP (Model Context Protocol) server
│   └── server.ts       # MCP tool definitions
└── web/                # React frontend (Vite)
    ├── index.html
    └── src/
```

### Key concepts

- **Reader** — A module that reads conversation files from a specific AI tool (Claude Code, Cursor, etc.) and normalizes them into `AgentSession[]`.
- **AgentHistoryService** — Aggregates all readers and provides a unified query interface.
- **Web Server** — Fastify server exposing a REST API consumed by the React frontend.
- **MCP Server** — Enables AI agents to query conversation history directly via the Model Context Protocol.

## Development Workflow

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** — keep commits focused and atomic.

3. **Verify your work:**
   ```bash
   npm run typecheck
   npm run lint
   npm run build
   ```

4. **Push** and open a Pull Request against `main`.

## Adding a New Reader

One of the easiest ways to contribute is to add support for a new AI tool. Here's how:

### 1. Create the reader file

Create `src/readers/your-tool.ts` and implement the `IReader` interface:

```typescript
import type { AgentSession, IReader, ReaderOptions } from './types.js';

export class YourToolReader implements IReader {
  readonly source = 'your-tool'; // Add to AgentSource type first

  async read(options?: ReaderOptions): Promise<AgentSession[]> {
    // 1. Locate conversation files on disk
    // 2. Parse them into AgentSession[]
    // 3. Apply options (date filter, maxSessions, etc.)
    return sessions;
  }
}
```

### 2. Add the source type

In `src/readers/types.ts`, add your tool to the `AgentSource` union:

```diff
-export type AgentSource = 'claude-code' | 'cursor' | 'openclaw';
+export type AgentSource = 'claude-code' | 'cursor' | 'openclaw' | 'your-tool';
```

### 3. Register the reader

In `src/readers/index.ts`, import and add the reader to the default list:

```diff
 import { OpenClawReader } from './openclaw.js';
+import { YourToolReader } from './your-tool.js';

 constructor(readers?: IReader[]) {
   this.readers = readers ?? [
     new ClaudeCodeReader(),
     new CursorReader(),
     new OpenClawReader(),
+    new YourToolReader(),
   ];
 }
```

### 4. Update README

Add your tool to the Supported Tools table in `README.md`.

### Tips

- Look at existing readers (e.g., `claude-code.ts`) for reference on file discovery patterns and JSONL parsing.
- Use the shared utilities in `utils.ts` where applicable.
- All readers should handle missing or corrupted files gracefully — return `[]` rather than throwing.

## Coding Conventions

### TypeScript

- **Strict mode** is enabled — no `any`, no unchecked index access.
- Use `readonly` for properties that should not be reassigned.
- Prefer `interface` over `type` for object shapes.

### Style

- Follow the existing ESLint configuration.
- Use **single quotes** for strings.
- Use **semicolons**.
- Use **2-space indentation**.

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add GitHub Copilot reader
fix: handle empty JSONL files in Claude Code reader
docs: update MCP setup instructions
```

Common prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

## Submitting Changes

### Pull Requests

- **One concern per PR** — don't mix unrelated changes.
- Write a clear description of what your PR does and why.
- Reference any related issues (e.g., `Closes #12`).
- If your PR includes UI changes, attach screenshots.
- All CI checks must pass before review.

### Review process

- A maintainer will review your PR, usually within a few days.
- Be open to feedback — we may request changes.
- Once approved, a maintainer will merge your PR.

## Reporting Issues

### Bug reports

Please include:

- **Steps to reproduce** the bug
- **Expected behavior** vs **actual behavior**
- **Environment**: OS, Node version, which AI tool you were viewing (Claude Code / Cursor / OpenClaw)
- **Error logs** if available (check the terminal running `dev:server`)

### Feature requests

Describe:

- **The problem** you're trying to solve
- **Your proposed solution** (if any)
- **Alternatives** you've considered

---

Thank you for contributing! 🎉
