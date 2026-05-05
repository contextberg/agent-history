import type { AgentSource } from '../types';

export function sourceLabel(source: AgentSource): string {
  return { 'claude-code': 'Claude Code', cursor: 'Cursor', openclaw: 'OpenClaw' }[source];
}

export function sourceColor(source: AgentSource): string {
  return {
    'claude-code': 'text-orange-400',
    cursor: 'text-blue-400',
    openclaw: 'text-emerald-400',
  }[source];
}
