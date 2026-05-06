/**
 * Eval script: links recent claude-code sessions in this repo to its git commits
 * and prints the top candidates per session. Run with:
 *   npx tsx scripts/probe-link.ts
 *
 * Output goes to stdout — eyeball it to judge whether the scoring weights
 * produce sensible matches before wiring linkage into the UI.
 */
import path from 'node:path';
import { ClaudeCodeReader } from '../src/readers/claude-code.js';
import { CodexReader } from '../src/readers/codex.js';
import { CursorReader } from '../src/readers/cursor.js';
import type { AgentSession } from '../src/readers/types.js';
import { findRepoRoot, readCommits } from '../src/git/reader.js';
import { linkSessionsToCommits, scoreSessionCommit, DEFAULT_LINK_THRESHOLD } from '../src/linkage/scorer.js';

async function main(): Promise<void> {
  const repo = await findRepoRoot(process.cwd());
  if (!repo) {
    console.error('Not inside a git repo');
    process.exit(1);
  }
  console.log(`# Repo: ${repo}`);

  const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const repoNorm = norm(repo);
  const inRepo = (s: AgentSession): boolean => !!s.cwd && norm(s.cwd) === repoNorm;
  const opts = { maxSessions: 50, maxTurnsPerSession: 100 };

  const [cc, codex, cursor] = await Promise.all([
    new ClaudeCodeReader().read(opts).catch(() => [] as AgentSession[]),
    new CodexReader().read(opts).catch(() => [] as AgentSession[]),
    new CursorReader().read(opts).catch(() => [] as AgentSession[]),
  ]);
  const sessions = [...cc, ...codex, ...cursor]
    .filter(inRepo)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  console.log(`# Per-source in this repo: claude-code=${cc.filter(inRepo).length} codex=${codex.filter(inRepo).length} cursor=${cursor.filter(inRepo).length}`);

  if (sessions.length === 0) {
    console.log('No sessions found for this repo.');
    return;
  }

  // Read commits over a window that covers all sessions, with 1d buffer on each side.
  const earliest = sessions.reduce(
    (min, s) => (s.startedAt < min ? s.startedAt : min),
    sessions[0]!.startedAt,
  );
  const latest = sessions.reduce(
    (max, s) => ((s.endedAt ?? s.startedAt) > max ? (s.endedAt ?? s.startedAt) : max),
    sessions[0]!.endedAt ?? sessions[0]!.startedAt,
  );
  const since = new Date(earliest.getTime() - 24 * 60 * 60 * 1000);
  const until = new Date(latest.getTime() + 24 * 60 * 60 * 1000);
  const commits = await readCommits(repo, { since, until, limit: 500 });

  console.log(`# Sessions: ${sessions.length}, commits in window: ${commits.length}`);
  console.log(`# Window: ${since.toISOString()} → ${until.toISOString()}`);
  console.log();

  for (const s of sessions) {
    const start = s.startedAt.toISOString();
    const end = (s.endedAt ?? s.startedAt).toISOString();
    const touched = new Set<string>();
    for (const t of s.turns) for (const f of t.touchedFiles ?? []) touched.add(f);
    console.log(`## [${s.source}] ${s.id.slice(0, 8)} — ${s.project}`);
    console.log(`   ${start} → ${end}`);
    console.log(`   branch=${s.gitBranch ?? '?'}  turns=${s.turns.length}  touchedFiles=${touched.size}`);

    const ranked = commits
      .map((c) => ({ commit: c, score: scoreSessionCommit(s, c) }))
      .filter((r) => r.score.total > 0)
      .sort((a, b) => b.score.total - a.score.total)
      .slice(0, 5);

    if (ranked.length === 0) {
      console.log('   (no candidates)');
      console.log();
      continue;
    }
    for (const r of ranked) {
      const mark = r.score.total >= DEFAULT_LINK_THRESHOLD ? '✓' : '·';
      const p = r.score.parts;
      console.log(
        `   ${mark} ${r.score.total.toFixed(2)}  ${r.commit.sha.slice(0, 8)} ` +
        `(repo=${p.repo.toFixed(1)} time=${p.time.toFixed(2)} files=${p.files.toFixed(2)} branch=${p.branch.toFixed(1)})  ` +
        `${r.commit.subject.slice(0, 60)}`,
      );
    }
    console.log();
  }

  const links = linkSessionsToCommits(sessions, commits);
  const byCommit = new Map<string, number>();
  for (const l of links) byCommit.set(l.commit.sha, (byCommit.get(l.commit.sha) ?? 0) + 1);
  console.log(`# Total links above threshold (${DEFAULT_LINK_THRESHOLD}): ${links.length}`);
  console.log(`# Commits with >= 1 linked session: ${byCommit.size}`);
  const multi = [...byCommit.entries()].filter(([, n]) => n > 1);
  console.log(`# Commits linked to multiple sessions: ${multi.length}`);
  for (const [sha, n] of multi.slice(0, 10)) {
    const c = commits.find((x) => x.sha === sha);
    console.log(`   ${sha.slice(0, 8)} × ${n}  ${c?.subject.slice(0, 60) ?? ''}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
