import type { KnowledgeConfig, KnowledgeProvider } from '../config.js';
import { listProfiles, getProfile } from '../knowledge/providers/index.js';
import type { ProviderProfile } from '../knowledge/providers/index.js';
import {
  createInterface,
  isInteractiveStdin,
  printHeader,
  printNonInteractiveGuidance,
  prompt,
  promptApiKey,
  promptChoice,
  promptYesNo,
  type RL,
} from './prompts.js';

export interface WizardResult {
  provider: KnowledgeProvider;
  model: string;
  apiKey: string | undefined;
  outputDir: string;
  maxSessionsPerCommit: number;
  maxPromptChars: number;
  maxOutputTokens: number;
}

export interface WizardOptions {
  /** Existing config — its values become defaults so re-running setup is non-destructive. */
  current?: KnowledgeConfig;
}

interface AuthOutcome {
  /** Saved into config when present (api_key providers only). */
  apiKey: string | undefined;
  /** Used by the wizard right now to live-fetch model lists. Not persisted. */
  liveToken: string | undefined;
}

/**
 * Hermes-style auth UX (mirrors hermes_cli/setup.py:_prompt_api_key
 * and hermes_cli/auth.py:_codex_device_code_login):
 *   - api_key providers     → print signup URL as plain text + prompt for the key
 *   - oauth_disk providers  → if the profile has interactiveAuth, run it
 *                             (device code flow prints URL+code in terminal),
 *                             otherwise fall back to the on-disk-CLI hint
 * No browser is auto-opened. The user copies the URL where they want it.
 */
