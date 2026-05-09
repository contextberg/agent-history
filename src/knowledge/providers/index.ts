import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type {
  ProviderCallInput,
  ProviderCallResult,
  ProviderProfile,
  ResolvedAuth,
} from './types.js';

export { PROVIDER_PROFILES, getProfile, listProfiles, resolveProfile } from './registry.js';
export type {
  ProviderId,
  ProviderProfile,
  ModelEntry,
  ModelFamily,
  AuthType,
  Transport,
  ResolvedAuth,
  DetectedAuth,
  ProviderCallInput,
  ProviderCallResult,
} from './types.js';

/**
 * Resolve auth for a profile. Order:
 *   1. Any envVars (first non-empty wins)
 *   2. configApiKey (per-provider plain text from config.json)
 *   3. profile.hooks.detectAuth (e.g. ~/.codex/auth.json)
 *
 * authType=none short-circuits and returns an empty-key auth so local
 * providers (Ollama, LM Studio) skip the resolution entirely.
 */
export async function resolveAuth(
  profile: ProviderProfile,
  configApiKey: string | undefined,
): Promise<ResolvedAuth | null> {
  if (profile.authType === 'none') {
    return { apiKey: '', baseURL: profile.baseURL, source: 'none' };
  }

  for (const envVar of profile.envVars) {
    const v = process.env[envVar];
    if (v) return { apiKey: v, baseURL: profile.baseURL, source: `env:${envVar}` };
  }

  if (configApiKey) {
    return { apiKey: configApiKey, baseURL: profile.baseURL, source: 'config:apiKey' };
  }

  if (profile.hooks?.detectAuth) {
    const detected = await profile.hooks.detectAuth();
    if (detected) {
      const token = await detected.resolve();
      if (token) {
        return { apiKey: token, baseURL: profile.baseURL, source: `disk:${detected.label}` };
      }
    }
  }

  return null;
}

export async function callProvider(input: ProviderCallInput): Promise<ProviderCallResult> {
  switch (input.profile.transport) {
    case 'anthropic_messages':
      return callAnthropic(input);
    case 'openai_chat':
      return callOpenAIChat(input);
    case 'openai_responses':
      return callOpenAIResponses(input);
  }
}

function clampMaxTokens(input: ProviderCallInput): number {
  return Math.min(input.maxTokens, input.model.maxOutputTokens);
}

async function callAnthropic(input: ProviderCallInput): Promise<ProviderCallResult> {
  const headers = input.profile.hooks?.buildHeaders?.(input.auth) ?? {};
  const client = new Anthropic({
    apiKey: input.auth.apiKey,
    ...(input.auth.baseURL ? { baseURL: input.auth.baseURL } : {}),
    defaultHeaders: { ...input.profile.defaultHeaders, ...headers },
  });
  const msg = await client.messages.create({
    model: input.model.id,
    max_tokens: clampMaxTokens(input),
    system: input.systemPrompt,
    messages: [{ role: 'user', content: input.userContent }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, model: input.model.id, provider: input.profile.id };
}

async function callOpenAIChat(input: ProviderCallInput): Promise<ProviderCallResult> {
  const headers = input.profile.hooks?.buildHeaders?.(input.auth) ?? {};
  const client = new OpenAI({
    apiKey: input.auth.apiKey || 'sk-no-auth',  // OpenAI SDK requires a non-empty key even for local
    ...(input.auth.baseURL ? { baseURL: input.auth.baseURL } : {}),
    defaultHeaders: { ...input.profile.defaultHeaders, ...headers },
  });

  // Per-MODEL output-token param (o-series uses max_completion_tokens, etc.)
  const cap = clampMaxTokens(input);
  const tokenKwargs: Record<string, number> = { [input.model.outputTokenParam]: cap };

  let kwargs: Record<string, unknown> = {
    model: input.model.id,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userContent },
    ],
    ...tokenKwargs,
  };
  if (input.profile.fixedTemperature !== undefined && input.profile.fixedTemperature !== null) {
    kwargs['temperature'] = input.profile.fixedTemperature;
  }
  if (input.profile.hooks?.prepareRequest) {
    kwargs = input.profile.hooks.prepareRequest(kwargs);
  }

  // Use the typed SDK call after profile-driven kwargs build.
  const completion = await client.chat.completions.create(
    kwargs as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );
  const text = completion.choices[0]?.message?.content ?? '';
  return { text, model: input.model.id, provider: input.profile.id };
}

/**
 * Codex / Responses API. The Codex backend rejects max_output_tokens AND
 * temperature, so the profile's prepareRequest hook strips them. The
 * Cloudflare-bypass headers are supplied by buildHeaders.
 */
async function callOpenAIResponses(input: ProviderCallInput): Promise<ProviderCallResult> {
  const headers = input.profile.hooks?.buildHeaders?.(input.auth) ?? {};
  const client = new OpenAI({
    apiKey: input.auth.apiKey,
    ...(input.auth.baseURL ? { baseURL: input.auth.baseURL } : {}),
    defaultHeaders: { ...input.profile.defaultHeaders, ...headers },
  });

  let kwargs: Record<string, unknown> = {
    model: input.model.id,
    instructions: input.systemPrompt,
    input: input.userContent,
    max_output_tokens: clampMaxTokens(input),
    store: false,
  };
  if (input.profile.hooks?.prepareRequest) {
    kwargs = input.profile.hooks.prepareRequest(kwargs);
  }

  const response = await client.responses.create(
    kwargs as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
  );
  const text = response.output_text ?? '';
  return { text, model: input.model.id, provider: input.profile.id };
}

/** First fallback model (recommended preferred). */
export function defaultModelFor(profile: ProviderProfile) {
  return profile.fallbackModels.find((m) => m.recommended) ?? profile.fallbackModels[0]!;
}

/** Find a ModelEntry by id, falling back to a synthetic chat entry. */
export function findModel(profile: ProviderProfile, id: string) {
  const found = profile.fallbackModels.find((m) => m.id === id);
  if (found) return found;
  // Live-fetched models won't be in fallbackModels — synthesise sensible defaults.
  return {
    id,
    family: 'chat' as const,
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    outputTokenParam: 'max_tokens' as const,
  };
}
