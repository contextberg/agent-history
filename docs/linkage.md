# Commit linkage logic

How the **By commit** view decides which agent sessions belong to which git
commit. This file documents the rules so a future change to the readers,
scorer, or aggregator can be made with intent rather than by guessing.

## What the view answers

Per commit, show the sessions that plausibly contributed to it — across all
agents (claude-code, codex, cursor, openclaw, hermes, copilot). A commit is
typically the work of **multiple sessions**; a long session can cover
**multiple commits**. The view is N-to-N, not 1-to-1.

We never store these links — they are recomputed every request from
session JSONL/SQLite + `git log`. This means: no migration, no cache
invalidation, no DB. The cost is one round-trip of `git rev-parse` and
`git log` per repo per request.

## Two-stage pipeline

```
sessions ──┐
           ├──► discovery ──► candidates per repo ──► scoring ──► links per commit
git log ───┘
```

### Stage 1 — Discovery (`src/server/commits.ts`)

Decide which sessions are "in" which repo. Three channels, additive:

1. **`session.cwd` is inside the repo.** Most common path — claude-code,
   codex, openclaw, and (when resolvable) cursor all record cwd. The
   aggregator walks every distinct cwd, runs `git rev-parse --show-toplevel`
   to find the repo root, and caches the result.

2. **An *absolute* file in `session.turns[].touchedFiles` is inside the
   repo.** Catches openclaw-style sessions that run from one workspace
   (e.g. `~/.openclaw/workspace`) but write to absolute paths in another
   repo. *Relative* touchedFiles are deliberately excluded — `path.resolve`
   would silently bind them to the *server's* cwd and create phantom
   matches (notably for hermes, whose `write_file` paths are always relative).

3. **`session.referencedCommits` matches a SHA in the repo.** For sources
   that don't record cwd (hermes), we mine `git log` output captured in
   tool results for SHAs and use those as a "I was working in this repo"
   signal. Built from the union of fetched commits across all repos.

The aggregator collects all repo roots discovered via 1 + 2, fetches the
last 300 commits from each (windowed to `since = earliest related session
- 1 day`), then computes channel 3 from the resulting SHAs.

### Stage 2 — Scoring (`src/linkage/scorer.ts`)

Each (session, commit) candidate is scored on four dimensions, each in `[0, 1]`:

| Dimension | Weight | What it measures |
|---|---|---|
| `repo`     | 0.25 | Session belongs to commit's repo (binary) |
| `time`     | 0.35 | Commit time relative to session's *edit-active* window |
| `files`    | 0.35 | Asymmetric: fraction of commit's changed files that the session edited |
| `branch`   | 0.05 | Session's recorded gitBranch matches the commit's (rarely populated) |

Total = weighted sum, **but if `repo === 0` we short-circuit to 0** — a
session that wasn't in this repo cannot have contributed.

#### `repo`

1 if the aggregator's `repoMatched` hint is set (channel 1, 2, or 3 from
discovery). Otherwise re-checks cwd / absolute touchedFiles directly.
Channel 3 (referencedCommits) is the reason the scorer accepts a hint
from the aggregator: without it, a hermes session that referenced SHA X
in repo R would get repo=0 for every commit in R *other than* SHA X.

#### `time`

Peaks at 1 when the commit happens during or shortly after the session's
**edit-active window**:

- The window is the min/max of `turn.startedAt`/`turn.endedAt` across
  turns whose `touchedFiles` is non-empty. This narrows from "session
  open for 10 hours" to "agent edited files between 14:02 and 14:18".
- Falls back to the full session window when no edit-bearing turn has
  per-turn timestamps (hermes top-level only, cursor user bubbles).
- Decay is asymmetric: post-window over 6h (developer commits after
  work finishes); pre-window over 1h with heavy damping ×0.3 (commits
  *before* edits cannot have been caused by them).

#### `files`

