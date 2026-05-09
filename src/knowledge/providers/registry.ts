import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DetectedAuth, ModelEntry, ProviderHooks, ProviderId, ProviderProfile, ResolvedAuth } from './types.js';

/**
 * Hermes-style provider profiles. Each profile is fully declarative — the
 * transport reads `outputTokenParam`, `defaultHeaders`, and the optional hooks
 * instead of branching on `provider.id`.
 *
 * v1 ships nine profiles:
 *   Core API key  — anthropic, openai, google, openrouter
 *   Core OAuth    — codex (~/.codex/auth.json)
 *   Local         — ollama, lmstudio
 *   Optional      — deepseek, xai
 */

// ── Codex helpers (Hermes-confirmed) ───────────────────────────────────────
// Reference: reference/agent/auxiliary_client.py:_codex_cloudflare_headers
//            reference/hermes_cli/codex_models.py
//            reference/agent/credential_pool.py:1380-1395

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

function decodeJwtAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1]!;
    const padded = payload + '='.repeat((-payload.length) & 3);
    const json = Buffer.from(padded, 'base64url').toString('utf-8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object') {
      const id = (auth as Record<string, unknown>)['chatgpt_account_id'];
      if (typeof id === 'string' && id) return id;
    }
  } catch {
    /* malformed token — caller still gets a 401 instead of a crash */
  }
  return null;
}

function codexHeaders(auth: ResolvedAuth): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'codex_cli_rs/0.0.0 (Contextberg)',
    'originator': 'codex_cli_rs',
  };
  const acctId = decodeJwtAccountId(auth.apiKey);
  if (acctId) headers['ChatGPT-Account-ID'] = acctId;
  return headers;
}

const codexHooks: ProviderHooks = {
  buildHeaders: codexHeaders,
  prepareRequest: (kwargs) => {
    // chatgpt.com/backend-api/codex rejects max_output_tokens AND temperature
    // with 400 — strip them defensively even if the transport sets them.
    const out = { ...kwargs };
    delete out['max_output_tokens'];
    delete out['max_tokens'];
    delete out['max_completion_tokens'];
    delete out['temperature'];
    return out;
  },
  detectAuth: async () => {
    const candidates = [path.join(os.homedir(), '.codex', 'auth.json')];
    for (const file of candidates) {
      try {
        const raw = await fs.readFile(file, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const tokens = data['tokens'];
        const access =
          (tokens && typeof tokens === 'object'
            ? (tokens as Record<string, unknown>)['access_token']
            : undefined) ?? data['OPENAI_API_KEY'];
        if (typeof access === 'string' && access) {
          const detected: DetectedAuth = {
            source: 'codex_cli',
            label: file.replace(os.homedir(), '~'),
            resolve: async () => access,
          };
          return detected;
        }
      } catch { /* try next */ }
    }
    return null;
  },
};

// ── Live model fetchers (used by hooks.fetchModels) ────────────────────────

async function fetchOpenAIModels(auth: ResolvedAuth | null, baseURL: string): Promise<string[] | null> {
  if (!auth) return null;
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${auth.apiKey}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  } catch {
    return null;
  }
}

async function fetchOllamaModels(): Promise<string[] | null> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
  } catch {
    return null;
  }
}

async function fetchLmstudioModels(): Promise<string[] | null> {
  try {
    const res = await fetch('http://localhost:1234/v1/models');
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  } catch {
    return null;
  }
}

async function fetchCodexModels(auth: ResolvedAuth | null): Promise<string[] | null> {
  if (!auth) return null;
  try {
    const res = await fetch(`${CODEX_BASE_URL}/models?client_version=1.0.0`, {
      headers: { Authorization: `Bearer ${auth.apiKey}`, ...codexHeaders(auth) },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      models?: Array<{ slug?: string; supported_in_api?: boolean; visibility?: string; priority?: number }>;
    };
    const filtered = (data.models ?? [])
      .filter((m) => m.supported_in_api !== false)
      .filter((m) => !['hide', 'hidden'].includes((m.visibility ?? '').toLowerCase()))
      .filter((m): m is { slug: string; priority?: number } => typeof m.slug === 'string' && !!m.slug)
      .sort((a, b) => (a.priority ?? 10000) - (b.priority ?? 10000));
    return filtered.map((m) => m.slug);
  } catch {
    return null;
  }
}

async function fetchOpenRouterModels(): Promise<string[] | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  } catch {
    return null;
  }
}

