import path from 'node:path';
import type { AgentSession } from '../readers/types.js';
import type { GitCommit } from '../git/reader.js';

export interface LinkageScore {
  total: number;
  /** Sub-scores for inspection / tuning. Each in [0, 1]. */
  parts: {
    repo: number;     // does the session's cwd live inside the commit's repo?
    time: number;     // commit time relative to session window
    files: number;    // Jaccard between session.touchedFiles and commit.files
    branch: number;   // session.gitBranch matches a heuristic commit branch
  };
  /** Reason text for UI surfacing. */
  reason: string;
}

export interface SessionCommitLink {
  session: AgentSession;
  commit: GitCommit;
  score: LinkageScore;
}

const WEIGHTS = { repo: 0.25, time: 0.35, files: 0.35, branch: 0.05 };
/** Default cutoff for "this session likely contributed to this commit". */
export const DEFAULT_LINK_THRESHOLD = 0.45;

export interface ScoreOptions {
  /**
   * Aggregator-level hint: this session is known to be related to the commit's
   * repo (e.g. via referencedCommits → sha→repo mapping) even though its
   * cwd/touchedFiles don't prove it. Without this, hermes-style sessions —
   * which have no cwd and only relative write paths — get repo=0 and never
   * link to *any* commit, even commits in repos they clearly worked in.
   */
  repoMatched?: boolean;
}

/**
 * Score a (session, commit) pair. The total is a weighted sum of sub-scores,
 * but if `repo` is 0 we short-circuit — a session that didn't run inside the
 * commit's repo cannot have contributed to it.
 *
 * Two adjustments handle SHA references:
 *   - If the session referenced this commit's SHA AND the commit happened
 *     after the session started, treat it as authoring evidence — floor to
 *     0.85. (Most often: agent ran a `git log` that *included* the SHA it
 *     just produced.)
 *   - If the commit *predates* the session's start, the SHA reference is
 *     just the agent reading prior history (e.g. `git log -n 5` for context).
 *     We don't apply the 0.85 floor — the link should rise or fall on the
 *     normal time/file dimensions, which will be weak for past commits.
 */
export function scoreSessionCommit(
  session: AgentSession,
  commit: GitCommit,
  opts?: ScoreOptions,
): LinkageScore {
  const parts = {
    repo: opts?.repoMatched ? 1 : scoreRepo(session, commit),
    time: scoreTime(session, commit),
    files: scoreFiles(session, commit),
    branch: scoreBranch(session, commit),
  };

  const sha = commit.sha.toLowerCase();
  const rawReferenced = (session.referencedCommits ?? []).some(
    (r) => sha === r.toLowerCase() || sha.startsWith(r.toLowerCase()),
  );
  const commitPredatesSession = commit.time.getTime() < session.startedAt.getTime();
  const authoringReference = rawReferenced && !commitPredatesSession;

  let total = parts.repo === 0
    ? 0
    : parts.repo * WEIGHTS.repo
      + parts.time * WEIGHTS.time
      + parts.files * WEIGHTS.files
      + parts.branch * WEIGHTS.branch;

  if (authoringReference) {
    total = Math.max(total, 0.85);
    parts.repo = 1;
  }

  return { total, parts, reason: buildReason(parts, authoringReference) };
}

/**
 * For each session, return its candidate commits ranked by score, filtered by
 * threshold. The same commit may appear under multiple sessions — that's the
 * whole point ("a commit is composed of multiple sessions").
 */
export function linkSessionsToCommits(
  sessions: AgentSession[],
  commits: GitCommit[],
  threshold = DEFAULT_LINK_THRESHOLD,
): SessionCommitLink[] {
  const links: SessionCommitLink[] = [];
  for (const session of sessions) {
    for (const commit of commits) {
      const score = scoreSessionCommit(session, commit);
      if (score.total >= threshold) links.push({ session, commit, score });
    }
  }
  links.sort((a, b) => b.score.total - a.score.total);
  return links;
}

/**
 * The session is "in" the commit's repo if either:
 *   (a) its cwd is inside the repo (most common — claude-code, cursor), OR
 *   (b) any *absolute* file it touched lives inside the repo (catches
 *       openclaw-style agents that run from a workspace dir but write to
 *       absolute paths in other repos).
 *
 * Relative touchedFiles are deliberately ignored — `path.resolve` would
 * silently resolve them against the agent-history *process* cwd, which is
 * unrelated to where the agent itself was running and produces phantom
 * matches (notably for hermes, which records relative `write_file` paths).
 */
