import type { AgentSession, AgentSource } from './types';

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
