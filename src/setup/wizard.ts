import open from 'open';
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
import { authMissingHint } from './auth-help.js';

/**
 * Walk the user through getting credentials when they don't already have them.
 * Prints the signup URL, offers to open it in the browser, then prompts for
 * the resulting API key (or detects on-disk OAuth tokens for Codex on retry).
 */
async function offerAuthLink(rl: RL, profile: ProviderProfile): Promise<string | undefined> {
  console.log('');
  console.log(authMissingHint(profile));
  console.log('');

  if (profile.signupUrl) {
    const wantsOpen = await promptYesNo(rl, `Open ${profile.signupUrl} in your browser?`, true);
    if (wantsOpen) {
      try {
        await open(profile.signupUrl);
        console.log(`  Opened ${profile.signupUrl}`);
      } catch {
        console.log(`  Could not auto-open. Visit it manually: ${profile.signupUrl}`);
      }
    }
  }

  // For oauth_disk providers (Codex), don't prompt for a raw key — the user
  // is supposed to come back after running `codex login`. Re-check the disk.
  if (profile.authType === 'oauth_disk') {
    console.log('');
    console.log('  After signing in via the upstream CLI, press Enter to re-check.');
    await rl.question('  (Enter to re-check, or type a token to skip the CLI flow): ');
    const detected = await profile.hooks?.detectAuth?.();
    if (detected) {
      console.log(`  Detected ${detected.label}.`);
      const token = await detected.resolve();
      return token ?? undefined;
    }
    console.log('  No on-disk credential found yet. You can run setup again later.');
    return undefined;
  }

  // For api_key providers, prompt for the key.
  const envHint = profile.envVars[0] ?? 'API key';
  const raw = await promptApiKey(rl, `Paste your ${envHint} (or press Enter to skip)`);
  return raw || undefined;
}

export interface WizardResult {
  provider: KnowledgeProvider;
  model: string;
  apiKey: string | undefined;
  outputDir: string;
  maxSessionsPerCommit: number;
}

export interface WizardOptions {
  /** Existing config — its values become defaults so re-running setup is non-destructive. */
  current?: KnowledgeConfig;
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
        console.log(`\n  ${envHit} is already set — using it.`);
        liveAuthToken = process.env[envHit];
      } else if (storedKey) {
        console.log(`\n  Using stored API key from previous setup.`);
        liveAuthToken = storedKey;
        // Keep the stored key — only set apiKey if user enters something new.
      } else {
        const detected = await profile.hooks?.detectAuth?.();
        if (detected) {
          console.log(`\n  Detected ${detected.label} — using it.`);
          const tok = await detected.resolve();
          if (tok) liveAuthToken = tok;
        } else {
          // No env, no on-disk credential — walk the user through signup.
          const got = await offerAuthLink(rl, profile);
          if (got) {
            // For api_key providers we keep the key in config; for oauth_disk
            // the disk is the source of truth so we don't store it.
            if (profile.authType === 'api_key') apiKey = got;
            liveAuthToken = got;
          }
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

    // Default to the current model if it's in the offered list — otherwise first.
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
      String(current?.maxSessionsPerCommit ?? 3),
    );
    const maxSessionsPerCommit = Math.max(1, parseInt(maxRaw, 10) || 3);

    return { provider: providerId, model, apiKey, outputDir, maxSessionsPerCommit };
  } finally {
    rl.close();
  }
}
