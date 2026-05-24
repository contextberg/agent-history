import { useState, useEffect } from 'react';

export interface AppSettings {
  display: {
    showToolCalls: boolean;
    showToolOutputs: boolean;
  };
  mcp: {
    includeToolCalls: boolean;
    includeToolOutputs: boolean;
    maxSessions: number;
    maxTurnsPerSession: number;
    maxCharsPerField: number;
  };
  knowledge: {
    enabled: boolean;
    provider: string;
    model: string;
    outputDir: string;
    prompt?: string;
    watchedRepos: string[];
    ignoredRepos: string[];
  };
}

const DEFAULTS: AppSettings = {
  display: { showToolCalls: true, showToolOutputs: false },
  mcp: {
    includeToolCalls: true,
    includeToolOutputs: false,
    maxSessions: 10,
    maxTurnsPerSession: 30,
    maxCharsPerField: 100_000,
  },
  knowledge: {
    enabled: true,
    provider: '',
    model: '',
    outputDir: '.contextberg/knowledge',
    watchedRepos: [],
    ignoredRepos: [],
  },
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data: AppSettings) => setSettings({
        ...DEFAULTS,
        ...data,
        display: { ...DEFAULTS.display, ...data.display },
        mcp: { ...DEFAULTS.mcp, ...data.mcp },
        knowledge: { ...DEFAULTS.knowledge, ...data.knowledge },
      }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function update(patch: Partial<AppSettings>) {
    const previous = settings;
    const next: AppSettings = {
      display: { ...settings.display, ...patch.display },
      mcp: { ...settings.mcp, ...patch.mcp },
      knowledge: { ...settings.knowledge, ...patch.knowledge },
    };
    setSettings(next);
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => null);
    if (!res?.ok) {
      console.error('Failed to save settings');
      setSettings(previous);
    }
  }

  return { settings, update, loading };
}
