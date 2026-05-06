import React from 'react';
import type { AgentSource } from '../types';
import { SourceIcon } from './SourceIcon';

const SOURCES: { value: AgentSource; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'codex', label: 'Codex' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'copilot', label: 'GitHub Copilot' },
];

interface Props {
  value: AgentSource | undefined;
  onChange: (v: AgentSource | undefined) => void;
}

export function SourceFilter({ value, onChange }: Props) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <FilterPill active={!value} onClick={() => onChange(undefined)} source={undefined}>
        All
      </FilterPill>
      {SOURCES.map((s) => (
        <FilterPill
          key={s.value}
          active={value === s.value}
          onClick={() => onChange(s.value)}
          source={s.value}
        >
          {s.label}
        </FilterPill>
      ))}
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  source,
  children,
}: {
  active: boolean;
  onClick: () => void;
  source: AgentSource | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="focus-ring"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 500,
        padding: '3px 8px',
        borderRadius: 999,
        backgroundColor: active ? 'var(--bg-card-selected)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
        border: `1px solid ${active ? 'var(--border-main)' : 'transparent'}`,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background 90ms, color 90ms',
      }}
    >
      {source && <SourceIcon source={source} size={13} />}
      {children}
    </button>
  );
}
