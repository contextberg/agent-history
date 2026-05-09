import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type KnowledgeProvider = 'anthropic' | 'openai';

export interface KnowledgeConfig {
  enabled: boolean;
  provider: KnowledgeProvider;
  model: string;
  /**
   * API key (plain text). Corresponding env var takes priority:
   *   anthropic → ANTHROPIC_API_KEY
   *   openai    → OPENAI_API_KEY
   */
  apiKey?: string;
  /** Path relative to repo root, or absolute. */
  outputDir: string;
  maxSessionsPerCommit: number;
  /** Custom system prompt for knowledge extraction. */
  prompt?: string;
}

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
  knowledge: KnowledgeConfig;
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
  knowledge: {
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    outputDir: '.contextberg/knowledge',
    maxSessionsPerCommit: 3,
  },
};

export const CONFIG_DIR = path.join(os.homedir(), '.agent-history');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export async function loadConfig(): Promise<AgentHistoryConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AgentHistoryConfig>;
    return {
      display: { ...CONFIG_DEFAULTS.display, ...parsed.display },
      mcp: { ...CONFIG_DEFAULTS.mcp, ...parsed.mcp },
      knowledge: { ...CONFIG_DEFAULTS.knowledge, ...parsed.knowledge },
    };
  } catch {
    return CONFIG_DEFAULTS;
  }
}

export async function saveConfig(config: AgentHistoryConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}
