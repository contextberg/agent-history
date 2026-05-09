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

    // ── Model ─────────────────────────────────────────────────
    printHeader('Model');
    const model = await promptChoice(
      rl,
      'Pick a model',
      profile.fallbackModels.map((m) => ({
        label: `${m.id}${m.recommended ? ' (recommended)' : ''}`,
        ...(m.notes ? { description: m.notes } : {}),
        value: m.id,
      })),
    );

    // ── Auth ──────────────────────────────────────────────────
    printHeader('Authentication');
    let apiKey: string | undefined;

    if (profile.authType === 'none') {
      console.log(`\n  ${profile.displayName} runs locally — no auth required.`);
      console.log(`  Make sure the server is running at ${profile.baseURL}`);
    } else {
      // 1. Env var already set?
      const envHit = profile.envVars.find((v) => process.env[v]);
      if (envHit) {
        console.log(`\n  ${envHit} is already set — using it.`);
      } else {
        // 2. On-disk credential (Codex)?
        const detected = await profile.hooks?.detectAuth?.();
        if (detected) {
          console.log(`\n  Detected ${detected.label} — using it.`);
        } else {
          // 3. Prompt for the key.
          const envHint = profile.envVars[0] ?? 'API key';
          const promptText =
            profile.authType === 'oauth_disk'
              ? `Enter ${envHint} or run \`codex login\` later (blank to skip)`
              : `Enter ${envHint} (blank to set later)`;
          const raw = await promptApiKey(rl, promptText);
          apiKey = raw || undefined;
          if (profile.signupUrl && !apiKey) {
            console.log(`  Get one at: ${profile.signupUrl}`);
          }
        }
      }
    }

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
