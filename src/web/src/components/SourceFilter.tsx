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

  const selectedCount = value.size;

  return (
    <div
      className="rounded-xl border px-2.5 py-2"
      style={{
        backgroundColor: 'var(--bg-card)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className="text-[10px] font-bold uppercase tracking-[0.11em]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Sources
        </span>
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors"
            style={{
              borderColor: 'var(--border-main)',
              color: 'var(--text-tertiary)',
              backgroundColor: 'var(--bg-panel)',
              fontFamily: 'inherit',
            }}
          >
            Clear {selectedCount}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
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
        fontSize: 10.5,
        fontWeight: active ? 700 : 500,
        padding: '3px 7px',
        borderRadius: 999,
        backgroundColor: active ? 'var(--accent-soft)' : 'var(--bg-panel)',
        color: active ? 'var(--text-primary)' : 'var(--source-filter-text, var(--text-tertiary))',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
        boxShadow: active ? 'inset 0 0 0 1px var(--accent-soft)' : 'none',
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
