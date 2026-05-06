import React, { useState } from 'react';
import type { AgentSession, AgentSource } from '../types';
import { sourceLabel, sourceHex } from '../utils/source';

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

function groupByDate(sessions: AgentSession[]): [string, AgentSession[]][] {
  const result: Record<string, AgentSession[]> = {
    Today: [],
    Yesterday: [],
    'Earlier this week': [],
    Older: [],
  };
  const now = new Date();
  const today = new Date(now.toDateString()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;
  for (const s of sessions) {
    const t = new Date(s.startedAt).getTime();
    if (t >= today) result.Today.push(s);
    else if (t >= yesterday) result.Yesterday.push(s);
    else if (t >= weekAgo) result['Earlier this week'].push(s);
    else result.Older.push(s);
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
      <mark style={{ background: 'var(--accent-soft)', color: 'var(--text-primary)', padding: '0 1px', borderRadius: 2, fontStyle: 'normal' }}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function SessionRow({ s, active, onSelect, query }: { s: AgentSession; active: boolean; onSelect: () => void; query: string }) {
  const [hover, setHover] = useState(false);
  const color = sourceHex(s.source);
  const preview = s.turns[0]?.userMessage || '';

  return (
    <li>
      <button
        onClick={onSelect}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="focus-ring"
        style={{
          position: 'relative',
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          padding: '10px 10px',
          borderRadius: 8,
          backgroundColor: active
            ? 'var(--bg-card-selected)'
            : hover
            ? 'var(--bg-card-hover)'
            : 'transparent',
          border: `1px solid ${active ? 'var(--border-card-selected)' : 'transparent'}`,
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: 'inherit',
          transition: 'background 90ms',
        }}
      >
        {/* Left rail */}
        <span
          style={{
            position: 'absolute',
            left: -1,
            top: 8,
            bottom: 8,
            width: 2,
            borderRadius: 2,
            backgroundColor: active ? color : 'transparent',
            transition: 'background 150ms',
          }}
        />

        {/* Source dot */}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            backgroundColor: color,
            marginTop: 7,
            flexShrink: 0,
            boxShadow: `0 0 0 2px ${active ? 'var(--bg-card-selected)' : hover ? 'var(--bg-card-hover)' : 'var(--bg-panel)'}`,
          }}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Row 1: title + time */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: '-0.005em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {highlight(s.project, query)}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {relTime(s.startedAt)}
            </span>
          </div>

          {/* Row 2: agent name + turns */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color }}>
              {sourceLabel(s.source)}
            </span>
            <span style={{ width: 2, height: 2, borderRadius: 999, backgroundColor: 'var(--text-quaternary)', flexShrink: 0 }} />
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
              {s.turns.length} {s.turns.length === 1 ? 'turn' : 'turns'}
            </span>
          </div>

          {/* Row 3: preview */}
          {preview && (
            <p
              className="clamp-2"
              style={{ margin: '5px 0 0', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}
            >
              {highlight(preview, query)}
            </p>
          )}
        </div>
      </button>
    </li>
  );
}

export function SessionList({ sessions, selectedId, onSelect, status, query = '' }: Props) {
  if (sessions.length === 0) {
    return (
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {query ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
            No sessions match your search.
          </div>
        ) : (
          <>
            <p style={{ margin: 0, padding: '8px 8px 4px', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
              No sessions found
            </p>
            {status && SOURCES.map((src) => {
              const installed = status[src];
              const color = sourceHex(src);
              return (
                <div
                  key={src}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 12px',
                    borderRadius: 8,
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-main)',
                    opacity: installed ? 1 : 0.55,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      backgroundColor: installed ? color : 'var(--text-tertiary)',
                      flexShrink: 0,
                      animation: installed ? 'pulse 2s infinite' : 'none',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {sourceLabel(src)}
                    </p>
                    <p style={{ margin: '1px 0 0', fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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

  const groups = groupByDate(sessions);

  return (
    <div style={{ padding: '6px 0 8px' }}>
      {groups.map(([label, list]) => (
        <div key={label}>
          <div style={{
            padding: '10px 16px 5px',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}>
            {label}
          </div>
          <ul style={{ listStyle: 'none', padding: '0 8px', margin: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {list.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                active={selectedId === s.id}
                onSelect={() => onSelect(s)}
                query={query}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
