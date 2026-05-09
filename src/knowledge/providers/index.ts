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
 * Codex / Responses API — direct fetch with SSE streaming.
 *
 * Why not the SDK: the chatgpt.com/backend-api/codex backend is Cloudflare-
 * fronted and rejects requests whose User-Agent / originator don't match an
 * allowed first-party originator. The OpenAI Node SDK injects its own
 * User-Agent that defaultHeaders cannot reliably override.
 *
 * Why streaming is mandatory: the backend returns
 *   400 {"detail":"Stream must be set to true"}
 * for non-streamed POSTs to /responses. Even a one-shot call must be SSE.
 *
 * Required request shape (verified against codex-rs CLI behavior):
 *   - Authorization: Bearer <oauth_access_token>
 *   - User-Agent:    codex_cli_rs/0.0.0 (Contextberg)   (allowlisted prefix)
 *   - originator:    codex_cli_rs                       (Cloudflare check)
 *   - ChatGPT-Account-ID: <chatgpt_account_id from JWT claim>
 *   - session_id, x-client-request-id: any opaque cache scope
 *   - Accept: text/event-stream
 *   - body.input:  LIST of message objects (string form is rejected with 400)
 *   - body.stream: true                                  (REQUIRED)
 *   - body MUST NOT contain max_output_tokens or temperature (400)
 */
async function callOpenAIResponses(input: ProviderCallInput): Promise<ProviderCallResult> {
  const customHeaders = input.profile.hooks?.buildHeaders?.(input.auth) ?? {};
  const baseURL = (input.auth.baseURL ?? input.profile.baseURL ?? '').replace(/\/$/, '');
  if (!baseURL) {
    throw new Error('Codex profile is missing baseURL');
  }

  const scopeId = `contextberg-${process.pid}-${Date.now()}`;

  const body: Record<string, unknown> = {
    model: input.model.id,
    instructions: input.systemPrompt,
    input: [{ role: 'user', content: input.userContent }],
    store: false,
    stream: true,
  };

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${input.auth.apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'session_id': scopeId,
    'x-client-request-id': scopeId,
    ...input.profile.defaultHeaders,
    ...customHeaders,
  };

  const url = `${baseURL}/responses`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseText = await res.text().catch(() => '');
    const cfMitigated = res.headers.get('cf-mitigated');
    const requestId = res.headers.get('x-request-id') ?? res.headers.get('cf-ray');
    const detail = [
      `${res.status} ${res.statusText}`,
      cfMitigated ? `cf-mitigated: ${cfMitigated}` : null,
      requestId ? `request-id: ${requestId}` : null,
      responseText ? `body: ${responseText.slice(0, 500)}` : '(empty body)',
    ].filter(Boolean).join(' | ');
    throw new Error(`Codex backend rejected request — ${detail}`);
  }

  if (!res.body) {
    throw new Error('Codex backend returned 200 OK but the response body is empty');
  }

  // Parse SSE: lines like `data: {json}` separated by blank lines, terminated
  // by `data: [DONE]` (OpenAI convention). We watch two complementary signals:
  //   - response.output_text.delta — incremental text chunks
  //   - response.completed         — final payload with the full output array
  // Either alone is enough; we accept whichever fills `text` first.
  let text = '';
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const evt of events) {
      const dataLines = evt
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = parsed['type'];
      if (type === 'response.output_text.delta' && typeof parsed['delta'] === 'string') {
        text += parsed['delta'];
      } else if (type === 'response.completed') {
        const response = parsed['response'];
        if (response && typeof response === 'object') {
          const output = (response as Record<string, unknown>)['output'];
          if (Array.isArray(output) && !text) {
            // Fallback: walk output[].content[].text when no deltas were seen.
            for (const item of output) {
              if (item && typeof item === 'object' && (item as { type?: string }).type === 'message') {
                const content = (item as { content?: unknown }).content;
                if (Array.isArray(content)) {
                  for (const c of content) {
                    if (c && typeof c === 'object' && (c as { type?: string }).type === 'output_text') {
                      const t = (c as { text?: string }).text;
                      if (typeof t === 'string') text += t;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

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