Asymmetric Jaccard: `|commit.files ∩ session.touchedFiles| / |commit.files|`.
Reads "what fraction of the commit's changes did the session edit?",
which is what we actually want — sessions naturally explore many files
(reads), but commits only record edits.

Tools that count as edits per source:

| Source | Tools |
|---|---|
| claude-code | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` (Read excluded) |
| codex       | `apply_patch` markers in shell commands; structured `path`/`file_path` keys |
| openclaw    | `write`, `edit` |
| cursor      | `diffsSinceLastApply[].relativeWorkspacePath` (lives on the *next* user bubble) |
| hermes      | `write_file`, `edit_file` (relative — does not contribute to file score) |

#### `branch`

1 when both sides record the same git branch. Currently only claude-code
populates `session.gitBranch`; for everyone else this dimension is 0.

### Special-case override: referenced authoring

If `session.referencedCommits` includes the commit's SHA AND the commit
happened *after* the session started, the total is **floored at 0.85**.
This catches the case where an agent ran a `git log` that included a
SHA *it just produced*.

If the commit *predates* the session, the SHA reference is just the agent
reading prior history (e.g. `git log -n 5` for context). The 0.85 floor
**does not apply** — the link is whatever the normal time/file dimensions
say, which will typically be near zero for past commits.

This is what fixes hermes: a session that ran `git log -2` to read
recent history would otherwise pin to those past commits at 0.85
("authored them"), which is wrong.

## Filtering

- **Threshold**: links with total < 0.45 (`DEFAULT_LINK_THRESHOLD`) are
  dropped. Below 0.45 typically means "same repo, unrelated time / no
  file overlap" — pure noise.
- **Empty commits**: a commit with zero links above threshold is dropped
  from the result entirely; it would just be an empty row.
- **Source filter (client-side)**: when the user selects a single source
  in the sidebar, the client narrows commits to those with at least one
  link of that source AND narrows each commit's links to that source
  only. Strong/weak counts in the badge and CommitView reflect the
  filtered set.

## UI tiering (`CommitView`)

Within a commit:

- **Strong matches**: links with score ≥ 0.7. Shown first, accent-colored.
- **Weaker candidates**: links 0.45 ≤ score < 0.7. Shown below, muted.
- A link to a session not currently loaded in the sidebar is shown but
  disabled (no transcript drill-down — the session list is bounded by
  `maxSessions` per source).

## Known limitations by source

| Source | cwd | per-turn ts | edit paths | Notes |
|---|---|---|---|---|
| claude-code | always (per-line) | yes | absolute | Strongest, full coverage |
| codex       | once at session_meta | yes | relative or absolute | Edits via `apply_patch` heredoc; other shell-based edits (e.g. `python script.py`) leak |
| openclaw    | once at session start | yes | resolved against cwd | Cross-repo writes work via channel 2 |
| cursor      | from per-workspace `state.vscdb` (~55% coverage on older composers) | only assistant bubbles | relative to workspace | Older composers lack workspace mapping; gitBranch unrecorded |
| hermes      | **none** | none (top-level only) | relative only | Repo attribution depends on channel 3 (referencedCommits via SHAs in `git log` output). No `files` signal — relative paths are deliberately excluded from repo matching |
| copilot     | (TODO — not yet wired through) | — | — | Workspace.json folder URI is the natural cwd, parallel to cursor |

## Cost notes

- `findRepoRoot` is the dominant cost (one git spawn per distinct
  candidate path). The aggregator dedupes paths and short-circuits when a
  path falls inside an already-resolved repo root, in 16-wide concurrent
  batches.
- `readCommits` is one git spawn per repo. With ~10 active repos and
  ~50 sessions/source, total wall time is well under 200ms in practice.
- No persistence layer. If aggregation cost becomes an issue, the
  natural place to cache is `(sessionId, commitSha) → score` — see the
  earlier discussion of `link_override` / `link_cache` tables.
