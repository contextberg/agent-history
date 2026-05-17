import path from 'node:path';
import { findRepoRoot, readCommits } from '../git/reader.js';
import { DEFAULT_LINK_THRESHOLD, scoreSessionCommit } from '../linkage/scorer.js';
import type { AgentSession, AgentSource } from '../readers/types.js';

/**
 * Just enough session metadata to render a link in the UI without forcing the
 * client to also have that session loaded in its main list. Inlining this is
 * cheap (~100 B per link) and guarantees we never show "(unknown session)".
 */
export interface LinkedSessionSnippet {
  id: string;
  project: string;
  source: AgentSource;
  /** ISO 8601. */
  startedAt: string;
  gitBranch?: string;
}

export interface SessionCommitLink {
  session: LinkedSessionSnippet;
  score: number;
  parts: { repo: number; time: number; files: number; branch: number };
  reason: string;
}

export interface CommitWithLinks {
  repo: string;
  sha: string;
  /** ISO 8601. */
  time: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  /** Absolute paths. */
  files: string[];
  /** Sessions that scored above the threshold, sorted by score descending. */
  links: SessionCommitLink[];
  /** Latest knowledge extraction run recorded for this commit, if any. */
  learnRun?: {
    ts: string;
    status: 'ok' | 'skip' | 'no-sessions' | 'no-auth' | 'empty' | 'error';
    reason?: string;
    provider?: string;
    model?: string;
  };
}

/**
 * Aggregate commits across every git repo that any session touched, score
 * each commit against every session, and attach the resulting links.
 *
 * - Repo discovery: walk distinct `session.cwd` values, resolve to repo roots
 *   via `git rev-parse --show-toplevel`. Sessions outside any repo are ignored.
 * - Time window: per repo, since = earliest session - 1 day; until = now.
 * - Output is sorted by commit time descending; the client groups by repo.
 *
 * No caching here — runs per request. With ~10 repos × ~50 commits × ~100
 * sessions this is well under 200ms in practice. Cache later if it matters.
 */
