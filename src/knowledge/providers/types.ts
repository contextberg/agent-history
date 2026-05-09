export type ProviderId = 'anthropic' | 'openai' | 'google' | 'codex';

export type Transport = 'anthropic_messages' | 'openai_chat' | 'openai_responses';

export interface ProviderOverlay {
  id: ProviderId;
  displayName: string;
  transport: Transport;
  /** Default models exposed in the setup wizard. First entry is the default. */
  models: string[];
  /** Env var that holds the API key. */
  apiKeyEnv: string;
  /** Optional base URL override (Gemini OpenAI-compat, Codex backend, …). */
  baseURL?: string;
  /**
   * Optional auth resolver beyond env / config.apiKey — used by Codex to read
   * a stored OAuth token from disk. Returns null if not available.
   */
  resolveTokenFromDisk?: () => Promise<string | null>;
}

export interface ResolvedAuth {
  apiKey: string;
  baseURL: string | undefined;
}

export interface ProviderCallInput {
  overlay: ProviderOverlay;
  model: string;
  systemPrompt: string;
  userContent: string;
  apiKey: string;
  baseURL: string | undefined;
  maxTokens: number;
}

export interface ProviderCallResult {
  text: string;
  model: string;
  provider: ProviderId;
}
