import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ProviderId, ProviderOverlay } from './types.js';

/**
 * Hermes-style overlays: each provider declares transport + auth + base URL +
 * default model list. Adding a new provider = one more entry here.
 */
export const PROVIDER_OVERLAYS: Record<ProviderId, ProviderOverlay> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic (Claude)',
    transport: 'anthropic_messages',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-haiku-4-5-20251001',
    ],
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI (API key)',
    transport: 'openai_chat',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      'gpt-5',
      'gpt-5-mini',
      'o4',
      'o4-mini',
      'gpt-4o',
      'gpt-4o-mini',
    ],
  },
  google: {
    id: 'google',
    displayName: 'Google (Gemini)',
    transport: 'openai_chat',
    apiKeyEnv: 'GEMINI_API_KEY',
    // Gemini exposes an OpenAI-compatible endpoint we can hit with the OpenAI SDK.
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
  },
  codex: {
    id: 'codex',
    displayName: 'Codex (ChatGPT subscription)',
    transport: 'openai_responses',
    apiKeyEnv: 'CODEX_API_KEY',
    // Codex CLI talks to the Responses API. Auth comes from ~/.codex/auth.json
    // (OAuth) when CODEX_API_KEY is not set.
    baseURL: 'https://api.openai.com/v1/',
    models: [
      'gpt-5-codex',
      'gpt-5',
    ],
    resolveTokenFromDisk: async () => {
      const candidates = [
        path.join(os.homedir(), '.codex', 'auth.json'),
      ];
      for (const file of candidates) {
        try {
          const raw = await fs.readFile(file, 'utf-8');
          const data = JSON.parse(raw) as Record<string, unknown>;
          // Codex CLI shape: { OPENAI_API_KEY?: string, tokens?: { access_token?: string } }
          if (typeof data['OPENAI_API_KEY'] === 'string' && data['OPENAI_API_KEY']) {
            return data['OPENAI_API_KEY'];
          }
          const tokens = data['tokens'];
          if (tokens && typeof tokens === 'object') {
            const access = (tokens as Record<string, unknown>)['access_token'];
            if (typeof access === 'string' && access) return access;
          }
        } catch {
          // try next candidate
        }
      }
      return null;
    },
  },
};

export function getOverlay(id: ProviderId): ProviderOverlay {
  return PROVIDER_OVERLAYS[id];
}

export function listProviders(): ProviderOverlay[] {
  return Object.values(PROVIDER_OVERLAYS);
}
