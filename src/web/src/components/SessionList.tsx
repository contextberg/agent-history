import React, { useMemo, useState, memo } from 'react';
import type { AgentSession, AgentSource } from '../types';
import { sourceLabel, sourceHex } from '../utils/source';
import { SourceIcon } from './SourceIcon';
import { buildLineages, type Lineage } from '../utils/lineage';
import { cn } from '../lib/utils';

interface Props {
  sessions: AgentSession[];
  selectedId: string | undefined;
  onSelect: (s: AgentSession) => void;
  status?: Record<AgentSource, boolean>;
  query?: string;
}

const SOURCES: AgentSource[] = ['claude-code', 'cursor', 'openclaw', 'codex', 'hermes', 'copilot'];

const INSTALL_HINTS: Record<AgentSource, string> = {
  'claude-code': 'Install at claude.ai/code',
  cursor: 'Install at cursor.com',
  openclaw: 'Install at openclaw.dev',
  codex: 'Install at github.com/openai/codex',
  hermes: 'Install at github.com/NousResearch/hermes-agent',
  copilot: 'Install GitHub Copilot Chat in VS Code',
};

function relTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupLineagesByDate(lineages: Lineage[]): [string, Lineage[]][] {
  const result: Record<string, Lineage[]> = {
    Today: [],
    Yesterday: [],
    'Earlier this week': [],
    Older: [],
  };
  const now = new Date();
  const today = new Date(now.toDateString()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;
  for (const l of lineages) {
    const t = Date.parse(l.endedAt);
    if (t >= today) result.Today.push(l);
    else if (t >= yesterday) result.Yesterday.push(l);
    else if (t >= weekAgo) result['Earlier this week'].push(l);
    else result.Older.push(l);
  }
  return Object.entries(result).filter(([, list]) => list.length > 0);
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q || !q.trim()) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-[2px] px-[1px]" style={{ background: 'var(--accent-soft)', color: 'var(--text-primary)' }}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

const SessionRow = memo(function SessionRow({ s, active, onSelect, query, indent }: { 
  s: AgentSession; 
  active: boolean; 
  onSelect: () => void; 
  query: string; 
  indent?: boolean 
}) {
  const [hover, setHover] = useState(false);
  const color = sourceHex(s.source);
  const preview = s.turns[0]?.userMessage || '';

  return (
    <li>
      <button
        onClick={onSelect}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={cn(
          "focus-ring group relative w-full text-left flex gap-2.5 items-start rounded-[10px] cursor-pointer transition-all duration-150",
          indent ? "py-2 pl-[22px] pr-2.5" : "py-2.5 px-2.5",
          active
            ? "bg-[var(--bg-card-selected)] border border-[var(--border-card-selected)] shadow-[var(--shadow-card)]"
            : hover
            ? "bg-[var(--bg-card-hover)] border border-[var(--border-subtle)]"
            : "bg-transparent border border-transparent"
        )}
        style={{ fontFamily: 'inherit', color: 'inherit' }}
      >
        {indent && (
          <span
            aria-hidden
            className="absolute left-[11px] top-0 bottom-0 w-px"
            style={{ backgroundColor: 'var(--border-main)' }}
          />
        )}
        {/* Left rail */}
        <span
          className="absolute left-[-1px] top-2 bottom-2 w-[3px] rounded-sm transition-colors duration-150"
          style={{ backgroundColor: active ? color : 'transparent' }}
        />

        {/* Source icon */}
        <span className="mt-1 shrink-0">
          <SourceIcon source={s.source} size={16} />
        </span>

        <div className="flex-1 min-w-0">
          {/* Row 1: title + time */}
          <div className="flex items-baseline justify-between gap-1.5">
            <span
              className="text-[13px] font-semibold truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {highlight(s.project, query)}
            </span>
            <span className="text-[10.5px] shrink-0 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {relTime(s.startedAt)}
            </span>
          </div>

          {/* Row 2: agent name + turns */}
          <div className="flex items-center gap-[7px] mt-1">
            <span className="text-[9.5px] font-bold tracking-[0.07em] uppercase" style={{ color }}>
              {sourceLabel(s.source)}
            </span>
            <span className="w-0.5 h-0.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--text-quaternary)' }} />
            <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {s.turns.length} {s.turns.length === 1 ? 'turn' : 'turns'}
            </span>
          </div>

          {/* Row 3: preview */}
          {preview && (
            <p
              className="clamp-2 mt-1.5 text-[11.5px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              {highlight(preview, query)}
            </p>
          )}
        </div>
      </button>
    </li>
  );
});

const LineageRow = memo(function LineageRow({
  lineage,
  selectedId,
  onSelect,
  query,
}: {
  lineage: Lineage;
  selectedId: string | undefined;
  onSelect: (s: AgentSession) => void;
  query: string;
}) {
  const isMulti = lineage.members.length > 1;
  const containsSelected = lineage.members.some((m) => m.id === selectedId);
  const [expanded, setExpanded] = useState(false);
  const open = expanded || containsSelected;

  if (!isMulti) {
    const s = lineage.members[0]!;
    return (
      <SessionRow
        s={s}
        active={selectedId === s.id}
        onSelect={() => onSelect(s)}
        query={query}
      />
    );
  }

  const latest = lineage.members[lineage.members.length - 1]!;
  return (
    <li>
      <div className="relative">
        <button
          onClick={() => onSelect(latest)}
          className={cn(
            "focus-ring w-full text-left flex gap-2.5 items-start py-2.5 pl-2.5 pr-9 rounded-[10px] cursor-pointer transition-all duration-150",
            containsSelected
              ? "bg-[var(--bg-card-selected)] border border-[var(--border-card-selected)] shadow-[var(--shadow-card)]"
              : "bg-transparent border border-transparent"
          )}
          style={{ fontFamily: 'inherit', color: 'inherit' }}
        >
          <span className="mt-1 shrink-0">
            <SourceIcon source={lineage.source} size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-1.5">
              <span
              className="text-[13px] font-semibold truncate"
                style={{ color: 'var(--text-primary)' }}
              >
                {latest.project}
              </span>
              <span className="text-[10.5px] shrink-0 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                {relTime(lineage.endedAt)}
              </span>
            </div>
            <div className="flex items-center gap-[7px] mt-[3px]">
              <span
                className="text-[9.5px] font-bold tracking-[0.07em] uppercase"
                style={{ color: sourceHex(lineage.source) }}
              >
                {sourceLabel(lineage.source)}
              </span>
              <span className="w-0.5 h-0.5 rounded-full" style={{ backgroundColor: 'var(--text-quaternary)' }} />
              <span
                className="text-[10.5px] font-semibold tabular-nums"
                style={{ color: 'var(--accent)' }}
              >
                ↳ {lineage.members.length} sessions
              </span>
            </div>
            {latest.turns[0]?.userMessage && (
              <p
                className="clamp-2 mt-[5px] text-[11.5px] leading-relaxed"
                style={{ color: 'var(--text-secondary)' }}
              >
                {latest.turns[0].userMessage}
              </p>
            )}
          </div>
        </button>
        {/* Chevron */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          aria-label={open ? 'Collapse chain' : 'Expand chain'}
          title={open ? 'Collapse chain' : 'Expand chain'}
          className="absolute right-2 top-2 w-[22px] h-[22px] flex items-center justify-center rounded-md border-none bg-transparent p-0 cursor-pointer"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-transform duration-100"
            style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
      {open && (
        <ul className="flex flex-col gap-px pt-0.5 pb-1 px-0">
          {lineage.members.map((m) => (
            <SessionRow
              key={m.id}
              s={m}
              active={selectedId === m.id}
              onSelect={() => onSelect(m)}
              query={query}
              indent
            />
          ))}
        </ul>
      )}
    </li>
  );
});

export function SessionList({ sessions, selectedId, onSelect, status, query = '' }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="p-3 flex flex-col gap-2">
        {query ? (
          <div className="py-6 px-3 text-center text-xs" style={{ color: 'var(--text-tertiary)' }}>
            No sessions match your search.
          </div>
        ) : (
          <>
            <p className="m-0 py-2 px-2 text-[10px] font-semibold tracking-[0.08em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
              No sessions found
            </p>
            {status && SOURCES.map((src) => {
              const installed = status[src];
              return (
                <div
                  key={src}
                  className={cn(
                    "flex items-center gap-2.5 py-2 px-3 rounded-lg border",
                    installed ? "opacity-100" : "opacity-[0.55]"
                  )}
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    borderColor: 'var(--border-main)',
                  }}
                >
                  <span className="shrink-0" style={{ opacity: installed ? 1 : 0.5 }}>
                    <SourceIcon source={src} size={16} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="m-0 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {sourceLabel(src)}
                    </p>
                    <p className="m-0 mt-px text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {installed ? 'Connected — no recent sessions' : INSTALL_HINTS[src]}
                    </p>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  }

  const lineages = useMemo(() => buildLineages(sessions), [sessions]);
  const groups = groupLineagesByDate(lineages);

  return (
    <div className="py-2 pb-3">
      {groups.map(([label, list]) => (
        <div key={label}>
          <div className="px-4 pt-3 pb-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
            {label}
          </div>
          <ul className="flex flex-col gap-1 px-2.5">
            {list.map((l) => (
              <LineageRow
                key={l.id}
                lineage={l}
                selectedId={selectedId}
                onSelect={onSelect}
                query={query}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
