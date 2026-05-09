---
sha: dba4ffdebae260ee6d0405b422366d193284b5ce
subject: "fix(setup): allow replacing a stored API key / re-running OAuth sign-in"
repo: "agent-history"
branch: "claude/npm-knowledge-setup-cUBlZ"
author: "taiks12"
authored_at: 2026-05-10T05:08:11+09:00
extracted_at: 2026-05-09T20:24:15.110Z
provider: openrouter
model: "google/gemini-3.1-flash-lite"
duration_ms: 1993
input_chars: 18001
output_chars: 1025
extraction_version: 1
files_changed:
  - "C:\\Users\\mochi\\trackq-dev\\agent-history\\src\\setup\\wizard.ts"
sessions:
  - id: "3745c988-77e8-47be-af16-97eab786a6d1"
    score: 0.95
    reason: "repo match · committed during session · 100% file overlap"
---

# fix(setup): allow replacing a stored API key / re-running OAuth sign-in

`dba4ffd` · 2026-05-10 · agent-history/claude/npm-knowledge-setup-cUBlZ · openrouter/google/gemini-3.1-flash-lite · 1 session

## What was done
- Refactored `src/setup/wizard.ts` to allow users to overwrite existing credentials during the interactive setup flow.
- Added a "Replace?" prompt for `api_key` providers after displaying the last 4 characters of the stored key.
- Added a "Re-run sign-in?" prompt for `oauth_disk` providers (specifically Codex) when an interactive auth hook is available, enabling users to refresh expired sessions without manual file deletion.

## Where it got stuck
- Hit a flow ambiguity: When the user chooses to "Replace" an OAuth token, the logic initially fell back to the standard `detected.resolve()` if the `interactiveAuth()` hook failed or returned empty; ensuring this fallback didn't silently re-use the *old* bad token required explicit handling of the error state.
- Deciding on UX: Initially considered auto-detecting expiration via status codes, but opted for an explicit manual trigger ("Re-run sign-in?") to avoid unnecessary network calls and simplify the wizard's dependency on provider-specific state.
