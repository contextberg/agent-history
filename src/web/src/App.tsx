import React, { useMemo, useRef, useState, useCallback } from 'react';
import type { AgentSession, AgentSource, CommitWithLinks } from './types';
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
import { useSessions } from './hooks/useSessions';
import { useCommits } from './hooks/useCommits';
import { useDebounce } from './hooks/useDebounce';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { SessionListSkeleton } from './components/Skeleton';

type SidebarTab = 'sessions' | 'settings';
type GroupMode = 'time' | 'commit';
type Selection =
  | { kind: 'session'; session: AgentSession }
  | { kind: 'commit'; commit: CommitWithLinks }
  | null;

function searchSessions(sessions: AgentSession[], query: string): AgentSession[] {
  const q = query.toLowerCase().trim();
  if (!q) return sessions;
  
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
  const [groupMode, setGroupMode] = useState<GroupMode>('time');
  const [selected, setSelected] = useState<Selection>(null);
  const [sources, setSources] = useState<Set<AgentSource>>(() => new Set());
  const [query, setQuery] = useState('');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const debouncedQuery = useDebounce(query, 150);
  
  const selectedSession = selected?.kind === 'session' ? selected.session : null;
  const selectedSha = selected?.kind === 'commit' ? selected.commit.sha : undefined;
  
  const selectSession = useCallback((s: AgentSession) => {
    setSelected({ kind: 'session', session: s });
  }, []);
  
  const selectCommit = useCallback((c: CommitWithLinks) => {
    setSelected({ kind: 'commit', commit: c });
  }, []);

  const { settings, update: updateSettings } = useSettings();
  const { settings: viewSettings, update: updateView } = useViewSettings();
  const searchRef = useRef<HTMLInputElement>(null);

  const sidebarWidth = dragWidth ?? viewSettings.sidebarWidth;

  // Handle session data updates with selection reconciliation
  const handleSessionsUpdate = useCallback((data: AgentSession[]) => {
    setSelected((cur) => reconcileSelection(cur, data));
  }, []);

  const { 
    sessions, 
    loading: sessionsLoading, 
    error: sessionsError, 
    status 
  } = useSessions(handleSessionsUpdate);

  const { 
    commits, 
    loading: commitsLoading, 
    error: commitsError 
  } = useCommits(groupMode === 'commit' || sidebarTab === 'settings', useCallback((data) => {
    setSelected((cur) => {
      if (cur?.kind !== 'commit') return cur;
      const fresh = data.find((c) => c.sha === cur.commit.sha && c.repo === cur.commit.repo);
      return fresh ? { kind: 'commit', commit: fresh } : cur;
    });
  }, []));

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

  const filteredSessions = useMemo(() => {
    const bySource = sources.size > 0
      ? sessions.filter((s) => sources.has(s.source))
      : sessions;
    return debouncedQuery.trim() 
      ? searchSessions(bySource, debouncedQuery) 
      : bySource;
  }, [sessions, sources, debouncedQuery]);

  const filteredCommits = useMemo(() => {
    if (sources.size === 0) return commits;
    return commits
      .map((c) => ({ ...c, links: c.links.filter((l) => sources.has(l.session.source)) }))
      .filter((c) => c.links.length > 0);
  }, [commits, sources]);

  // Reconcile selection when filtered commits change
  React.useEffect(() => {
    if (groupMode !== 'commit' || selected?.kind !== 'commit') return;
    const stillVisible = filteredCommits.some(
      (c) => c.sha === selected.commit.sha && c.repo === selected.commit.repo,
    );
    if (!stillVisible) {
      setSelected(filteredCommits[0] ? { kind: 'commit', commit: filteredCommits[0] } : null);
    }
  }, [filteredCommits, groupMode, selected]);

  // Setup keyboard shortcuts
  useKeyboardShortcuts({
    searchRef,
    filteredSessions,
    selectedSession,
    onSelectSession: selectSession,
    settings,
    onUpdateSettings: updateSettings,
    viewSettings,
    onUpdateView: updateView,
  });

  const isLoading = sessionsLoading || (groupMode === 'commit' && commitsLoading && commits.length === 0);

  function renderSidebarContent() {
    if (sidebarTab === 'settings') {
      return (
        <SettingsPanel
          settings={settings}
          onUpdate={updateSettings}
          viewSettings={viewSettings}
          onUpdateView={updateView}
          commitRepos={[...new Set(filteredCommits.map((c) => c.repo))]}
        />
      );
    }

    if (isLoading) {
      return <SessionListSkeleton count={6} />;
    }

    if (sessionsError) {
      return (
        <div style={{ padding: '24px 16px', color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.6 }}>
          Failed to load sessions: {sessionsError}
        </div>
      );
    }

    if (groupMode === 'commit') {
      if (commitsError) {
        return (
          <div style={{ padding: '24px 16px', color: 'var(--text-tertiary)', fontSize: 12 }}>
            Failed to load commits: {commitsError}
          </div>
        );
      }
      return (
        <CommitList
          commits={filteredCommits}
          sessionCount={sessions.length}
          selectedSha={selectedSha}
          onSelect={selectCommit}
        />
      );
    }

    return (
      <SessionList
        sessions={filteredSessions}
        selectedId={selectedSession?.id}
        onSelect={selectSession}
        status={status}
        query={debouncedQuery}
      />
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      {/* Sidebar — closed rail */}
      {!viewSettings.sidebarOpen && (
        <aside
          className="shrink-0 flex flex-col items-center py-3 relative z-20 w-9 bg-[var(--bg-panel)] border-r border-[var(--border-main)]"
          style={{ boxShadow: 'var(--shadow-panel)' }}
        >
          <button
            onClick={() => updateView('sidebarOpen', true)}
            title="Open sidebar ([)"
            aria-label="Open sidebar"
            className="w-[26px] h-[26px] flex items-center justify-center rounded-md border bg-[var(--bg-card)] text-[var(--text-secondary)] cursor-pointer p-0"
            style={{ borderColor: 'var(--border-main)' }}
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
        className="shrink-0 flex flex-col relative z-20 bg-[var(--bg-panel)] border-r border-[var(--border-main)]"
        style={{ width: sidebarWidth, boxShadow: 'var(--shadow-panel)' }}
      >
        {/* Header */}
        <header className="px-4 pt-4 pb-3.5 border-b border-[var(--border-main)]">

          {/* Brand + theme toggle */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <img
                src="/favicon.svg"
                alt="Contextberg"
                width={26}
                height={26}
                className="block"
                style={{ filter: 'drop-shadow(0 1px 2px rgba(15, 71, 120, 0.25))' }}
              />
              <div className="flex flex-col leading-tight">
                <h1 className="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
                  agent<span className="text-[var(--accent)]">·</span>history
                </h1>
                <span className="text-[9.5px] font-semibold tracking-[0.14em] uppercase text-[var(--text-tertiary)] mt-0.5">
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
                className="w-6 h-6 flex items-center justify-center rounded-md border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer p-0"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-[var(--bg-card)] border border-[var(--border-main)] mb-3">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--text-tertiary)]">
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search prompts, projects…"
              className="flex-1 bg-transparent border-none outline-none text-[12.5px] text-[var(--text-primary)]"
              style={{ fontFamily: 'inherit' }}
            />
            {query ? (
              <button
                onClick={() => setQuery('')}
                className="flex bg-transparent border-none cursor-pointer text-[var(--text-tertiary)] p-0"
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
          <div className="flex gap-0.5 p-[3px] rounded-xl bg-[var(--bg-inset)]">
            {(['sessions', 'settings'] as SidebarTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setSidebarTab(tab)}
                className="flex-1 text-[11px] font-semibold capitalize py-1.5 rounded-lg transition-colors border-none cursor-pointer"
                style={{
                  fontFamily: 'inherit',
                  backgroundColor: sidebarTab === tab ? 'var(--bg-panel)' : 'transparent',
                  color: sidebarTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  boxShadow: sidebarTab === tab ? 'var(--shadow-card)' : 'none',
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {sidebarTab === 'sessions' && (
            <>
              <div className="mt-3">
                <SourceFilter value={sources} onChange={setSources} />
              </div>
              <div className="mt-3 flex gap-0.5 p-[3px] rounded-xl bg-[var(--bg-inset)]">
                {(['time', 'commit'] as GroupMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setGroupMode(m)}
                    className="flex-1 text-[10.5px] font-semibold capitalize py-1.5 rounded-lg transition-colors border-none cursor-pointer"
                    style={{
                      fontFamily: 'inherit',
                      backgroundColor: groupMode === m ? 'var(--bg-panel)' : 'transparent',
                      color: groupMode === m ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      boxShadow: groupMode === m ? 'var(--shadow-card)' : 'none',
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
          {renderSidebarContent()}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 shrink-0 border-t border-[var(--border-main)] text-[11px]">
          <span className="text-[var(--text-tertiary)] tabular-nums">
            {filteredSessions.length} sessions
          </span>
          <div className="flex items-center gap-1.5">
            <span className="kbd">/</span>
            <span className="text-[var(--text-tertiary)] text-[10.5px]">to search</span>
          </div>
        </div>

        {/* Resize handle */}
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
          className="absolute top-0 -right-[3px] w-1.5 h-full cursor-col-resize touch-none z-30"
        />
      </aside>
      )}

      {/* Main */}
      <main className="main-vignette flex-1 relative overflow-hidden bg-[var(--bg-app)]">
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
              filteredCommits.find((c) => c.sha === selected.commit.sha) ?? selected.commit
            }
            sessions={sessions}
            onSelectSession={selectSession}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-4">
            <div
              className="w-20 h-20 rounded-[22px] flex items-center justify-center"
              style={{
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-main)',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <img
                src="/favicon.svg"
                alt="Contextberg"
                width={36}
                height={36}
                className="opacity-60"
              />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {groupMode === 'commit' ? 'Select a commit to view knowledge' : 'Select a session to view transcript'}
              </p>
              <p className="text-xs" style={{ color: 'var(--text-quaternary)' }}>
                Use <span className="kbd">/</span> to search · <span className="kbd">[</span> to toggle sidebar
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function reconcileSelection(cur: Selection, data: AgentSession[]): Selection {
  if (cur?.kind === 'session') {
    const fresh = data.find((s) => s.id === cur.session.id);
    return fresh
      ? { kind: 'session', session: fresh }
      : data.length > 0
        ? { kind: 'session', session: data[0]! }
        : null;
  }
  if (cur?.kind === 'commit') return cur;
  return data.length > 0 ? { kind: 'session', session: data[0]! } : null;
}
