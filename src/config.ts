import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface AgentHistoryConfig {
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

export const CONFIG_DEFAULTS: AgentHistoryConfig = {
  display: {
    showToolCalls: true,
    showToolOutputs: false,
  },
  mcp: {
    includeToolCalls: true,
    includeToolOutputs: false,
    maxSessions: 10,
    maxTurnsPerSession: 5,
    maxCharsPerField: 500,
  },
};

const CONFIG_DIR = path.join(os.homedir(), '.agent-history');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export async function loadConfig(): Promise<AgentHistoryConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AgentHistoryConfig>;
    return {
      display: { ...CONFIG_DEFAULTS.display, ...parsed.display },
      mcp: { ...CONFIG_DEFAULTS.mcp, ...parsed.mcp },
    };
  } catch {
    return CONFIG_DEFAULTS;
  }
}

export async function saveConfig(config: AgentHistoryConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
