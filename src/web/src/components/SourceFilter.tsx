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
  value: Set<AgentSource>;
  onChange: (v: Set<AgentSource>) => void;
}

export function SourceFilter({ value, onChange }: Props) {
  const toggle = (source: AgentSource) => {
    const next = new Set(value);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    onChange(next);
  };
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <FilterPill active={value.size === 0} onClick={() => onChange(new Set())} source={undefined}>
        All
      </FilterPill>
      {SOURCES.map((s) => (
        <FilterPill
          key={s.value}
          active={value.has(s.value)}
          onClick={() => toggle(s.value)}
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
        backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--source-filter-text, var(--text-tertiary))',
        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
        boxShadow: active ? 'inset 0 0 0 1px var(--accent-soft)' : 'none',
        fontWeight: active ? 700 : 500,
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
