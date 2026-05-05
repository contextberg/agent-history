import type { AgentSource } from '../types';

const SOURCES: { value: AgentSource; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'openclaw', label: 'OpenClaw' },
];

interface Props {
  value: AgentSource | undefined;
  onChange: (v: AgentSource | undefined) => void;
}

export function SourceFilter({ value, onChange }: Props) {
  return (
    <div className="flex gap-2 flex-wrap relative z-10">
      <FilterPill active={!value} onClick={() => onChange(undefined)} activeColor="indigo">
        All Tools
      </FilterPill>
      {SOURCES.map((s) => (
        <FilterPill
          key={s.value}
          active={value === s.value}
          onClick={() => onChange(s.value)}
          activeColor={s.value === 'claude-code' ? 'orange' : s.value === 'cursor' ? 'blue' : 'emerald'}
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
  activeColor,
  children,
}: {
  active: boolean;
  onClick: () => void;
  activeColor: 'indigo' | 'orange' | 'blue' | 'emerald';
  children: React.ReactNode;
}) {
  const activeColors = {
    indigo: { bg: 'rgba(99, 102, 241, 0.18)', border: 'rgba(99, 102, 241, 0.5)', color: '#4F46E5' },
    orange: { bg: 'rgba(234, 88, 12, 0.15)', border: 'rgba(234, 88, 12, 0.45)', color: '#C2410C' },
    blue:   { bg: 'rgba(37, 99, 235, 0.15)', border: 'rgba(37, 99, 235, 0.45)', color: '#1D4ED8' },
    emerald:{ bg: 'rgba(5, 150, 105, 0.15)', border: 'rgba(5, 150, 105, 0.45)', color: '#047857' },
  };

  const c = activeColors[activeColor];

  return (
    <button
      onClick={onClick}
      className="text-[11px] font-semibold tracking-wide px-3 py-1.5 rounded-full transition-all duration-300"
      style={
        active
          ? { backgroundColor: c.bg, border: `1px solid ${c.border}`, color: c.color }
          : {
              backgroundColor: 'var(--bg-badge)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-tertiary)',
            }
      }
    >
      {children}
    </button>
  );
}
