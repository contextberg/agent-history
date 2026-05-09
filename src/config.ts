import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type KnowledgeProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'codex';

export interface KnowledgeConfig {
  enabled: boolean;
  provider: KnowledgeProvider;
  model: string;
  /**
   * API key (plain text). Each provider's env vars take priority:
   *   anthropic  → ANTHROPIC_API_KEY
   *   openai     → OPENAI_API_KEY
   *   google     → GEMINI_API_KEY / GOOGLE_API_KEY
   *   openrouter → OPENROUTER_API_KEY
   *   codex      → device-code OAuth via `contextberg setup`
   */
  apiKey?: string;
  /** Path relative to repo root, or absolute. */
  outputDir: string;
  maxSessionsPerCommit: number;
  /** Custom system prompt for knowledge extraction. */
  prompt?: string;
  /** Hard cap on the prompt content sent to the provider. */
  maxPromptChars?: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
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
    model: 'claude-sonnet-4-5',
    outputDir: '.contextberg/knowledge',
    maxSessionsPerCommit: 5,
    // ~100k tokens of input — generous default that fits comfortably inside
    // ChatGPT-subscription quotas and any modern provider's context window.
    // Per-model caps still apply via callOpenAIChat / clampMaxTokens.
    maxPromptChars: 400_000,
    maxOutputTokens: 4096,
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
