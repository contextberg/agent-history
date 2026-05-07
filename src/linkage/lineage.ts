import type { AgentSession } from '../readers/types.js';

/**
 * A chain of sessions linked via resumedFrom — one logical task across
 * multiple terminal invocations or `--resume` continuations.
 *
 * Members are ordered oldest → newest. The root is the first member; the
 * `latest` getter is the last member (most recently active).
 */
export interface Lineage {
  /** Stable identifier — the root session's id. */
  id: string;
  members: AgentSession[];
  /** Aggregated session-level fields, rolled up across members. */
  startedAt: Date;
  endedAt: Date;
  /** Most recent member's source — typically all members share a source, but
   *  cross-source resume is possible if we later wire it up. */
  source: AgentSession['source'];
  /** First non-null cwd, walking from root forward. */
  cwd?: string;
  /** First non-null gitBranch. */
  gitBranch?: string;
  /** Union of all members' touchedFiles. */
  touchedFiles: string[];
}

/**
 * Group sessions into lineages by walking the resumedFrom edges.
 *
 * - Sessions without a resumedFrom (or whose parent is missing from the input)
 *   become roots of their own lineage.
 * - Each session belongs to exactly one lineage (the one rooted at its
 *   transitive ancestor).
 * - Lineages are returned sorted by their latest member's endedAt, descending,
 *   matching the existing session-list ordering convention.
 *
 * Note: cycles are defended against (won't loop forever) but shouldn't occur
 * in well-formed data — a session can't resume from itself transitively.
 */
export function buildLineages(sessions: AgentSession[]): Lineage[] {
  const byId = new Map<string, AgentSession>();
  for (const s of sessions) byId.set(s.id, s);

  // Step 1: find the root for each session. A root is a session whose
  // resumedFrom is missing from byId (i.e., we don't have the parent loaded).
  const rootCache = new Map<string, string>();
  function rootOf(id: string): string {
    const cached = rootCache.get(id);
    if (cached) return cached;
    const visited = new Set<string>();
    let cur = id;
    // Walk up until no parent or parent missing from input.
    while (true) {
      if (visited.has(cur)) break; // cycle defense
      visited.add(cur);
      const s = byId.get(cur);
      if (!s) break;
      const parentId = s.resumedFrom;
      if (!parentId || !byId.has(parentId)) break;
      cur = parentId;
    }
    for (const v of visited) rootCache.set(v, cur);
    return cur;
  }

  // Step 2: bucket sessions by root.
  const buckets = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const r = rootOf(s.id);
    let arr = buckets.get(r);
    if (!arr) { arr = []; buckets.set(r, arr); }
    arr.push(s);
  }

  // Step 3: build a Lineage from each bucket. Order members topologically
  // (root first, then walk resumedFrom edges forward). Resumed sessions
  // typically inherit their parent's first-user-message timestamp, so sorting
  // by startedAt is unstable; the chain itself is the authoritative order.
  const lineages: Lineage[] = [];
  for (const [rootId, members] of buckets) {
    const ordered = topoOrderChain(rootId, members);

    const startedAt = ordered.reduce(
      (min, s) => (s.startedAt.getTime() < min.getTime() ? s.startedAt : min),
      ordered[0]!.startedAt,
    );
    const endedAt = ordered.reduce(
      (max, s) => {
        const e = (s.endedAt ?? s.startedAt).getTime();
        return e > max.getTime() ? new Date(e) : max;
      },
      ordered[0]!.endedAt ?? ordered[0]!.startedAt,
    );

    const lineage: Lineage = {
      id: rootId,
      members: ordered,
      startedAt,
      endedAt,
      source: ordered[ordered.length - 1]!.source,
      touchedFiles: dedupedFiles(ordered),
    };
    const cwd = ordered.find((m) => !!m.cwd)?.cwd;
    if (cwd) lineage.cwd = cwd;
    const branch = ordered.find((m) => !!m.gitBranch)?.gitBranch;
    if (branch) lineage.gitBranch = branch;
    lineages.push(lineage);
  }

  lineages.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
  return lineages;
}

/**
 * Walk the resumedFrom edges in reverse: start at the root, then repeatedly
 * find the member whose resumedFrom points at the current tail. Falls back to
 * appending any remainder (defensive — handles forks or missing edges).
 */
function topoOrderChain(rootId: string, members: AgentSession[]): AgentSession[] {
  const byParent = new Map<string, AgentSession[]>();
  for (const m of members) {
    const key = m.resumedFrom ?? '';
    let arr = byParent.get(key);
    if (!arr) { arr = []; byParent.set(key, arr); }
    arr.push(m);
  }
  const root = members.find((m) => m.id === rootId);
  if (!root) return members;

  const ordered: AgentSession[] = [root];
  const seen = new Set<string>([root.id]);
  let tail = root.id;
  // Linear chain: extend by the child of the current tail.
  while (true) {
    const children = byParent.get(tail) ?? [];
    const next = children.find((c) => !seen.has(c.id));
    if (!next) break;
    ordered.push(next);
    seen.add(next.id);
    tail = next.id;
  }
  // Append anything we didn't reach (forks, broken edges).
  for (const m of members) if (!seen.has(m.id)) ordered.push(m);
  return ordered;
}

function dedupedFiles(sessions: AgentSession[]): string[] {
  const seen = new Set<string>();
  for (const s of sessions) {
    for (const t of s.turns) {
      for (const f of t.touchedFiles ?? []) seen.add(f);
    }
  }
  return [...seen];
}
