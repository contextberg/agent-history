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
 *   Core OAuth    — codex (~/.agent-history/codex-auth.json)
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
  // No prepareRequest needed — the Codex transport (callOpenAIResponses) hits
  // the backend with a bespoke fetch and never sends max_output_tokens or
  // temperature in the first place.
  detectAuth: async () => {
    // Read ONLY our own credential file. Reading another application's
    // ~/.codex/auth.json crosses a trust boundary the user didn't consent
    // to, and would race the upstream Codex CLI on refresh_token rotation
    // (single-use tokens — sharing causes refresh_token_reused failures).
    // If the user wants Codex auth, they run `contextberg setup` which
    // triggers our own device-code flow (interactiveAuth) and persists to
    // ~/.agent-history/codex-auth.json.
    const file = path.join(os.homedir(), '.agent-history', 'codex-auth.json');
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const tokens = data['tokens'];
      const access =
        tokens && typeof tokens === 'object'
          ? (tokens as Record<string, unknown>)['access_token']
          : undefined;
      if (typeof access === 'string' && access) {
        const detected: DetectedAuth = {
          source: 'contextberg_oauth',
          label: '~/.agent-history/codex-auth.json',
          resolve: async () => access,
        };
        return detected;
      }
    } catch { /* no credential yet */ }
    return null;
  },
  interactiveAuth: async () => {
    // Lazy-import the OAuth helper so the registry stays free of node:fs at
    // module init time (matters for the MCP entry point that doesn't need it).
    const { runCodexDeviceCodeLogin } = await import('../../setup/codex-oauth.js');
    const creds = await runCodexDeviceCodeLogin();
    return creds.tokens.access_token;
  },
};

// ── Live model fetchers (used by hooks.fetchModels) ────────────────────────

/**
 * OpenAI's /models endpoint returns the full catalog: embeddings, whisper,
 * TTS, DALL-E, moderation, instruct-completion legacy models, audio /
 * realtime variants, etc. The setup wizard only cares about chat-completion
 * text models, so apply an allowlist + denylist before sorting by relevance.
 */
function isOpenAIChatModel(id: string): boolean {
  const denyPrefix = [
    'text-embedding-', 'whisper-', 'tts-', 'dall-e-',
    'davinci', 'babbage', 'omni-', 'text-moderation',
    'computer-use-', 'codex-mini-',
  ];
  if (denyPrefix.some((p) => id.startsWith(p))) return false;
  if (/-(audio|realtime|tts|search|transcribe|moderation|image|embedding)\b/.test(id)) return false;
  if (/-instruct(\b|-)/.test(id)) return false;
  // Allow conventional chat / reasoning model families.
  return /^(gpt-\d|o\d|chatgpt-)/.test(id);
}

/** Rank chat models so the most useful (newest flagship first) bubble up. */
function rankOpenAIChatModel(id: string): number {
  if (id.startsWith('gpt-5')) return 0;
  if (id.startsWith('o4')) return 5;
  if (id === 'gpt-4o') return 10;
  if (id.startsWith('gpt-4o-mini')) return 15;
  if (id.startsWith('gpt-4o')) return 20;
  if (id.startsWith('o3')) return 25;
  if (id.startsWith('o1')) return 30;
  if (id.startsWith('gpt-4-turbo')) return 40;
  if (id.startsWith('gpt-4')) return 50;
  if (id.startsWith('chatgpt-')) return 60;
  if (id.startsWith('gpt-3.5')) return 70;
  return 100;
}

/**
 * Format an HTTP error into something the wizard can show the user
 * verbatim. Includes status, status text, and the first chunk of the body
 * so 401 "API key not valid" type messages reach the surface instead of
 * dying silently.
 */
async function httpFail(res: Response, label: string): Promise<never> {
  let body = '';
  try {
    body = await res.text();
  } catch { /* ignore */ }
  // Trim a typical Google error JSON down to its message field if present.
  let trimmed = body.slice(0, 240);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) trimmed = parsed.error.message;
  } catch { /* not JSON, use raw */ }
  throw new Error(`${label}: HTTP ${res.status} ${res.statusText}${trimmed ? ` — ${trimmed}` : ''}`);
}

/**
 * Generic /models fetcher for OpenAI-compatible endpoints — returns every
 * id verbatim. The OpenAI profile wraps this with isOpenAIChatModel filter
 * + ranking; OpenCode Go and similar curated catalogs use it raw.
 */