function scoreRepo(session: AgentSession, commit: GitCommit): number {
  const repo = path.resolve(commit.repo);
  if (session.cwd && isInside(path.resolve(session.cwd), repo)) return 1;
  for (const c of session.additionalCwds ?? []) {
    if (isInside(path.resolve(c), repo)) return 1;
  }
  for (const t of session.turns) {
    for (const f of t.touchedFiles ?? []) {
      if (!path.isAbsolute(f)) continue;
      if (isInside(f, repo)) return 1;
    }
  }
  return 0;
}

/**
 * Time score peaks when the commit happens during or shortly after the
 * session's *edit activity* window (developers commit after the agent
 * finishes editing). When per-turn timestamps + touchedFiles are available,
 * we narrow the window to the span covering edit-bearing turns — a 10-hour
 * session with a 5-minute editing burst should only score commits near
 * those 5 minutes, not the entire 10 hours.
 *
 * Falls back to the full session window when:
 *   - no turn has touchedFiles, or
 *   - the source doesn't record per-turn timestamps (hermes, partly cursor).
 *
 * Decay is asymmetric: post-window over 6h (developer commits after work),
 * pre-window over 1h with heavy damping (commits before edits can't have been
 * caused by them).
 */
function scoreTime(session: AgentSession, commit: GitCommit): number {
  const { start: windowStart, end: windowEnd } = activeWindow(session);
  const commitT = commit.time.getTime();

  if (commitT >= windowStart && commitT <= windowEnd) return 1;

  if (commitT > windowEnd) {
    const dt = commitT - windowEnd;
    const window = 6 * 60 * 60 * 1000;
    return Math.max(0, 1 - dt / window);
  }
  const dt = windowStart - commitT;
  const window = 60 * 60 * 1000;
  return Math.max(0, 1 - dt / window) * 0.3;
}

/**
 * Returns the time range covering the session's edit-bearing turns. If no
 * turn records both an edit and a timestamp, falls back to the full session
 * window. The fallback isn't ideal but is the best we can do for sources
 * that don't expose per-turn time (hermes top-level only, cursor user bubbles).
 */
function activeWindow(session: AgentSession): { start: number; end: number } {
  const editTimes: number[] = [];
  for (const t of session.turns) {
    if (!t.touchedFiles || t.touchedFiles.length === 0) continue;
    const start = t.startedAt?.getTime();
    const end = (t.endedAt ?? t.startedAt)?.getTime();
    if (start) editTimes.push(start);
    if (end) editTimes.push(end);
  }
  if (editTimes.length > 0) {
    return { start: Math.min(...editTimes), end: Math.max(...editTimes) };
  }
  return {
    start: session.startedAt.getTime(),
    end: (session.endedAt ?? session.startedAt).getTime(),
  };
}

/**
 * Asymmetric: fraction of the commit's changed files that the session edited.
 * "Did this session cover this commit's changes?" — not "did these two touch
 * the same set?". Sessions explore many files; commits record only edits.
 */
function scoreFiles(session: AgentSession, commit: GitCommit): number {
  const touched = collectTouchedFiles(session);
  if (touched.size === 0 || commit.files.length === 0) return 0;
  const commitFiles = commit.files.map((f) => path.resolve(f));
  let intersect = 0;
  for (const f of commitFiles) if (touched.has(f)) intersect++;
  return intersect / commitFiles.length;
}

function scoreBranch(session: AgentSession, commit: GitCommit): number {
  if (!session.gitBranch || !commit.branch) return 0;
  return session.gitBranch === commit.branch ? 1 : 0;
}

function collectTouchedFiles(session: AgentSession): Set<string> {
  const out = new Set<string>();
  for (const t of session.turns) {
    if (!t.touchedFiles) continue;
    for (const f of t.touchedFiles) out.add(path.resolve(f));
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function buildReason(parts: LinkageScore['parts'], referenced = false): string {
  const bits: string[] = [];
  if (referenced) bits.push('referenced this commit');
  if (parts.repo === 1 && !referenced) bits.push('repo match');
  if (parts.time === 1) bits.push('committed during session');
  else if (parts.time > 0.5) bits.push('committed shortly after session');
  if (parts.files > 0.5) bits.push(`${Math.round(parts.files * 100)}% file overlap`);
  else if (parts.files > 0) bits.push(`${Math.round(parts.files * 100)}% file overlap`);
  if (parts.branch === 1) bits.push('same branch');
  return bits.join(' · ') || 'weak signal';
}
