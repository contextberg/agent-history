# Test plan — `feat/viewer-commit-watcher`

End-to-end verification for the viewer-internal commit watcher and the
`CommitView` knowledge panel. Roughly 15 minutes.

## Pre-flight (2 min)

```bash
cd C:/Users/mochi/trackq-dev/agent-history
git status                   # confirm we're on feat/viewer-commit-watcher
npm run build                # expect: ✓ Build success
```

Optional safety net (this branch will rewrite `~/.agent-history/config.json`):

```bash
cp ~/.agent-history/config.json ~/.agent-history/config.json.bak
```

---

## Phase 1 — Smoke (3 min)

### 1-1. MCP is read-only (2 tools, no `extract_commit_knowledge`)

```bash
node -e "
const {spawn}=require('child_process');
const p=spawn('node',['dist/contextberg.js','--mcp'],{stdio:['pipe','pipe','inherit']});
const send=m=>p.stdin.write(JSON.stringify(m)+'\n');
p.stdout.on('data',c=>{for(const l of (c+'').split('\n'))if(l.trim()){try{const r=JSON.parse(l);if(r.id===1){console.log(JSON.stringify((r.result.tools||[]).map(t=>t.name)));p.kill();process.exit(0)}}catch{}}});
send({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'s',version:'0'}}});
setTimeout(()=>send({jsonrpc:'2.0',method:'notifications/initialized',params:{}}),200);
setTimeout(()=>send({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}),400);
"
```

**Pass**: output is exactly `["get_agent_history","get_commit_knowledge"]`.

### 1-2. `status` uses the new format

```bash
node dist/contextberg.js status
```

**Pass**: output contains a `Watched : ...` line (not `Hook : ...`). Zero watched repos is fine here.

---

## Phase 2 — Setup → register → auto-learn end-to-end (5–10 min)

### 2-1. Run setup inside a target repo

`agent-history` itself is fine for testing.

```bash
cd C:/Users/mochi/trackq-dev/agent-history
node dist/contextberg.js setup
```

- Provider / model / API key prompts: just press Enter to keep existing values.
- Final lines should include `Watching: C:\Users\...\agent-history`.
- If a legacy post-commit hook was installed, expect `Legacy post-commit hook removed` too.

**Pass**: `node dist/contextberg.js status` now shows `Watched : 1 repo(s)` with the repo listed.

### 2-2. Launch the viewer

In a separate terminal:

```bash
node dist/contextberg.js
```

**Pass**: browser opens, UI renders, no errors in the server console.

### 2-3. Confirm the SSE feed is live

In yet another terminal:

```bash
curl -N http://localhost:3847/api/events
```

**Pass**: an `event: started` arrives immediately, with the watched-repos array containing the registered repo. Subsequent traffic is just keepalive comments until something happens.

### 2-4. Make a real commit and observe the watcher fire

Viewer stays running. In a fourth terminal:

```bash
echo "// test $(date +%s)" >> README.md
git add README.md
git commit -m "test: trigger watcher"
```

**Pass — observe all of these together**:

- `git commit` returns **immediately** (no LLM-call stall — that was the headline pain point of the old hook model).
- The `curl /api/events` window receives `event: commit-detected`, then `event: learn-started`, then several seconds to ~30 seconds later `event: learn-completed`.
- `tail -1 ~/.agent-history/learn.log` shows a new line — `"status":"ok"` or `"status":"no-sessions"` are both expected outcomes.
- On `"ok"`: `.contextberg/knowledge/2026-05/11/<slug>.md` exists with a knowledge note inside.

### 2-5. View the knowledge note in the UI

In the viewer sidebar, switch the bottom-left segment to **By commit** and click the just-made `test: trigger watcher` row.

**Pass A — sessions linked, `status:"ok"`**:

- A `Knowledge` section appears above `Linked sessions`.
- The body shows `## What was done`, `## Where it got stuck`, optionally `## Open`.
- Header line: provider / model / extracted timestamp / session count.

**Pass B — `status:"no-sessions"`**:

- The `Knowledge` section shows the empty hint `No knowledge note yet. ... contextberg learn --commit ...`.

> If you got Pass B and want Pass A: there were no agent histories whose `touchedFiles` overlapped this commit. Either do a small piece of agent-driven work in this repo before committing, or use 2-6 to manually learn against an older SHA that has overlap.

### 2-6. Live UI refresh via SSE (optional)

Keep the same commit selected in the viewer. In a separate terminal:

```bash
node dist/contextberg.js learn --commit HEAD --verbose
```

**Pass**: when the run completes, the `Knowledge` section in the UI updates **without** a manual reload (the SSE listener catches `learn-completed` for this SHA and refetches).

---

## Phase 3 — Teardown paths (2 min)

### 3-1. Uninstall

Stop the viewer (Ctrl+C in the server window), then:

```bash
cd C:/Users/mochi/trackq-dev/agent-history
node dist/contextberg.js uninstall
```

**Pass**: prints `Stopped watching ...`. If a legacy hook was still around, also prints `Legacy post-commit hook removed.`

```bash
node dist/contextberg.js status
```

**Pass**: `Watched : (none — ...)`.

### 3-2. Clean restart confirms empty state

```bash
node dist/contextberg.js
```

**Pass**: viewer launches; the `started` SSE event has `repos: []`.

---

## Notes

- Phase 2-4's "git commit returns immediately" is the single biggest behavioral
  diff vs. the old git-hook world. If you still see a multi-second pause on
  `git commit`, the old `.git/hooks/post-commit` is probably still firing —
  inspect it with `cat .git/hooks/post-commit` and remove any
  `# contextberg-managed` lines (or re-run `contextberg setup` to let it
  scrub them).
- Keeping `curl /api/events` open in a side window throughout testing makes
  every watcher state transition visible. `commit-detected` arriving without a
  later `learn-started` would point at a hang inside `runLearn`; the run-log
  at `~/.agent-history/learn.log` records the matching status entry.
- For an instant visual check of the `Knowledge` section that bypasses the
  whole watcher path, open any older commit that already has an entry under
  `~/.agent-history/knowledge/<repoName>/...` — the panel renders directly
  from disk.
