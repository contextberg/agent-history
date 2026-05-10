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
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data: AppSettings) => setSettings({ ...DEFAULTS, ...data }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function update(patch: Partial<AppSettings>) {
    const next: AppSettings = {
      display: { ...settings.display, ...patch.display },
      mcp: { ...settings.mcp, ...patch.mcp },
    };
    setSettings(next);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {});
  }

  return { settings, update, loading };
}
