import type { AgentSource } from '../types';

export function sourceLabel(source: AgentSource): string {
  const labels: Record<AgentSource, string> = {
    'claude-code': 'Claude Code',
    cursor: 'Cursor',
    openclaw: 'OpenClaw',
    codex: 'Codex',
    hermes: 'Hermes',
  };
  return labels[source];
}

export function sourceShort(source: AgentSource): string {
  const shorts: Record<AgentSource, string> = {
    'claude-code': 'CC',
    cursor: 'CS',
    openclaw: 'OC',
    codex: 'CX',
    hermes: 'HR',
  };
  return shorts[source];
}

export function sourceHex(source: AgentSource): string {
  const colors: Record<AgentSource, string> = {
    'claude-code': '#D97706',
    cursor: '#6366F1',
    openclaw: '#8B5CF6',
    codex: '#10B981',
    hermes: '#EC4899',
  };
  return colors[source];
}
