## What does this PR do?

<!-- Describe the change clearly. What problem does it solve? Why is this approach the right one? -->



## Related Issue

<!-- Link the issue this PR addresses. If no issue exists for a feature change, consider opening one first. -->

Fixes #

## Type of Change

<!-- Check the one that applies. -->

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] 🔌 New agent reader (Claude Code / Cursor / Codex / etc.)
- [ ] 🧠 New knowledge provider (Anthropic / OpenAI / Gemini / OpenRouter / Codex / OpenCode Go / …)
- [ ] 🔒 Security fix
- [ ] 📝 Documentation
- [ ] ♻️ Refactor (no behavior change)

## How to Test

<!-- Steps to verify this change. Include the exact commands you ran. -->

```bash
npm install
npm run typecheck
npm run build:server
node dist/contextberg.js …
```

## Checklist

- [ ] My commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(scope):`, `feat(scope):`, `chore(scope):`, …)
- [ ] `npm run typecheck` passes
- [ ] `npm run build:server` passes (or `npm run build` if web changed)
- [ ] My PR contains **only** changes related to this fix/feature (no unrelated commits)
- [ ] I've tested on my OS (Windows / macOS / Linux): <!-- which? -->

### Documentation & Housekeeping (check what applies, mark N/A otherwise)

- [ ] Updated `README.md` if a user-facing flag, command, or supported tool changed — or N/A
- [ ] Updated `AGENTS.md` if architecture, file layout, or provider transport rules changed — or N/A
- [ ] Updated `.claude/CLAUDE.md` if Claude-Code-specific guidance needs to change — or N/A

### Adding a new agent reader (skip otherwise)

- [ ] Implements `IReader` in `src/readers/<tool>.ts`
- [ ] Added to `AgentSource` in `src/readers/types.ts`
- [ ] Registered in `AgentHistoryService` (`src/readers/index.ts`)
- [ ] Added to the MCP enum in `src/mcp/server.ts`
- [ ] Reader returns `[]` (does not throw) when the source is missing or broken

### Adding a new knowledge provider (skip otherwise)

- [ ] Profile entry added to `PROFILES` in `src/knowledge/providers/registry.ts`
- [ ] `fallbackModels` covers what the wizard should show when live fetch fails
- [ ] If the provider has a non-trivial transport (Cloudflare bypass, SSE, custom auth header), it lives behind a `ProviderHooks` hook, not in the call site

## Screenshots / Logs

<!-- Optional. Useful for UI changes or surprising behavior. -->
