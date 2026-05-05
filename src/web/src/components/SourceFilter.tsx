import React from 'react';
import type { AgentSource } from '../types';
import { sourceHex } from '../utils/source';

const SOURCES: { value: AgentSource; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'codex', label: 'Codex' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'antigravity', label: 'Antigravity' },
];

interface Props {
  value: AgentSource | undefined;
  onChange: (v: AgentSource | undefined) => void;
}

export function SourceFilter({ value, onChange }: Props) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <FilterPill active={!value} onClick={() => onChange(undefined)} hex={undefined}>
        All
      </FilterPill>
      {SOURCES.map((s) => (
        <FilterPill
          key={s.value}
          active={value === s.value}
          onClick={() => onChange(s.value)}
          hex={sourceHex(s.value)}
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
  hex,
  children,
}: {
  active: boolean;
  onClick: () => void;
  hex: string | undefined;
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
      {hex && (
        <span style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: hex, flexShrink: 0 }} />
      )}
      {children}
    </button>
  );
}
