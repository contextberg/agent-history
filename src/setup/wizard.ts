import type { KnowledgeProvider } from '../config.js';
import { listProfiles, getProfile } from '../knowledge/providers/index.js';
import {
  createInterface,
  isInteractiveStdin,
  printHeader,
  printNonInteractiveGuidance,
  prompt,
  promptApiKey,
  promptChoice,
} from './prompts.js';

export interface WizardResult {
  provider: KnowledgeProvider;
  model: string;
  apiKey: string | undefined;
  outputDir: string;
  maxSessionsPerCommit: number;
}

export async function runWizard(): Promise<WizardResult> {
  if (!isInteractiveStdin()) {
    printNonInteractiveGuidance();
    throw new Error('contextberg setup requires an interactive terminal');
  }

  const rl = createInterface();
  try {
    // ── Provider ──────────────────────────────────────────────
    printHeader('Provider');
    const profiles = listProfiles();
    const providerId = await promptChoice(
      rl,
      'Pick a provider',
      profiles.map((p) => ({
        label: `${p.displayName}`,
        description: p.description,
        value: p.id,
      })),
    );
    const profile = getProfile(providerId);

    // ── Auth ──────────────────────────────────────────────────
    // Resolve auth before model selection so we can live-fetch the model
    // catalog when the provider supports it (Codex, OpenRouter, etc).
    printHeader('Authentication');
    let apiKey: string | undefined;
    let liveAuthToken: string | undefined;

    if (profile.authType === 'none') {
      console.log(`\n  ${profile.displayName} runs locally — no auth required.`);
      console.log(`  Make sure the server is running at ${profile.baseURL}`);
    } else {
      const envHit = profile.envVars.find((v) => process.env[v]);
      if (envHit) {
        console.log(`\n  ${envHit} is already set — using it.`);
        liveAuthToken = process.env[envHit];
      } else {
        const detected = await profile.hooks?.detectAuth?.();
        if (detected) {
          console.log(`\n  Detected ${detected.label} — using it.`);
          const tok = await detected.resolve();
          if (tok) liveAuthToken = tok;
        } else {
          const envHint = profile.envVars[0] ?? 'API key';
          const promptText =
            profile.authType === 'oauth_disk'
              ? `Enter ${envHint} or run \`codex login\` later (blank to skip)`
              : `Enter ${envHint} (blank to set later)`;
          const raw = await promptApiKey(rl, promptText);
          apiKey = raw || undefined;
          if (apiKey) liveAuthToken = apiKey;
          if (profile.signupUrl && !apiKey) {
            console.log(`  Get one at: ${profile.signupUrl}`);
          }
        }
      }
    }

    // ── Model ─────────────────────────────────────────────────
    // Try live fetch. Local providers (Ollama / LM Studio) and OpenRouter
    // don't need auth for /models. Falls back to fallbackModels on any error.
    printHeader('Model');
    let modelChoices = profile.fallbackModels.map((m) => ({
      label: `${m.id}${m.recommended ? ' (recommended)' : ''}`,
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
        modelChoices = live.slice(0, 30).map((id) => ({
          label: `${id}${id === recommended ? ' (recommended)' : ''}`,
          value: id,
        }));
        console.log(`  (Live: ${live.length} models from ${profile.displayName})`);
      } else {
        console.log(`  (Using ${profile.fallbackModels.length} fallback models — live fetch unavailable)`);
      }
    }

    const model = await promptChoice(rl, 'Pick a model', modelChoices);

    // ── Storage ───────────────────────────────────────────────
    printHeader('Storage');
    const outputDir = await prompt(
      rl,
      'Knowledge output dir (relative to repo root)',
      '.contextberg/knowledge',
    );
    const maxRaw = await prompt(rl, 'Max sessions per commit', '3');
    const maxSessionsPerCommit = Math.max(1, parseInt(maxRaw, 10) || 3);

    return { provider: providerId, model, apiKey, outputDir, maxSessionsPerCommit };
  } finally {
    rl.close();
  }
}
