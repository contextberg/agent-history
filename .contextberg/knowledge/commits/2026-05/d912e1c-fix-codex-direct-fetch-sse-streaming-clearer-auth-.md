---
sha: d912e1cd315ec68c17fcd19f874882446a016168
subject: "fix(codex): direct fetch + SSE streaming + clearer auth hints"
repo: "agent-history"
branch: "claude/npm-knowledge-setup-cUBlZ"
author: "taiks12"
authored_at: 2026-05-10T02:06:21+09:00
extracted_at: 2026-05-09T17:09:16.374Z
provider: codex
model: "gpt-5.5"
duration_ms: 13148
input_chars: 18001
output_chars: 1601
extraction_version: 1
files_changed:
  - "C:\\Users\\mochi\\trackq-dev\\agent-history\\src\\knowledge\\index.ts"
sessions:
  - id: "3745c988-77e8-47be-af16-97eab786a6d1"
    score: 0.95
    reason: "repo match · committed during session · 100% file overlap"
---

# fix(codex): direct fetch + SSE streaming + clearer auth hints

`d912e1c` · 2026-05-10 · agent-history/claude/npm-knowledge-setup-cUBlZ · codex/gpt-5.5 · 1 session

## What was done
- Replaced the Codex SDK call in `src/knowledge/providers/index.ts` with direct `fetch` to `chatgpt.com/backend-api/codex`, using `stream: true`, `Accept: text/event-stream`, first-party headers, and `input: [{ role: "user", content: "..." }]`.
- Added SSE parsing for `response.output_text.delta`, with `response.completed` as fallback, and richer error output including status, `cf-mitigated`, request id, and response body.
- Added clearer missing-auth guidance via `src/setup/auth-help.ts`, used by both `contextberg test` and `contextberg learn`.

## Where it got stuck
- OpenAI Node SDK was a dead end for Codex: the backend rejects non-first-party `User-Agent` / `originator`, and SDK-injected `User-Agent` could not be reliably overridden with `defaultHeaders`.
- Non-streamed Codex POSTs fail with `400 {"detail":"Stream must be set to true"}`; even one-shot calls must use SSE.
- Codex rejected bare-string `input`; it must be a message list like `[{ role: "user", content: "..." }]`.
- Codex rejected `max_output_tokens` and `temperature`, so those fields must not be sent.
- Missing auth previously produced a terse one-line error; this was judged insufficient because users need provider-specific next steps (`api_key` vs `oauth_disk`, `signupUrl`, `codex login`).

## Open
- Google CLI / Gemini OAuth was deferred: Hermes shows it needs a large Cloud Code Assist-specific adapter, so v1 should stick to Gemini API key.
- SQLite was scoped only for a future independent cross-session search feature; commit-triggered summaries can continue with JSON/cache-based indexing.
