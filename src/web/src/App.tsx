import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession, AgentSource } from './types';
import { fetchSessions, fetchStatus } from './api';
import { SessionList } from './components/SessionList';
import { SessionView } from './components/SessionView';
import { SourceFilter } from './components/SourceFilter';
import { SettingsPanel } from './components/SettingsPanel';
import { ThemeToggle } from './components/ThemeToggle';
import { useSettings } from './hooks/useSettings';
import { useViewSettings } from './hooks/useViewSettings';

type SidebarTab = 'sessions' | 'settings';

function searchSessions(sessions: AgentSession[], query: string): AgentSession[] {
  const q = query.toLowerCase().trim();
  return sessions.filter(
    (s) =>
      s.project.toLowerCase().includes(q) ||
      s.source.toLowerCase().includes(q) ||
      s.turns.some(
        (t) =>
          t.userMessage.toLowerCase().includes(q) ||
          t.assistantSummary.toLowerCase().includes(q) ||
          t.items.some(
            (it) =>
              (it.kind === 'text' && it.text.toLowerCase().includes(q)) ||
              (it.kind === 'tool' &&
                (it.tool.name.toLowerCase().includes(q) ||
                  JSON.stringify(it.tool.input).toLowerCase().includes(q))),
          ),
      ),
  );
}

export function App() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selected, setSelected] = useState<AgentSession | null>(null);
  const [source, setSource] = useState<AgentSource | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Record<AgentSource, boolean> | undefined>(undefined);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const { settings, update: updateSettings } = useSettings();
  const { settings: viewSettings, update: updateView } = useViewSettings();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchSessions(source), fetchStatus().catch(() => undefined)])
      .then(([data, stat]) => {
        setSessions(data);
        setStatus(stat);
        if (data.length > 0 && !selected) setSelected(data[0]);
      })
      .catch((err) => console.error('Failed to fetch sessions:', err))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const filteredSessions = useMemo(
    () => (query.trim() ? searchSessions(sessions, query) : sessions),
    [sessions, query],
  );

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA';

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === '/' && !isInput) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isInput) return;

      if (e.key === 't' || e.key === 'T') {
        updateSettings({ display: { showToolCalls: !settings.display.showToolCalls } });
      }
      if (e.key === 'j' || e.key === 'J') {
        const idx = selected ? filteredSessions.findIndex((s) => s.id === selected.id) : -1;
        if (idx < filteredSessions.length - 1) setSelected(filteredSessions[idx + 1]);
      }
      if (e.key === 'k' || e.key === 'K') {
        const idx = selected ? filteredSessions.findIndex((s) => s.id === selected.id) : 0;
        if (idx > 0) setSelected(filteredSessions[idx - 1]);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filteredSessions, selected, settings.display.showToolCalls, updateSettings]);

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}
    >
      {/* Sidebar */}
      <aside
        className="w-80 shrink-0 flex flex-col relative z-20"
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderRight: '1px solid var(--border-main)',
          boxShadow: 'var(--shadow-panel)',
        }}
      >
        {/* Header */}
        <header className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border-main)' }}>

          {/* Brand + theme toggle */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div
                className="w-[22px] h-[22px] rounded-md flex items-center justify-center"
                style={{
                  backgroundColor: 'var(--accent)',
                  boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.1)',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 8v4l2 2" /><circle cx="12" cy="12" r="9" />
                </svg>
              </div>
              <h1 className="text-[13.5px] font-semibold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>
                agent<span style={{ color: 'var(--text-tertiary)' }}>·</span>history
              </h1>
            </div>
            <ThemeToggle />
          </div>

          {/* Search */}
          <div
            className="flex items-center gap-2 px-2.5 py-[7px] rounded-lg mb-2.5"
            style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-main)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts, projects…"
              className="flex-1 bg-transparent border-none outline-none text-[12.5px]"
              style={{ color: 'var(--text-primary)', fontFamily: 'inherit' }}
            />
            {query ? (
              <button
                onClick={() => setQuery('')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 0, display: 'flex' }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            ) : (
              <span className="kbd">⌘K</span>
            )}
          </div>

          {/* Tabs */}
          <div
            className="flex gap-0.5 p-[3px] rounded-lg"
            style={{ backgroundColor: 'var(--bg-inset)' }}
          >
            {(['sessions', 'settings'] as SidebarTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setSidebarTab(tab)}
                className="flex-1 text-[11px] font-semibold capitalize py-[5px] rounded-md transition-colors"
                style={{
                  backgroundColor: sidebarTab === tab ? 'var(--bg-panel)' : 'transparent',
                  color: sidebarTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  boxShadow: sidebarTab === tab ? 'var(--shadow-card)' : 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {sidebarTab === 'sessions' && (
            <div className="mt-2.5">
              <SourceFilter value={source} onChange={setSource} />
            </div>
          )}
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          {sidebarTab === 'sessions' ? (
            loading ? (
              <div className="flex items-center justify-center h-32">
                <div
                  className="w-4 h-4 rounded-full border-2 animate-spin"
                  style={{ borderColor: 'var(--border-main)', borderTopColor: 'var(--accent)' }}
                />
              </div>
            ) : (
              <SessionList
                sessions={filteredSessions}
                selectedId={selected?.id}
                onSelect={setSelected}
                status={status}
                query={query}
              />
            )
          ) : (
            <SettingsPanel
              settings={settings}
              onUpdate={updateSettings}
              viewSettings={viewSettings}
              onUpdateView={updateView}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-2 shrink-0"
          style={{ borderTop: '1px solid var(--border-main)', fontSize: 11 }}
        >
          <span style={{ color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
            {filteredSessions.length} sessions
          </span>
          <div className="flex items-center gap-1.5">
            <span className="kbd">/</span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 10.5 }}>to search</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 relative overflow-hidden" style={{ backgroundColor: 'var(--bg-app)' }}>
        {selected ? (
          <SessionView
            session={selected}
            showToolCalls={settings.display.showToolCalls}
            transcriptStyle={viewSettings.transcriptStyle}
            toolStyle={viewSettings.toolStyle}
            density={viewSettings.density}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-main)' }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-tertiary)' }}>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              セッションを選択してトランスクリプトを表示
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
