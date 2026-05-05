import { useState, useEffect } from 'react';

export interface AppSettings {
  display: {
    showToolCalls: boolean;
  };
  mcp: {
    includeToolCalls: boolean;
    maxSessions: number;
    maxTurnsPerSession: number;
    maxCharsPerField: number;
  };
}

const DEFAULTS: AppSettings = {
  display: {
    showToolCalls: true,
  },
  mcp: {
    includeToolCalls: true,
    maxSessions: 10,
    maxTurnsPerSession: 5,
    maxCharsPerField: 500,
  },
};

const KEY = 'agent-history-settings';

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }, [settings]);

  function update(patch: Partial<AppSettings>) {
    setSettings((prev) => ({
      display: { ...prev.display, ...(patch.display ?? {}) },
      mcp: { ...prev.mcp, ...(patch.mcp ?? {}) },
    }));
  }

  return { settings, update };
}
