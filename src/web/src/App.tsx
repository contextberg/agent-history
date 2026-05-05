import { useEffect, useState } from 'react';
import type { AgentSession, AgentSource } from './types';
import { fetchSessions } from './api';
import { SessionList } from './components/SessionList';
import { SessionView } from './components/SessionView';
import { SourceFilter } from './components/SourceFilter';
import { SettingsPanel } from './components/SettingsPanel';
import { ThemeToggle } from './components/ThemeToggle';
import { useSettings } from './hooks/useSettings';

type SidebarTab = 'sessions' | 'settings';

export function App() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selected, setSelected] = useState<AgentSession | null>(null);
  const [source, setSource] = useState<AgentSource | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const { settings, update: updateSettings } = useSettings();

  useEffect(() => {
    setLoading(true);
    fetchSessions(source)
      .then((data) => {
        setSessions(data);
        if (data.length > 0 && !selected) {
          setSelected(data[0]);
        }
      })
      .catch((err) => {
        console.error("Failed to fetch sessions:", err);
      })
      .finally(() => setLoading(false));
  }, [source]);

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
        {/* Sidebar header */}
        <header className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-main)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <h1 className="text-sm font-bold tracking-wide" style={{ color: 'var(--text-primary)' }}>
                agent-history
              </h1>
            </div>
            <ThemeToggle />
          </div>

          {/* Tab nav */}
          <div className="flex gap-1 p-1 rounded-lg" style={{ backgroundColor: 'var(--bg-app)' }}>
            {(['sessions', 'settings'] as SidebarTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setSidebarTab(tab)}
                className="flex-1 text-[11px] font-semibold capitalize py-1.5 rounded-md transition-colors"
                style={{
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
            <div className="mt-3">
              <SourceFilter value={source} onChange={setSource} />
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto flex flex-col">
          {sidebarTab === 'sessions' ? (
            loading ? (
              <div className="flex items-center justify-center h-32">
                <div className="w-5 h-5 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin" />
              </div>
            ) : (
              <SessionList sessions={sessions} selectedId={selected?.id} onSelect={setSelected} />
            )
          ) : (
            <SettingsPanel settings={settings} onUpdate={updateSettings} />
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main
        className="flex-1 relative overflow-hidden"
        style={{ backgroundColor: 'var(--bg-app)' }}
      >
        {/* Subtle decorative background glow (dark mode only) */}
        <div
          className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] rounded-full bg-indigo-500/[0.04] blur-[120px] pointer-events-none transition-opacity duration-500"
          style={{ opacity: 'var(--glow-opacity)' }}
        />
        <div
          className="absolute bottom-[-10%] left-[-10%] w-[600px] h-[600px] rounded-full bg-blue-500/[0.04] blur-[150px] pointer-events-none transition-opacity duration-500"
          style={{ opacity: 'var(--glow-opacity)' }}
        />

        {selected ? (
          <div className="h-full relative z-10">
            <SessionView session={selected} showToolCalls={settings.display.showToolCalls} />
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-4 relative z-10">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg mb-2"
              style={{
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-main)',
              }}
            >
              <svg className="w-8 h-8" style={{ color: 'var(--text-tertiary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <p className="text-sm font-medium tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Select a session to view the transcript
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
