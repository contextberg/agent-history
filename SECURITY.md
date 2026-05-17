# Security Policy

`@contextberg/agent-history` is a local CLI / MCP server for browsing AI agent history files written on disk. This document explains how to report vulnerabilities and what we do — and do not — consider in scope.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security reports.

Use **[GitHub Security Advisories](https://github.com/contextberg/agent-history/security/advisories/new)** to file a private report. We monitor advisories and will acknowledge new submissions within 5 business days.

Useful details to include:
- **Affected component**: file path + line range (e.g. `src/knowledge/store.ts:200-240`).
- **Version**: output of `agent-history --version` or the commit SHA you tested against.
- **Environment**: OS + Node.js version (`node -v`).
- **Reproduction**: minimal step-by-step PoC. The smaller the repro, the faster the fix.
- **Impact**: what trust boundary was crossed.

We do not operate a paid bug bounty.

## Trust Model

This tool runs entirely on the operator's local machine.

- **Single-user model.** It protects the operator from broken or malicious agent history files, not from malicious co-tenants on the same host. Multi-user isolation is the OS's job.
- **Network behaviour.** The CLI only talks to the model providers configured by the user (Anthropic, OpenAI, Google, OpenRouter, Codex, OpenCode Go) at constant URLs hard-coded in `src/knowledge/providers/registry.ts`. There is no telemetry endpoint; nothing else is contacted.
- **Credentials on disk.** API keys live in `~/.agent-history/config.json` (mode `0o600` on Unix) and Codex OAuth tokens in `~/.agent-history/codex-auth.json` (mode `0o600`). Anyone with read access to those files has the keys — protect your home directory.
- **MCP.** When run via `--mcp`, the calling agent can pull session content and per-commit knowledge entries (capped per `mcp.maxSessions` / `maxTurnsPerSession` / `maxCharsPerField` in config). Treat the MCP caller as trusted: it runs with your local file-system access.

## Out of Scope

- **Prompt injection** in agent history content unless it leads to a concrete bypass of the trust boundaries above (e.g. an exec call with attacker-controlled arguments).
- **API key disclosure** to the user-configured model provider over the documented endpoint (e.g. Gemini's `?key=` URL parameter is the upstream API's documented auth scheme).
- **Reports requiring pre-existing write access** to `~/.agent-history/`, the user's repo, or the user's shell environment.
- **Lack of hardening** features (no audit log, no keychain backend, no container sandbox) — these are roadmap items, not vulnerabilities.

## Disclosure

We aim for a 90-day coordinated disclosure window or until a fix ships, whichever is sooner. Reporters are credited in release notes by default; let us know in the advisory if you'd prefer to remain anonymous.
