import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ProviderCallInput, ProviderCallResult, ProviderOverlay } from './types.js';
import { getOverlay } from './registry.js';

export { PROVIDER_OVERLAYS, getOverlay, listProviders } from './registry.js';
export type { ProviderId, ProviderOverlay, Transport } from './types.js';

/**
 * Resolve the API key for a provider. Resolution order:
 *   1. Provider-specific env var (e.g. ANTHROPIC_API_KEY)
 *   2. config.apiKey (per-provider plain text)
 *   3. Disk-stored OAuth token (Codex CLI only)
 */
export async function resolveAuth(
  overlay: ProviderOverlay,
  configApiKey: string | undefined,
): Promise<{ apiKey: string; baseURL: string | undefined } | null> {
  const fromEnv = process.env[overlay.apiKeyEnv];
  if (fromEnv) return { apiKey: fromEnv, baseURL: overlay.baseURL };
  if (configApiKey) return { apiKey: configApiKey, baseURL: overlay.baseURL };
  if (overlay.resolveTokenFromDisk) {
    const token = await overlay.resolveTokenFromDisk();
    if (token) return { apiKey: token, baseURL: overlay.baseURL };
  }
  return null;
}

export async function callProvider(input: ProviderCallInput): Promise<ProviderCallResult> {
  switch (input.overlay.transport) {
    case 'anthropic_messages':
      return callAnthropic(input);
    case 'openai_chat':
      return callOpenAIChat(input);
    case 'openai_responses':
      return callOpenAIResponses(input);
  }
}

async function callAnthropic(input: ProviderCallInput): Promise<ProviderCallResult> {
  const client = new Anthropic({
    apiKey: input.apiKey,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
  });
  const msg = await client.messages.create({
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.systemPrompt,
    messages: [{ role: 'user', content: input.userContent }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, model: input.model, provider: input.overlay.id };
}

async function callOpenAIChat(input: ProviderCallInput): Promise<ProviderCallResult> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
  });
  const completion = await client.chat.completions.create({
    model: input.model,
    max_tokens: input.maxTokens,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userContent },
    ],
  });
  const text = completion.choices[0]?.message?.content ?? '';
  return { text, model: input.model, provider: input.overlay.id };
}

/**
 * Codex / Responses API path. We use the OpenAI SDK's `responses` endpoint;
 * the base URL is the same OpenAI v1 endpoint, but the auth header is the
 * Codex OAuth token when CODEX_API_KEY is unset.
 */
async function callOpenAIResponses(input: ProviderCallInput): Promise<ProviderCallResult> {
  const client = new OpenAI({
    apiKey: input.apiKey,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
  });
  const response = await client.responses.create({
    model: input.model,
    max_output_tokens: input.maxTokens,
    instructions: input.systemPrompt,
    input: input.userContent,
  });
  const text = response.output_text ?? '';
  return { text, model: input.model, provider: input.overlay.id };
}

export function defaultModelFor(providerId: Parameters<typeof getOverlay>[0]): string {
  return getOverlay(providerId).models[0]!;
}
