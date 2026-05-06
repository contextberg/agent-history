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

/**
 * Score a (session, commit) pair. The total is a weighted sum of sub-scores,
 * but if `repo` is 0 we short-circuit — a session that didn't run inside the
 * commit's repo cannot have contributed to it.
 */
export function scoreSessionCommit(session: AgentSession, commit: GitCommit): LinkageScore {
  const parts = {
    repo: scoreRepo(session, commit),
    time: scoreTime(session, commit),
    files: scoreFiles(session, commit),
    branch: scoreBranch(session, commit),
  };

  const total = parts.repo === 0
    ? 0
    : parts.repo * WEIGHTS.repo
      + parts.time * WEIGHTS.time
      + parts.files * WEIGHTS.files
      + parts.branch * WEIGHTS.branch;

  return { total, parts, reason: buildReason(parts) };
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

function scoreRepo(session: AgentSession, commit: GitCommit): number {
  if (!session.cwd) return 0;
  const cwd = path.resolve(session.cwd);
  const repo = path.resolve(commit.repo);
  return isInside(cwd, repo) ? 1 : 0;
}

/**
 * Time score peaks when the commit happens during or shortly after the
 * session's active window (developers commit *after* the agent finishes).
 * Wider windows decay linearly to 0 over ~6 hours.
 */
function scoreTime(session: AgentSession, commit: GitCommit): number {
  const sessionStart = session.startedAt.getTime();
  const sessionEnd = (session.endedAt ?? session.startedAt).getTime();
  const commitT = commit.time.getTime();

  // Inside the session window — strongest signal.
  if (commitT >= sessionStart && commitT <= sessionEnd) return 1;

  // After the session ends, decaying over 6h. Pre-session decays much faster
  // (1h) since commits before the session can't have been caused by it.
  if (commitT > sessionEnd) {
    const dt = commitT - sessionEnd;
    const window = 6 * 60 * 60 * 1000;
    return Math.max(0, 1 - dt / window);
  }
  const dt = sessionStart - commitT;
  const window = 60 * 60 * 1000;
  return Math.max(0, 1 - dt / window) * 0.3; // dampened — pre-commits are weak signal
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

function buildReason(parts: LinkageScore['parts']): string {
  const bits: string[] = [];
  if (parts.repo === 1) bits.push('repo match');
  if (parts.time === 1) bits.push('committed during session');
  else if (parts.time > 0.5) bits.push('committed shortly after session');
  if (parts.files > 0.5) bits.push(`${Math.round(parts.files * 100)}% file overlap`);
  else if (parts.files > 0) bits.push(`${Math.round(parts.files * 100)}% file overlap`);
  if (parts.branch === 1) bits.push('same branch');
  return bits.join(' · ') || 'weak signal';
}
