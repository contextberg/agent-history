/**
 * Provider profile system inspired by Hermes Agent's ProviderProfile.
 * Each profile is declarative — describes auth, endpoint, transport quirks,
 * and model catalog in one dataclass-like object. Adding a provider = one entry.
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'codex'
  | 'opencode-go';

export type Transport = 'anthropic_messages' | 'openai_chat' | 'openai_responses';

/**
 * How the provider is authenticated.
 *   api_key       — env var or user-entered key (most providers)
 *   none          — local providers (ollama, lmstudio)
 *   oauth_disk    — token read from a file on disk (codex: ~/.codex/auth.json)
 */
export type AuthType = 'api_key' | 'none' | 'oauth_disk';

/** Model family — determines request-shape defaults. */
export type ModelFamily = 'reasoning' | 'chat' | 'code';

/** Which output-token parameter name this model expects. */
export type OutputTokenParam =
  | 'max_tokens'
  | 'max_completion_tokens'
  | 'max_output_tokens';

export interface ModelEntry {
  id: string;
  family: ModelFamily;
  /** Approximate context window in tokens — used to size prompt cap. */
  contextWindow: number;
  /** Hard cap on output tokens for this model. */
  maxOutputTokens: number;
  /** Output-token param name (varies by model, not just provider). */
  outputTokenParam: OutputTokenParam;
  recommended?: boolean;
  /** Free-form note shown next to the model in the wizard ("subscription only" etc.). */
  notes?: string;
}

/**
 * Auth detection result. Returned by ProviderProfile.detectAuth() when a
 * known credential file is found on disk (e.g. ~/.codex/auth.json).
 */
export interface DetectedAuth {
  /** Stable identifier for the source ("codex_cli", "claude_credentials"). */
  source: string;
  /** Human-readable label shown in the wizard ("~/.codex/auth.json"). */
  label: string;
  /** Resolver that returns a usable token string at call time. */
  resolve: () => Promise<string | null>;
}

/**
 * Optional per-provider request-shape hooks. Default implementations live in
 * the transport layer; profiles override only what's unusual.
 */
export interface ProviderHooks {
  /** Build extra HTTP headers for every request (Codex: Cloudflare bypass). */
  buildHeaders?: (auth: ResolvedAuth) => Record<string, string>;
  /** Mutate request kwargs just before the call (Codex: drop max_tokens/temperature). */
  prepareRequest?: (kwargs: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Live-fetch model IDs from the provider's catalog endpoint. THROWS on
   * failure so the wizard can surface the real reason (HTTP status, API
   * error message) instead of silently falling back. A successful fetch
   * may legitimately return `[]` (account has zero matching models), which
   * the wizard treats as "use fallbacks" without an error message.
   */
  fetchModels?: (auth: ResolvedAuth | null) => Promise<string[]>;
  /** Detect existing on-disk credentials before prompting the user. */
  detectAuth?: () => Promise<DetectedAuth | null>;
  /**
   * Run an interactive sign-in flow when no credentials exist (e.g. Codex
   * device-code OAuth). Prints URL+code to stdout and waits for the user.
   * Returns the resulting bearer token. The hook is responsible for
   * persisting the credential so detectAuth picks it up next time.
   */
  interactiveAuth?: () => Promise<string | null>;
}

export interface ProviderProfile {
  id: ProviderId;
  /** Short technical name ("openai", "openrouter") — matches id but kept for parity with Hermes. */
  name: string;
  /** Comma-aliases accepted at config time ("or" → "openrouter"). */
  aliases?: string[];

  // ── Display ────────────────────────────────────────────────
  displayName: string;
  description: string;
  signupUrl?: string;

  // ── Transport & auth ──────────────────────────────────────
  transport: Transport;
  authType: AuthType;
  /** Env vars checked in order. First non-empty wins. Empty for none/oauth_disk. */
  envVars: string[];
  /** Base URL (omit for SDK default — Anthropic / OpenAI proper). */
  baseURL?: string;
  /** Models endpoint URL — defaults to {baseURL}/models when fetchModels uses base impl. */
  modelsURL?: string;
  /** Hostname for URL-based provider detection (defaults to baseURL hostname). */
  hostname?: string;

  // ── Request-level defaults ─────────────────────────────────
  /** Headers attached to every client (in addition to per-request buildHeaders). */
  defaultHeaders?: Record<string, string>;
  /** If set, transport uses this temperature; if explicitly null, transport omits temperature entirely. */
  fixedTemperature?: number | null;
  /** Provider-wide default for max output tokens (overridden by ModelEntry.maxOutputTokens). */
  defaultMaxTokens?: number;

  // ── Model catalog ──────────────────────────────────────────
  /** Static fallback list shown when fetchModels returns null. First entry is the default. */
  fallbackModels: ModelEntry[];

  // ── Hooks ──────────────────────────────────────────────────
  hooks?: ProviderHooks;
}

export interface ResolvedAuth {
  /** Bearer token / API key. Empty string for authType=none. */
  apiKey: string;
  baseURL: string | undefined;
  /** Source label for diagnostics ("env:OPENAI_API_KEY", "disk:~/.codex/auth.json"). */
  source: string;
}

export interface ProviderCallInput {
  profile: ProviderProfile;
  model: ModelEntry;
  systemPrompt: string;
  userContent: string;
  auth: ResolvedAuth;
  /** Caller's requested max output tokens — clamped against model.maxOutputTokens. */
  maxTokens: number;
}

export interface ProviderCallResult {
  text: string;
  model: string;
  provider: ProviderId;
}
