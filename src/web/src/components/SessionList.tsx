import type { AgentSession } from '../types';
import { sourceLabel } from '../utils/source';

interface Props {
  sessions: AgentSession[];
  selectedId: string | undefined;
  onSelect: (s: AgentSession) => void;
}

const SOURCE_COLORS = {
  'claude-code': { bg: 'rgba(234, 88, 12, 0.12)', color: '#C2410C' },
  cursor:        { bg: 'rgba(37, 99, 235, 0.12)', color: '#1D4ED8' },
  openclaw:      { bg: 'rgba(5, 150, 105, 0.12)', color: '#047857' },
} as const;

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-main)',
          }}
        >
          <svg className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
        </div>
        <p className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>No sessions found</p>
      </div>
    );
  }

  return (
    <ul className="py-2 px-3 space-y-1">
      {sessions.map((s) => {
        const isSelected = selectedId === s.id;
        const sc = SOURCE_COLORS[s.source];
        return (
          <li key={s.id}>
            <button
              onClick={() => onSelect(s)}
              className="w-full text-left px-4 py-3 rounded-xl transition-all duration-200"
              style={{
                backgroundColor: isSelected ? 'var(--bg-card-selected)' : 'transparent',
                border: isSelected
                  ? '1px solid var(--border-card-selected)'
                  : '1px solid transparent',
                boxShadow: isSelected ? 'var(--shadow-card-hover)' : 'none',
              }}
            >
              <div className="flex items-center gap-2.5 mb-2">
                <span
                  className="text-[11px] font-bold tracking-wide uppercase px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: sc.bg, color: sc.color }}
                >
                  {sourceLabel(s.source)}
                </span>
                <span
                  className="text-xs font-medium truncate"
                  style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                >
                  {s.project}
                </span>
              </div>
              <p
                className="text-xs leading-relaxed line-clamp-2 mb-2"
                style={{ color: isSelected ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}
              >
                {s.turns[0]?.userMessage || <span className="italic opacity-50">Empty conversation</span>}
              </p>
              <div
                className="flex items-center justify-between text-[11px] font-medium"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <span>
                  {new Date(s.startedAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                  </svg>
                  {s.turns.length} {s.turns.length === 1 ? 'turn' : 'turns'}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
