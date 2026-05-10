import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type KnowledgeProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'codex'
  | 'opencode-go';

export interface KnowledgeConfig {
  enabled: boolean;
  provider: KnowledgeProvider;
  model: string;
  /**
   * Active provider's API key. Kept for backwards compatibility — new code
   * reads from `apiKeys[provider]` first and falls back to this field.
   * Each provider's env vars take priority over both:
   *   anthropic   → ANTHROPIC_API_KEY
   *   openai      → OPENAI_API_KEY
   *   google      → GEMINI_API_KEY / GOOGLE_API_KEY
   *   openrouter  → OPENROUTER_API_KEY
   *   codex       → device-code OAuth via `contextberg setup`
   *   opencode-go → OPENCODE_GO_API_KEY
   */
  apiKey?: string;
  /**
   * Per-provider API key cache. Lets the user switch the active provider
   * back and forth in `contextberg setup` without losing previously
   * entered keys for other providers. The active provider's value is
   * mirrored into `apiKey` so older readers keep working.
   */
  apiKeys?: Partial<Record<KnowledgeProvider, string>>;
  /** Path relative to repo root, or absolute. */
  outputDir: string;
  maxSessionsPerCommit: number;
  /** Custom system prompt for knowledge extraction. */
  prompt?: string;
  /** Hard cap on the prompt content sent to the provider. */
  maxPromptChars?: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
  /**
   * Absolute repo paths that the running viewer should watch for new commits.
   * `contextberg setup` adds the current repo here; the in-process commit
   * watcher (src/server/commit-watcher.ts) tails each repo's `.git/logs/HEAD`
   * and fires `runLearn` in the background when a new commit lands.
   *
   * Replaces the per-repo `.git/hooks/post-commit` mechanism: the LLM call no
   * longer blocks `git commit`, the viewer can push UI updates as soon as a
   * note is written, and there is one central list to manage instead of N
   * hook files scattered across repos.
   */
  watchedRepos?: string[];
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
    maxTurnsPerSession: 30,
    maxCharsPerField: 100_000,
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
    // Same generous ceiling for the response. clampMaxTokens() in the
    // transport pins this down to whatever the chosen model actually
    // supports (e.g. Claude Sonnet 4.5 → 8192) so a 100k cap on a model
    // with a smaller window simply becomes the model's own limit.
    maxOutputTokens: 100_000,
    watchedRepos: [],
  },
};

export const CONFIG_DIR = path.join(os.homedir(), '.agent-history');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export async function loadConfig(): Promise<AgentHistoryConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AgentHistoryConfig>;
    const knowledge: KnowledgeConfig = {
      ...CONFIG_DEFAULTS.knowledge,
      ...parsed.knowledge,
    };
    // Migration: bump configs that still hold a previous-generation default
    // to the current production value. Detection is exact-match against
    // every old default so explicit user customisations survive.
    if (knowledge.maxPromptChars === 18_000) knowledge.maxPromptChars = 400_000;
    if (knowledge.maxOutputTokens === 2048 || knowledge.maxOutputTokens === 4096) {
      knowledge.maxOutputTokens = 100_000;
    }
    if (knowledge.maxSessionsPerCommit === 3) knowledge.maxSessionsPerCommit = 5;

    // Back-compat: lift legacy single `apiKey` into the per-provider map so
    // the wizard sees it the next time the user switches providers and back.
    if (knowledge.apiKey && !knowledge.apiKeys?.[knowledge.provider]) {
      knowledge.apiKeys = { ...(knowledge.apiKeys ?? {}), [knowledge.provider]: knowledge.apiKey };
    }

    // Migration: previous defaults were too tight for real cross-agent
    // history reuse. Bump silently; explicit user choices survive.
    const mcp = { ...CONFIG_DEFAULTS.mcp, ...parsed.mcp };
    if (mcp.maxTurnsPerSession === 5) mcp.maxTurnsPerSession = 30;
    if (mcp.maxCharsPerField === 500 || mcp.maxCharsPerField === 2000) {
      mcp.maxCharsPerField = 100_000;
    }

    return {
      display: { ...CONFIG_DEFAULTS.display, ...parsed.display },
      mcp,
      knowledge,
    };
  } catch {
    return CONFIG_DEFAULTS;
  }
}

export async function saveConfig(config: AgentHistoryConfig): Promise<void> {
  // mode 0o700 / 0o600: config.json carries plaintext API keys, so restrict
  // both the directory and file to the owning user. Silent NOOP on Windows
  // (NTFS already isolates user dirs) and on container volume mounts where
  // chmod isn't permitted; the chmod() call is wrapped in try/catch so a
  // permission denial never breaks `contextberg setup`.
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    await fs.chmod(CONFIG_PATH, 0o600);
  } catch { /* Windows / read-only mount — defaults are good enough there */ }
}
