import type { AgentSession, AgentSource, CommitKnowledge, CommitWithLinks } from './types';

export async function fetchSessions(source?: AgentSource): Promise<AgentSession[]> {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  const res = await fetch(`/api/sessions?${params}`);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}

export async function fetchStatus(): Promise<Record<AgentSource, boolean>> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error('Failed to fetch status');
  return res.json();
}

export async function fetchCommits(): Promise<CommitWithLinks[]> {
  const res = await fetch('/api/commits');
  if (!res.ok) throw new Error('Failed to fetch commits');
  const data = (await res.json()) as { commits: CommitWithLinks[] };
  return data.commits;
}

/**
 * Fetch the LLM-produced knowledge note for a commit. Returns null on 404 —
 * that's the normal pre-learn state (the watcher will fire on the next
 * commit, or the user can run `contextberg learn --commit <sha>` to backfill).
 */
export async function fetchCommitKnowledge(
  repo: string,
  sha: string,
): Promise<CommitKnowledge | null> {
  const params = new URLSearchParams({ repo, sha });
  const res = await fetch(`/api/commit-knowledge?${params}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch commit knowledge (${res.status})`);
  return res.json();
}
