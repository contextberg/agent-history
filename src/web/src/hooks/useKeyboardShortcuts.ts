import { useEffect, useCallback } from 'react';
import type { AgentSession } from '../types';
import type { ViewSettings } from './useViewSettings';
import type { AppSettings } from './useSettings';

interface KeyboardShortcutOptions {
  searchRef: React.RefObject<HTMLInputElement | null>;
  filteredSessions: AgentSession[];
  selectedSession: AgentSession | null;
  onSelectSession: (session: AgentSession) => void;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  viewSettings: ViewSettings;
  onUpdateView: <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => void;
}

export function useKeyboardShortcuts({
  searchRef,
  filteredSessions,
  selectedSession,
  onSelectSession,
  settings,
  onUpdateSettings,
  viewSettings,
  onUpdateView,
}: KeyboardShortcutOptions): void {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA';

    // Search shortcuts
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

    // Toggle tool calls
    if (e.key === 't' || e.key === 'T') {
      onUpdateSettings({
        display: { 
          showToolCalls: !settings.display.showToolCalls,
          showToolOutputs: settings.display.showToolOutputs,
        },
      });
      return;
    }

    // Navigate sessions with j/k
    if (e.key === 'j' || e.key === 'J') {
      const cur = selectedSession;
      const idx = cur ? filteredSessions.findIndex((s) => s.id === cur.id) : -1;
      const next = filteredSessions[idx + 1];
      if (next && idx < filteredSessions.length - 1) {
        onSelectSession(next);
      }
      return;
    }

    if (e.key === 'k' || e.key === 'K') {
      const cur = selectedSession;
      const idx = cur ? filteredSessions.findIndex((s) => s.id === cur.id) : 0;
      const prev = filteredSessions[idx - 1];
      if (prev && idx > 0) {
        onSelectSession(prev);
      }
      return;
    }

    // Toggle sidebar
    if (e.key === '[') {
      onUpdateView('sidebarOpen', !viewSettings.sidebarOpen);
      return;
    }
  }, [
    searchRef,
    filteredSessions,
    selectedSession,
    onSelectSession,
    settings.display.showToolCalls,
    onUpdateSettings,
    viewSettings.sidebarOpen,
    onUpdateView,
  ]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