export async function aggregateCommits(sessions: AgentSession[]): Promise<CommitWithLinks[]> {
  // Repo discovery walks both cwds AND the directories of touchedFiles —
  // an openclaw-style agent runs in its own workspace dir but writes to
  // absolute paths in other repos. Without considering touchedFiles, those
  // sessions would never surface for the repos they actually edited.
  //
  // Cost is bounded by a path→repo cache that short-circuits when a path
  // sits under an already-discovered repo root (very common after a few
  // findRepoRoot calls).
  const candidatePaths = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) candidatePaths.add(s.cwd);
    for (const c of s.additionalCwds ?? []) candidatePaths.add(c);
    for (const t of s.turns) {
      for (const f of t.touchedFiles ?? []) {
        // Skip relative paths — without an explicit base they'd resolve
        // against the *server's* cwd, falsely attributing the session to
        // whatever repo the server is running in.
        if (path.isAbsolute(f)) candidatePaths.add(path.dirname(f));
      }
    }
  }

  const knownRoots = new Set<string>();
  const pathToRepo = new Map<string, string | null>();
  const resolveOne = async (p: string): Promise<void> => {
    if (pathToRepo.has(p)) return;
    const resolved = path.resolve(p);
    for (const r of knownRoots) {
      if (isInside(resolved, r)) { pathToRepo.set(p, r); return; }
    }
    const root = await findRepoRoot(p);
    // Normalize via path.resolve so this matches `commit.repo` (which
    // readCommits also runs through path.resolve) byte-for-byte. Without this,
    // git returns `C:/foo` and Windows `path.resolve` gives `C:\foo` — they
    // string-compare unequal and every same-repo lookup misses.
    const normalized = root ? path.resolve(root) : null;
    pathToRepo.set(p, normalized);
    if (normalized) knownRoots.add(normalized);
  };
  // Resolve in fixed-size batches. Each batch waits for the previous to finish
  // so the known-root cache from earlier batches short-circuits later paths
  // (avoiding redundant `git rev-parse` spawns for siblings of an already-
  // resolved repo).
  const queue = [...candidatePaths];
  const BATCH = 16;
  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH);
    await Promise.all(batch.map(resolveOne));
  }

  if (knownRoots.size === 0) return [];

  // Per-repo: collect all sessions whose cwd or any touchedFile lives inside
  // the repo, then fetch commits over the union of their windows.
  const allCommitsByRepo: Array<Awaited<ReturnType<typeof readCommits>>> = await Promise.all(
    [...knownRoots].map(async (repo) => {
      const inRepo = sessions.filter((s) => sessionRelatesToRepo(s, repo, pathToRepo));
      if (inRepo.length === 0) return [];
      const earliest = inRepo.reduce(
        (min, s) => (s.startedAt.getTime() < min ? s.startedAt.getTime() : min),
        inRepo[0]!.startedAt.getTime(),
      );
      const since = new Date(earliest - 24 * 60 * 60 * 1000);
      return readCommits(repo, { since, limit: 300 });
    }),
  );

  // Sessions without cwd (notably hermes) can still belong to a repo if they
  // referenced one of its SHAs. Build a sha→repo lookup over everything we
  // just fetched and use it to attach those sessions to the right repos.
  // The `referencingSessions` set tells `aggregateLinks` which extra sessions
  // to score for each commit.
  const shaToRepo = new Map<string, string>();
  for (const list of allCommitsByRepo) {
    for (const c of list) shaToRepo.set(c.sha.toLowerCase(), c.repo);
  }
  const sessionsByRepo = new Map<string, Set<string>>();
  for (const s of sessions) {
    if (!s.referencedCommits) continue;
    const matchedRepos = new Set<string>();
    for (const ref of s.referencedCommits) {
      const lower = ref.toLowerCase();
      // Try exact match first; otherwise prefix match against the (longer) full SHA.
      const exact = shaToRepo.get(lower);
      if (exact) { matchedRepos.add(exact); continue; }
      for (const [full, repo] of shaToRepo) {
        if (full.startsWith(lower)) { matchedRepos.add(repo); break; }
      }
    }
    for (const r of matchedRepos) {
      let set = sessionsByRepo.get(r);
      if (!set) { set = new Set(); sessionsByRepo.set(r, set); }
      set.add(s.id);
    }
  }

  const sessionById = new Map<string, AgentSession>();
  for (const s of sessions) sessionById.set(s.id, s);

  const result: CommitWithLinks[] = [];
  for (const commits of allCommitsByRepo) {
    for (const c of commits) {
      // Candidate session set: everyone whose cwd/touchedFiles live in this
      // repo, plus anyone who referenced one of this repo's SHAs (covers
      // hermes-style cwd-less sessions). We carry the discovery channel
      // forward as `repoMatched` so the scorer doesn't fail to credit
      // referenced-repo sessions on commits other than the one they cited.
      const candidateIds = new Set<string>();
      for (const s of sessions) {
        if (sessionRelatesToRepo(s, c.repo, pathToRepo)) candidateIds.add(s.id);
      }
      const referencedRepoSessions = sessionsByRepo.get(c.repo) ?? new Set<string>();
      for (const id of referencedRepoSessions) candidateIds.add(id);

      const links: SessionCommitLink[] = [];
      for (const id of candidateIds) {
        const s = sessionById.get(id);
        if (!s) continue;
        const repoMatched = referencedRepoSessions.has(id)
          || sessionRelatesToRepo(s, c.repo, pathToRepo);
        const score = scoreSessionCommit(s, c, { repoMatched });
        // Filter at the same threshold the linkage layer uses for "this is a
        // real candidate, not just same-repo coincidence". Below threshold is
        // pure noise — the commit and the session merely happened in the same
        // repo at unrelated times.
        if (score.total < DEFAULT_LINK_THRESHOLD) continue;
        const snippet: LinkedSessionSnippet = {
          id: s.id,
          project: s.project,
          source: s.source,
          startedAt: s.startedAt.toISOString(),
        };
        if (s.gitBranch) snippet.gitBranch = s.gitBranch;
        links.push({
          session: snippet,
          score: score.total,
          parts: score.parts,
          reason: score.reason,
        });
      }
      // Drop commits with no plausible session — they'd just clutter the list
      // with empty rows.
      if (links.length === 0) continue;
      links.sort((a, b) => b.score - a.score);
      result.push({
        repo: c.repo,
        sha: c.sha,
        time: c.time.toISOString(),
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        subject: c.subject,
        files: c.files,
        links: links.slice(0, 20),
      });
    }
  }

  result.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return result;
}

function sessionRelatesToRepo(
  s: AgentSession,
  repo: string,
  pathToRepo: Map<string, string | null>,
): boolean {
  if (s.cwd && pathToRepo.get(s.cwd) === repo) return true;
  for (const c of s.additionalCwds ?? []) {
    if (pathToRepo.get(c) === repo) return true;
  }
  for (const t of s.turns) {
    for (const f of t.touchedFiles ?? []) {
      if (!path.isAbsolute(f)) continue;
      if (pathToRepo.get(path.dirname(f)) === repo) return true;
    }
  }
  return false;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