// ── Model catalogs (fallback when live fetch fails) ────────────────────────
// `outputTokenParam` is per-MODEL because it varies within a provider:
// OpenAI gpt-4o uses max_tokens, o-series uses max_completion_tokens.

const m = (
  id: string,
  contextWindow: number,
  maxOutputTokens: number,
  outputTokenParam: ModelEntry['outputTokenParam'] = 'max_tokens',
  family: ModelEntry['family'] = 'chat',
  recommended = false,
): ModelEntry => ({ id, family, contextWindow, maxOutputTokens, outputTokenParam, recommended });

// ── Profiles ───────────────────────────────────────────────────────────────

const PROFILES: Record<ProviderId, ProviderProfile> = {
  anthropic: {
    id: 'anthropic',
    name: 'anthropic',
    displayName: 'Anthropic (Claude)',
    description: 'Claude API — direct from Anthropic',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    transport: 'anthropic_messages',
    authType: 'api_key',
    envVars: ['ANTHROPIC_API_KEY'],
    fallbackModels: [
      m('claude-sonnet-4-5', 200_000, 8192, 'max_tokens', 'chat', true),
      m('claude-opus-4-5', 200_000, 8192, 'max_tokens', 'chat'),
      m('claude-haiku-4-5', 200_000, 8192, 'max_tokens', 'chat'),
    ],
  },

  openai: {
    id: 'openai',
    name: 'openai',
    displayName: 'OpenAI',
    description: 'OpenAI API — direct',
    signupUrl: 'https://platform.openai.com/api-keys',
    transport: 'openai_chat',
    authType: 'api_key',
    envVars: ['OPENAI_API_KEY'],
    baseURL: 'https://api.openai.com/v1',
    fallbackModels: [
      m('gpt-4o', 128_000, 16_384, 'max_tokens', 'chat', true),
      m('gpt-4o-mini', 128_000, 16_384, 'max_tokens', 'chat'),
      m('o3-mini', 200_000, 100_000, 'max_completion_tokens', 'reasoning'),
    ],
    hooks: {
      fetchModels: (auth) => fetchOpenAIModels(auth, 'https://api.openai.com/v1'),
    },
  },

  google: {
    id: 'google',
    name: 'google',
    aliases: ['gemini', 'google-ai-studio'],
    displayName: 'Google (Gemini API key)',
    description: 'Gemini via the OpenAI-compatible endpoint',
    signupUrl: 'https://aistudio.google.com/apikey',
    transport: 'openai_chat',
    authType: 'api_key',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    fallbackModels: [
      m('gemini-2.5-pro', 2_000_000, 8192, 'max_tokens', 'chat', true),
      m('gemini-2.5-flash', 1_000_000, 8192, 'max_tokens', 'chat'),
      m('gemini-2.5-flash-lite', 1_000_000, 8192, 'max_tokens', 'chat'),
    ],
  },

  openrouter: {
    id: 'openrouter',
    name: 'openrouter',
    aliases: ['or'],
    displayName: 'OpenRouter',
    description: '200+ models behind one API key',
    signupUrl: 'https://openrouter.ai/keys',
    transport: 'openai_chat',
    authType: 'api_key',
    envVars: ['OPENROUTER_API_KEY'],
    baseURL: 'https://openrouter.ai/api/v1',
    modelsURL: 'https://openrouter.ai/api/v1/models',
    fallbackModels: [
      m('anthropic/claude-sonnet-4.5', 200_000, 8192, 'max_tokens', 'chat', true),
      m('openai/gpt-4o', 128_000, 16_384, 'max_tokens', 'chat'),
      m('google/gemini-2.5-flash', 1_000_000, 8192, 'max_tokens', 'chat'),
      m('deepseek/deepseek-chat', 64_000, 8192, 'max_tokens', 'chat'),
    ],
    hooks: { fetchModels: () => fetchOpenRouterModels() },
  },

  codex: {
    id: 'codex',
    name: 'codex',
    aliases: ['openai-codex', 'chatgpt'],
    displayName: 'Codex (ChatGPT subscription)',
    description: 'OpenAI Codex via ~/.codex/auth.json OAuth',
    signupUrl: 'https://chatgpt.com/codex',
    transport: 'openai_responses',
    authType: 'oauth_disk',
    envVars: ['CODEX_API_KEY'],
    baseURL: CODEX_BASE_URL,
    fallbackModels: [
      // Codex slugs drift fast — keep this short and rely on live fetch.
      m('gpt-5-codex', 200_000, 16_384, 'max_output_tokens', 'reasoning', true),
      m('gpt-5', 200_000, 16_384, 'max_output_tokens', 'reasoning'),
    ],
    hooks: { ...codexHooks, fetchModels: (auth) => fetchCodexModels(auth) },
  },

  ollama: {
    id: 'ollama',
    name: 'ollama',
    displayName: 'Ollama (local)',
    description: 'Local models via Ollama (no auth required)',
    signupUrl: 'https://ollama.com/download',
    transport: 'openai_chat',
    authType: 'none',
    envVars: [],
    baseURL: 'http://localhost:11434/v1',
    fallbackModels: [
      m('llama3.1:8b', 128_000, 4096, 'max_tokens', 'chat', true),
      m('qwen2.5-coder:7b', 32_000, 4096, 'max_tokens', 'code'),
    ],
    hooks: { fetchModels: () => fetchOllamaModels() },
  },

  lmstudio: {
    id: 'lmstudio',
    name: 'lmstudio',
    aliases: ['lm-studio'],
    displayName: 'LM Studio (local)',
    description: 'Local models via LM Studio (no auth required)',
    signupUrl: 'https://lmstudio.ai',
    transport: 'openai_chat',
    authType: 'none',
    envVars: [],
    baseURL: 'http://localhost:1234/v1',
    fallbackModels: [
      // LM Studio model IDs depend entirely on what the user loaded — fall back fetch
      m('local-model', 32_000, 4096, 'max_tokens', 'chat', true),
    ],
    hooks: { fetchModels: () => fetchLmstudioModels() },
  },

  deepseek: {
    id: 'deepseek',
    name: 'deepseek',
    displayName: 'DeepSeek',
    description: 'DeepSeek API — strong reasoning at low cost',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    transport: 'openai_chat',
    authType: 'api_key',
    envVars: ['DEEPSEEK_API_KEY'],
    baseURL: 'https://api.deepseek.com/v1',
    fallbackModels: [
      m('deepseek-chat', 64_000, 8192, 'max_tokens', 'chat', true),
      m('deepseek-reasoner', 64_000, 8192, 'max_tokens', 'reasoning'),
    ],
    hooks: {
      fetchModels: (auth) => fetchOpenAIModels(auth, 'https://api.deepseek.com/v1'),
    },
  },

  xai: {
    id: 'xai',
    name: 'xai',
    aliases: ['grok'],
    displayName: 'xAI (Grok)',
    description: 'Grok API from xAI',
    signupUrl: 'https://console.x.ai',
    transport: 'openai_chat',
    authType: 'api_key',
    envVars: ['XAI_API_KEY'],
    baseURL: 'https://api.x.ai/v1',
    fallbackModels: [
      m('grok-2-latest', 131_072, 8192, 'max_tokens', 'chat', true),
    ],
    hooks: {
      fetchModels: (auth) => fetchOpenAIModels(auth, 'https://api.x.ai/v1'),
    },
  },
};

export const PROVIDER_PROFILES = PROFILES;

export function getProfile(id: ProviderId): ProviderProfile {
  return PROFILES[id];
}

export function listProfiles(): ProviderProfile[] {
  return Object.values(PROFILES);
}

/**
 * Resolve a profile from a name OR alias. Used when reading user config so
 * `provider: "or"` resolves to OpenRouter without a hard-coded mapping.
 */
export function resolveProfile(nameOrAlias: string): ProviderProfile | undefined {
  const direct = PROFILES[nameOrAlias as ProviderId];
  if (direct) return direct;
  for (const profile of Object.values(PROFILES)) {
    if (profile.aliases?.includes(nameOrAlias)) return profile;
  }
  return undefined;
}
