---
sha: 388bc8f06f1e733271adfb20515dd576d9293ddf
subject: "fix(store): cleaner on-disk layout — day folders, HH-MM names, hidden .data/"
repo: "agent-history"
branch: "claude/npm-knowledge-setup-cUBlZ"
author: "taiks12"
authored_at: 2026-05-10T05:24:28+09:00
extracted_at: 2026-05-09T20:47:05.961Z
provider: openrouter
model: "google/gemini-3.1-flash-lite"
duration_ms: 2937
input_chars: 18001
output_chars: 1584
extraction_version: 1
files_changed:
  - "C:\\Users\\mochi\\trackq-dev\\agent-history\\.contextberg\\knowledge\\2026-05\\10\\.data\\05-08-fix-setup-allow-replacing.json"
sessions:
  - id: "3745c988-77e8-47be-af16-97eab786a6d1"
    score: 0.60
    reason: "repo match · committed during session"
---

# fix(store): cleaner on-disk layout — day folders, HH-MM names, hidden .data/

`388bc8f` · 2026-05-10 · agent-history/claude/npm-knowledge-setup-cUBlZ · openrouter/google/gemini-3.1-flash-lite · 1 session

## What was done
- Refactored `.contextberg/knowledge/` layout to use a hierarchical structure: `YYYY-MM/DD/HH-MM-{slug}.md` and a hidden `.data/` subdirectory for machine-readable JSON sidecars.
- Updated `src/knowledge/store.ts` to output files based on the commit's authored date rather than the extraction time, ensuring consistency with historical intent.
- Improved slug generation by implementing a word-boundary-aware truncation (stops at the last full word) to avoid trailing hyphenated characters.

## Where it got stuck
- **Path collisions:** Initially, the system attempted to use `{sha7}-{slug}` as a filename, but this caused issues when multiple commits shared a slug or when the authored date didn't match the extraction context. Switching to timestamp-prefixed filenames (`HH-MM`) guarantees unique paths without requiring the SHA.
- **`ls` noise:** The previous layout kept JSON and Markdown files side-by-side, which cluttered the terminal when exploring the directory. Moving JSON files to a hidden `.data/` directory solved this while keeping them accessible for the MCP `get_commit_knowledge` tool.
- **Date-keying vs. Extraction-time:** There was a debate on whether to use `authoredAt` or `extractedAt`. Using `authoredAt` proved more intuitive for users searching for "what happened on X day," even if it meant re-ordering files in already-existing directories.

## Open
- **Migration:** The current implementation does not automatically migrate the old `commits/` layout; existing entries remain in their legacy locations until manually cleared/re-extracted.
