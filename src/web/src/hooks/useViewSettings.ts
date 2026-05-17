import { useState, useEffect } from 'react';

export type TranscriptStyle = 'transcript' | 'chat' | 'document';
export type ToolStyle = 'collapse' | 'inline' | 'gutter' | 'card';
export type Density = 'compact' | 'cozy' | 'comfortable';
export type AccentName = 'indigo' | 'amber' | 'green' | 'blue' | 'pink' | 'graphite';

export interface ViewSettings {
  transcriptStyle: TranscriptStyle;
  toolStyle: ToolStyle;
  density: Density;
  accent: AccentName;
  sidebarOpen: boolean;
  sidebarWidth: number;
}

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 320;

const DEFAULTS: ViewSettings = {
  transcriptStyle: 'chat',
  toolStyle: 'collapse',
  density: 'cozy',
  accent: 'indigo',
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
};

const STORAGE_KEY = 'ah-view-settings';

export const ACCENT_PRESETS: Record<AccentName, { color: string; soft: string; strong: string }> = {
  indigo:   { color: '#6366F1', soft: 'rgba(99,102,241,0.12)',  strong: '#4F46E5' },
  amber:    { color: '#D97757', soft: 'rgba(217,119,87,0.14)',  strong: '#B85F40' },
  green:    { color: '#1F8A5B', soft: 'rgba(31,138,91,0.14)',   strong: '#176B47' },
  blue:     { color: '#2A6FDB', soft: 'rgba(42,111,219,0.14)',  strong: '#1E5BB8' },
  pink:     { color: '#D14B85', soft: 'rgba(209,75,133,0.14)',  strong: '#A93A6C' },
  graphite: { color: '#3D3D58', soft: 'rgba(61,61,88,0.10)',    strong: '#222238' },
};

function applyAccent(name: AccentName) {
  const p = ACCENT_PRESETS[name];
  const root = document.documentElement;
  root.style.setProperty('--accent', p.color);
  root.style.setProperty('--accent-soft', p.soft);
  root.style.setProperty('--accent-strong', p.strong);
}

export function useViewSettings() {
  const [settings, setSettings] = useState<ViewSettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? { ...DEFAULTS, ...JSON.parse(saved) } : DEFAULTS;
    } catch {
      return DEFAULTS;
    }
  });

  useEffect(() => {
    applyAccent(settings.accent);
  }, [settings.accent]);

  function update<K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  return { settings, update };
}