async function fetchOpenAICompatModels(auth: ResolvedAuth | null, baseURL: string, label: string): Promise<string[]> {
  if (!auth || !auth.apiKey) throw new Error('no API key configured');
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${auth.apiKey}` },
  });
  if (!res.ok) await httpFail(res, `${label} /models`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * OpenAI's catalog is the kitchen sink (embeddings, audio, image…), so apply
 * the chat-model allowlist + relevance ranking on top of the generic fetch.
 */
async function fetchOpenAIModels(auth: ResolvedAuth | null): Promise<string[]> {
  const all = await fetchOpenAICompatModels(auth, 'https://api.openai.com/v1', 'OpenAI');
  return all
    .filter(isOpenAIChatModel)
    .sort((a, b) => rankOpenAIChatModel(a) - rankOpenAIChatModel(b) || a.localeCompare(b));
}

async function fetchGeminiModels(auth: ResolvedAuth | null): Promise<string[]> {
  if (!auth || !auth.apiKey) throw new Error('no API key configured');
  // Native listing endpoint — exposes supportedGenerationMethods which the
  // /openai/ compat path doesn't.
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(auth.apiKey)}&pageSize=200`;
  const res = await fetch(url);
  if (!res.ok) await httpFail(res, 'Gemini /models');
  const data = (await res.json()) as {
    models?: Array<{
      name?: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  return (data.models ?? [])
    .filter((mObj) => mObj.supportedGenerationMethods?.includes('generateContent'))
    .map((mObj) => mObj.name?.replace(/^models\//, ''))
    .filter((id): id is string => !!id && id.startsWith('gemini-'))
    .filter((id) => !/-\d{3}$/.test(id))
    .sort((a, b) => b.localeCompare(a));
}

async function fetchCodexModels(auth: ResolvedAuth | null): Promise<string[]> {
  if (!auth || !auth.apiKey) throw new Error('no auth — sign in via setup');
  const res = await fetch(`${CODEX_BASE_URL}/models?client_version=1.0.0`, {
    headers: { Authorization: `Bearer ${auth.apiKey}`, ...codexHeaders(auth) },
  });
  if (!res.ok) await httpFail(res, 'Codex /models');
  const data = (await res.json()) as {
    models?: Array<{ slug?: string; supported_in_api?: boolean; visibility?: string; priority?: number }>;
  };
  return (data.models ?? [])
    .filter((mm) => mm.supported_in_api !== false)
    .filter((mm) => !['hide', 'hidden'].includes((mm.visibility ?? '').toLowerCase()))
    .filter((mm): mm is { slug: string; priority?: number } => typeof mm.slug === 'string' && !!mm.slug)
    .sort((a, b) => (a.priority ?? 10000) - (b.priority ?? 10000))
    .map((mm) => mm.slug);
}

async function fetchOpenRouterModels(): Promise<string[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) await httpFail(res, 'OpenRouter /models');
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
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
  codex: {
    id: 'codex',
    name: 'codex',
    aliases: ['openai-codex', 'chatgpt'],
    displayName: 'Codex (ChatGPT subscription)',
    description: 'OpenAI Codex via Contextberg-owned OAuth',
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
    hooks: { fetchModels: (auth) => fetchGeminiModels(auth) },
  },

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
    hooks: { fetchModels: (auth) => fetchOpenAIModels(auth) },
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

  // OpenCode Go — $10/mo subscription that fronts a basket of "open" models
  // (GLM, Kimi, MiMo, Qwen, MiniMax). Reference: hermes_cli/auth.py,
  // hermes_cli/models.py, plugins/model-providers/opencode-zen/__init__.py.
  // Note: MiniMax models on this endpoint use Anthropic Messages format
  // (served at /v1/messages by the upstream); we use chat_completions which
  // covers GLM / Kimi / MiMo / Qwen. MiniMax entries appear in the fallback
  // list but require an upstream that exposes them via /chat/completions.
  'opencode-go': {
    id: 'opencode-go',
    name: 'opencode-go',
    aliases: ['opencode_go', 'opencode-go-sub'],
    displayName: 'OpenCode Go ($10/mo)',
    description: 'Open-model subscription (GLM, Kimi, MiMo, Qwen, MiniMax)',
    signupUrl: 'https://opencode.ai',
    transport: 'openai_chat',
    authType: 'api_key',
    envVars: ['OPENCODE_GO_API_KEY'],
    baseURL: 'https://opencode.ai/zen/go/v1',
    fallbackModels: [
      m('glm-5', 128_000, 8192, 'max_tokens', 'chat', true),
      m('glm-5.1', 128_000, 8192, 'max_tokens', 'chat'),
      m('kimi-k2.5', 200_000, 8192, 'max_tokens', 'chat'),
      m('kimi-k2.6', 200_000, 8192, 'max_tokens', 'chat'),
      m('mimo-v2.5-pro', 128_000, 8192, 'max_tokens', 'chat'),
      m('mimo-v2.5', 128_000, 8192, 'max_tokens', 'chat'),
      m('qwen3.6-plus', 128_000, 8192, 'max_tokens', 'chat'),
      m('qwen3.5-plus', 128_000, 8192, 'max_tokens', 'chat'),
    ],
    hooks: {
      fetchModels: (auth) => fetchOpenAICompatModels(auth, 'https://opencode.ai/zen/go/v1', 'OpenCode Go'),
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
