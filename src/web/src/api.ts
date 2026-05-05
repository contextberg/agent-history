import type { AgentSession, AgentSource } from './types';

export async function fetchSessions(source?: AgentSource): Promise<AgentSession[]> {
  const params = new URLSearchParams();
  if (source) params.set('source', source);
  const res = await fetch(`/api/sessions?${params}`);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}
