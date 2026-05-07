import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession, AgentSource, CommitWithLinks } from './types';
import { fetchCommits, fetchSessions, fetchStatus } from './api';
import { SessionList } from './components/SessionList';
import { SessionView } from './components/SessionView';
import { SourceFilter } from './components/SourceFilter';
import { SettingsPanel } from './components/SettingsPanel';
import { ThemeToggle } from './components/ThemeToggle';
import { CommitList } from './components/CommitList';
import { CommitView } from './components/CommitView';
import { useSettings } from './hooks/useSettings';
import {
  useViewSettings,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from './hooks/useViewSettings';

type SidebarTab = 'sessions' | 'settings';
type GroupMode = 'time' | 'commit';
type Selection =
  | { kind: 'session'; session: AgentSession }
  | { kind: 'commit'; commit: CommitWithLinks }
  | null;

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
  const [commits, setCommits] = useState<CommitWithLinks[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>('time');
  const [selected, setSelected] = useState<Selection>(null);
  const [source, setSource] = useState<AgentSource | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Record<AgentSource, boolean> | undefined>(undefined);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const selectedSession = selected?.kind === 'session' ? selected.session : null;
  const selectedSha = selected?.kind === 'commit' ? selected.commit.sha : undefined;
  const selectSession = (s: AgentSession) => setSelected({ kind: 'session', session: s });
  const selectCommit = (c: CommitWithLinks) => setSelected({ kind: 'commit', commit: c });
  const { settings, update: updateSettings } = useSettings();
  const { settings: viewSettings, update: updateView } = useViewSettings();
  const searchRef = useRef<HTMLInputElement>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const sidebarWidth = dragWidth ?? viewSettings.sidebarWidth;

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = viewSettings.sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + (ev.clientX - startX)),
      );
      setDragWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      const final = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + (ev.clientX - startX)),
      );
      updateView('sidebarWidth', final);
      setDragWidth(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  useEffect(() => {
    const id = window.setInterval(() => {
      fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refresh = (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      Promise.all([fetchSessions(source), fetchStatus().catch(() => undefined)])
        .then(([data, stat]) => {
          if (cancelled) return;
          setSessions(data);
          setStatus(stat);
          setSelected((cur) => {
            if (cur) return cur;
            return data.length > 0 ? { kind: 'session', session: data[0]! } : null;
          });
        })
        .catch((err) => console.error('Failed to fetch sessions:', err))
        .finally(() => { if (!cancelled && showSpinner) setLoading(false); });
    };

    refresh(true);
    const interval = window.setInterval(() => refresh(false), 15_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(false); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const [commitsError, setCommitsError] = useState<string | null>(null);

  // Lazy-fetch commits the first time the user switches to commit mode, then
  // refresh every 30s while it's the active mode. Fail-soft on errors — the
  // existing session list view stays useful regardless.
  useEffect(() => {
    if (groupMode !== 'commit') return;
    let cancelled = false;
    let interval: number | undefined;
    const refresh = (showSpinner: boolean) => {
      if (showSpinner && commits.length === 0) setCommitsLoading(true);
      fetchCommits()
        .then((data) => {
          if (cancelled) return;
          setCommits(data);
          setCommitsError(null);
        })
        .catch((err) => {
          console.error('Failed to fetch commits:', err);
          if (!cancelled) setCommitsError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => { if (!cancelled) setCommitsLoading(false); });
    };
    refresh(true);
    interval = window.setInterval(() => refresh(false), 30_000);
    return () => { cancelled = true; if (interval) window.clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupMode]);

  const filteredSessions = useMemo(
    () => (query.trim() ? searchSessions(sessions, query) : sessions),
    [sessions, query],
  );

  // Apply the source filter to commit data too — when the user picks "cursor"
  // they want commits where cursor contributed, with non-cursor links hidden
  // inside each row. We map then filter so the strong/weak counts in
  // CommitList and the link groups in CommitView all see consistent data.
  const filteredCommits = useMemo(() => {
    if (!source) return commits;
    return commits
      .map((c) => ({ ...c, links: c.links.filter((l) => l.session.source === source) }))
      .filter((c) => c.links.length > 0);
  }, [commits, source]);

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
      // j/k navigate the session list when a session is selected. In commit
      // mode they're a no-op for now — keyboard nav for commits is a future polish.
      if (e.key === 'j' || e.key === 'J') {
        const cur = selectedSession;
        const idx = cur ? filteredSessions.findIndex((s) => s.id === cur.id) : -1;
        const next = filteredSessions[idx + 1];
        if (next && idx < filteredSessions.length - 1) selectSession(next);
      }
      if (e.key === 'k' || e.key === 'K') {
        const cur = selectedSession;
        const idx = cur ? filteredSessions.findIndex((s) => s.id === cur.id) : 0;
        const prev = filteredSessions[idx - 1];
        if (prev && idx > 0) selectSession(prev);
      }
      if (e.key === '[') {
        updateView('sidebarOpen', !viewSettings.sidebarOpen);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filteredSessions, selectedSession, settings.display.showToolCalls, updateSettings, updateView, viewSettings.sidebarOpen]);

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}
    >
      {/* Sidebar — closed rail */}
      {!viewSettings.sidebarOpen && (
        <aside
          className="shrink-0 flex flex-col items-center py-3 relative z-20"
          style={{
            width: 36,
            backgroundColor: 'var(--bg-panel)',
            borderRight: '1px solid var(--border-main)',
            boxShadow: 'var(--shadow-panel)',
          }}
        >
          <button
            onClick={() => updateView('sidebarOpen', true)}
            title="Open sidebar ([)"
            aria-label="Open sidebar"
            style={{
              width: 26,
              height: 26,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 7,
              border: '1px solid var(--border-main)',
              backgroundColor: 'var(--bg-card)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </aside>
      )}

      {/* Sidebar */}
      {viewSettings.sidebarOpen && (
      <aside
        className="shrink-0 flex flex-col relative z-20"
        style={{
          width: sidebarWidth,
          backgroundColor: 'var(--bg-panel)',
          borderRight: '1px solid var(--border-main)',
          boxShadow: 'var(--shadow-panel)',
        }}
      >
        {/* Header */}
        <header className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border-main)' }}>

          {/* Brand + theme toggle */}
          <div className="flex items-center justify-between mb-3.5">
            <div className="flex items-center gap-2.5">
              <img
                src="/favicon.svg"
                alt="Contextberg"
                width={26}
                height={26}
                style={{
                  display: 'block',
                  filter: 'drop-shadow(0 1px 2px rgba(15, 71, 120, 0.25))',
                }}
              />
              <div className="flex flex-col" style={{ lineHeight: 1.05 }}>
                <h1
                  className="text-[14px] font-semibold tracking-[-0.012em]"
                  style={{ color: 'var(--text-primary)' }}
                >
                  agent<span style={{ color: 'var(--accent)' }}>·</span>history
                </h1>
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 600,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'var(--text-tertiary)',
                    marginTop: 2,
                  }}
                >
                  Contextberg
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <button
                onClick={() => updateView('sidebarOpen', false)}
                title="Close sidebar ([)"
                aria-label="Close sidebar"
                style={{
                  width: 24,
                  height: 24,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-tertiary)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
            </div>
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
            <>
              <div className="mt-2.5">
                <SourceFilter value={source} onChange={setSource} />
              </div>
              <div
                className="mt-2.5 flex gap-0.5 p-[3px] rounded-lg"
                style={{ backgroundColor: 'var(--bg-inset)' }}
              >
                {(['time', 'commit'] as GroupMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setGroupMode(m)}
                    className="flex-1 text-[10.5px] font-semibold capitalize py-[4px] rounded-md transition-colors"
                    style={{
                      backgroundColor: groupMode === m ? 'var(--bg-panel)' : 'transparent',
                      color: groupMode === m ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      boxShadow: groupMode === m ? 'var(--shadow-card)' : 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                    title={m === 'time' ? 'Group sessions by time' : 'Group sessions under their commits'}
                  >
                    {m === 'time' ? 'By time' : 'By commit'}
                  </button>
                ))}
              </div>
            </>
          )}
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          {sidebarTab === 'sessions' ? (
            (loading || (groupMode === 'commit' && commitsLoading && commits.length === 0)) ? (
              <div className="flex items-center justify-center h-32">
                <div
                  className="w-4 h-4 rounded-full border-2 animate-spin"
                  style={{ borderColor: 'var(--border-main)', borderTopColor: 'var(--accent)' }}
                />
              </div>
            ) : groupMode === 'commit' ? (
              commitsError ? (
                <div style={{ padding: '24px 16px', color: 'var(--text-tertiary)', fontSize: 12 }}>
                  Failed to load commits: {commitsError}
                </div>
              ) : (
                <CommitList
                  commits={filteredCommits}
                  sessionCount={sessions.length}
                  selectedSha={selectedSha}
                  onSelect={selectCommit}
                />
              )
            ) : (
              <SessionList
                sessions={filteredSessions}
                selectedId={selectedSession?.id}
                onSelect={selectSession}
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

        {/* Resize handle */}
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
          style={{
            position: 'absolute',
            top: 0,
            right: -3,
            width: 6,
            height: '100%',
            cursor: 'col-resize',
            zIndex: 30,
            touchAction: 'none',
          }}
        />
      </aside>
      )}

      {/* Main */}
      <main className="flex-1 relative overflow-hidden" style={{ backgroundColor: 'var(--bg-app)' }}>
        {selected?.kind === 'session' ? (
          <SessionView
            session={selected.session}
            showToolCalls={settings.display.showToolCalls}
            showToolOutputs={settings.display.showToolOutputs}
            transcriptStyle={viewSettings.transcriptStyle}
            toolStyle={viewSettings.toolStyle}
            density={viewSettings.density}
          />
        ) : selected?.kind === 'commit' ? (
          <CommitView
            commit={
              // When the source filter is on, render the filtered commit
              // (links narrowed to that source) so the detail view matches
              // what the sidebar shows. If the selected commit no longer has
              // any links under the filter, fall back to the unfiltered
              // commit — the user can still see "0 links match this filter".
              filteredCommits.find((c) => c.sha === selected.commit.sha) ?? selected.commit
            }
            sessions={sessions}
            onSelectSession={selectSession}
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
              {groupMode === 'commit' ? 'コミットを選択' : 'セッションを選択してトランスクリプトを表示'}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
