import type { AgentSession } from '../types';

/**
 * A chain of sessions linked via resumedFrom — one logical task across
 * multiple terminal invocations or `--resume` continuations. Members are
 * ordered topologically (root first, then children walking the chain).
 *
 * Mirrors `src/linkage/lineage.ts` but operates on the wire-format types
 * where dates are ISO strings rather than Date objects.
 */
export interface Lineage {
  id: string;
  members: AgentSession[];
  /** Earliest member's startedAt (ISO string). */
  startedAt: string;
  /** Latest member's endedAt or startedAt (ISO string). */
  endedAt: string;
  source: AgentSession['source'];
  cwd?: string;
  gitBranch?: string;
}

export function buildLineages(sessions: AgentSession[]): Lineage[] {
  const byId = new Map<string, AgentSession>();
  for (const s of sessions) byId.set(s.id, s);

  const rootCache = new Map<string, string>();
  function rootOf(id: string): string {
    const cached = rootCache.get(id);
    if (cached) return cached;
    const visited = new Set<string>();
    let cur = id;
    while (true) {
      if (visited.has(cur)) break;
      visited.add(cur);
      const s = byId.get(cur);
      if (!s) break;
      const parent = s.resumedFrom;
      if (!parent || !byId.has(parent)) break;
      cur = parent;
    }
    for (const v of visited) rootCache.set(v, cur);
    return cur;
  }

  const buckets = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const r = rootOf(s.id);
    let arr = buckets.get(r);
    if (!arr) { arr = []; buckets.set(r, arr); }
    arr.push(s);
  }

  const lineages: Lineage[] = [];
  for (const [rootId, members] of buckets) {
    const ordered = topoOrderChain(rootId, members);
    const startedAt = ordered.reduce(
      (min, s) => (Date.parse(s.startedAt) < Date.parse(min) ? s.startedAt : min),
      ordered[0]!.startedAt,
    );
    const endedAt = ordered.reduce((max, s) => {
      const e = s.endedAt ?? s.startedAt;
      return Date.parse(e) > Date.parse(max) ? e : max;
    }, ordered[0]!.endedAt ?? ordered[0]!.startedAt);

    const lineage: Lineage = {
      id: rootId,
      members: ordered,
      startedAt,
      endedAt,
      source: ordered[ordered.length - 1]!.source,
    };
    const cwd = ordered.find((m) => !!m.cwd)?.cwd;
    if (cwd) lineage.cwd = cwd;
    const branch = ordered.find((m) => !!m.gitBranch)?.gitBranch;
    if (branch) lineage.gitBranch = branch;
    lineages.push(lineage);
  }

  lineages.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
  return lineages;
}

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
  while (true) {
    const children = byParent.get(tail) ?? [];
    const next = children.find((c) => !seen.has(c.id));
    if (!next) break;
    ordered.push(next);
    seen.add(next.id);
    tail = next.id;
  }
  for (const m of members) if (!seen.has(m.id)) ordered.push(m);
  return ordered;
}