async function gatherAuth(rl: RL, profile: ProviderProfile): Promise<AuthOutcome> {
  if (profile.authType === 'api_key') {
    if (profile.signupUrl) {
      console.log(`  Get your key at: ${profile.signupUrl}`);
    }
    const envHint = profile.envVars[0] ?? 'API key';
    const raw = await promptApiKey(rl, `  Paste ${envHint} (or press Enter to skip)`);
    if (raw) {
      console.log('  Saved.');
      return { apiKey: raw, liveToken: raw };
    }
    console.log("  Skipped (you can run `contextberg setup` again later).");
    return { apiKey: undefined, liveToken: undefined };
  }

  // oauth_disk: prefer the profile's own interactiveAuth flow when present.
  if (profile.hooks?.interactiveAuth) {
    const wantsLogin = await promptYesNo(
      rl,
      `Sign in to ${profile.displayName} now? (uses device-code flow — you'll get a URL and code)`,
      true,
    );
    if (wantsLogin) {
      try {
        const token = await profile.hooks.interactiveAuth();
        if (token) {
          console.log('  Saved.');
          return { apiKey: undefined, liveToken: token };
        }
      } catch (err) {
        console.log(`  Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log("  Skipped — re-run `contextberg setup` to try again.");
    return { apiKey: undefined, liveToken: undefined };
  }

  // No interactive flow available — print the URL + best-effort instructions.
  if (profile.signupUrl) console.log(`  Sign in at: ${profile.signupUrl}`);
  console.log('  After signing in (e.g. via the upstream CLI), re-run `contextberg setup`.');
  return { apiKey: undefined, liveToken: undefined };
}

export async function runWizard(opts: WizardOptions = {}): Promise<WizardResult> {
  if (!isInteractiveStdin()) {
    printNonInteractiveGuidance();
    throw new Error('contextberg setup requires an interactive terminal');
  }

  const current = opts.current;
  const isReconfigure = current !== undefined;

  if (isReconfigure) {
    console.log(`\nReconfiguring (current: ${current!.provider} / ${current!.model}). Press Enter at any prompt to keep the current value.`);
  }

  const rl = createInterface();
  try {
    // ── Provider ──────────────────────────────────────────────
    printHeader('Provider');
    const profiles = listProfiles();
    const defaultProviderIdx = current
      ? Math.max(0, profiles.findIndex((p) => p.id === current.provider))
      : 0;
    const providerId = await promptChoice(
      rl,
      'Pick a provider',
      profiles.map((p) => ({
        label: `${p.displayName}${current && p.id === current.provider ? ' (current)' : ''}`,
        description: p.description,
        value: p.id,
      })),
      defaultProviderIdx,
    );
    const profile = getProfile(providerId);
    const stayedOnProvider = current?.provider === providerId;

    // ── Auth ──────────────────────────────────────────────────
    printHeader('Authentication');
    let apiKey: string | undefined;
    let liveAuthToken: string | undefined;

    if (profile.authType === 'none') {
      console.log(`\n  ${profile.displayName} runs locally — no auth required.`);
      console.log(`  Make sure the server is running at ${profile.baseURL}`);
    } else {
      const envHit = profile.envVars.find((v) => process.env[v]);
      const storedKey = stayedOnProvider ? current?.apiKey : undefined;

      if (envHit) {
        console.log(`\n  ${envHit} is already set in your environment — using it.`);
        liveAuthToken = process.env[envHit];
      } else if (storedKey) {
        console.log(`\n  Using stored API key from previous setup.`);
        liveAuthToken = storedKey;
      } else {
        const detected = await profile.hooks?.detectAuth?.();
        if (detected) {
          console.log(`\n  Detected ${detected.label} — using it.`);
          const tok = await detected.resolve();
          if (tok) liveAuthToken = tok;
        } else {
          // Nothing found — walk the user through getting credentials.
          console.log('');
          const outcome = await gatherAuth(rl, profile);
          apiKey = outcome.apiKey;
          liveAuthToken = outcome.liveToken;
        }
      }
    }

    // ── Model ─────────────────────────────────────────────────
    printHeader('Model');
    let modelChoices = profile.fallbackModels.map((m) => ({
      label: `${m.id}${m.recommended ? ' (recommended)' : ''}${stayedOnProvider && m.id === current?.model ? ' (current)' : ''}`,
      ...(m.notes ? { description: m.notes } : {}),
      value: m.id,
    }));

    if (profile.hooks?.fetchModels) {
      const auth = liveAuthToken
        ? { apiKey: liveAuthToken, baseURL: profile.baseURL, source: 'wizard' }
        : null;
      const live = await profile.hooks.fetchModels(auth).catch(() => null);
      if (live && live.length > 0) {
        const recommended = profile.fallbackModels.find((m) => m.recommended)?.id;
        modelChoices = live.slice(0, 30).map((id) => {
          const tags: string[] = [];
          if (id === recommended) tags.push('recommended');
          if (stayedOnProvider && id === current?.model) tags.push('current');
          return {
            label: `${id}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`,
            value: id,
          };
        });
        console.log(`  (Live: ${live.length} models from ${profile.displayName})`);
      } else {
        console.log(`  (Using ${profile.fallbackModels.length} fallback models — live fetch unavailable)`);
      }
    }

    const defaultModelIdx = stayedOnProvider && current?.model
      ? Math.max(0, modelChoices.findIndex((c) => c.value === current.model))
      : 0;
    const model = await promptChoice(rl, 'Pick a model', modelChoices, defaultModelIdx);

    // ── Storage ───────────────────────────────────────────────
    printHeader('Storage');
    const outputDir = await prompt(
      rl,
      'Knowledge output dir (relative to repo root)',
      current?.outputDir ?? '.contextberg/knowledge',
    );
    const maxRaw = await prompt(
      rl,
      'Max sessions per commit',
      String(current?.maxSessionsPerCommit ?? 5),
    );
    const maxSessionsPerCommit = Math.max(1, parseInt(maxRaw, 10) || 5);

    // Expose the prompt-size cap so subscription users can lift it; we work
    // in chars internally (≈ tokens × 4) but show tokens to the user since
    // that's the unit they actually reason about for context windows.
    const currentTokens = Math.round((current?.maxPromptChars ?? 400_000) / 4);
    const promptTokensRaw = await prompt(
      rl,
      'Max prompt tokens per commit (rough cap)',
      String(currentTokens),
    );
    const maxPromptTokens = Math.max(1000, parseInt(promptTokensRaw, 10) || currentTokens);
    const maxPromptChars = maxPromptTokens * 4;

    const outRaw = await prompt(
      rl,
      'Max output tokens per call (clamped per-model)',
      String(current?.maxOutputTokens ?? 4096),
    );
    const maxOutputTokens = Math.max(256, parseInt(outRaw, 10) || 4096);

    return { provider: providerId, model, apiKey, outputDir, maxSessionsPerCommit, maxPromptChars, maxOutputTokens };
  } finally {
    rl.close();
  }
}
