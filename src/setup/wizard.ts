import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { KnowledgeProvider } from '../config.js';
import { listProviders, getOverlay } from '../knowledge/providers/index.js';

export interface WizardResult {
  provider: KnowledgeProvider;
  model: string;
  apiKey: string | undefined;
  outputDir: string;
  maxSessionsPerCommit: number;
}

function printMenu(items: string[]): void {
  items.forEach((item, i) => console.log(`  ${i + 1}) ${item}`));
}

async function pickFromList(rl: readline.Interface, prompt: string, items: string[]): Promise<number> {
  while (true) {
    printMenu(items);
    const raw = await rl.question(`${prompt} [1-${items.length}]: `);
    const n = parseInt(raw.trim(), 10);
    if (n >= 1 && n <= items.length) return n - 1;
    console.log(`  Please enter a number between 1 and ${items.length}.`);
  }
}

async function ask(rl: readline.Interface, prompt: string, defaultValue?: string): Promise<string> {
  const hint = defaultValue ? ` (${defaultValue})` : '';
  const raw = await rl.question(`${prompt}${hint}: `);
  return raw.trim() || defaultValue || '';
}

export async function runWizard(): Promise<WizardResult> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\nSelect provider:');
    const overlays = listProviders();
    const labels = overlays.map((o) => `${o.displayName}  [${o.apiKeyEnv}]`);
    const pi = await pickFromList(rl, 'Provider', labels);
    const overlay = overlays[pi]!;
    const provider = overlay.id;

    console.log('\nSelect model:');
    const mi = await pickFromList(rl, 'Model', overlay.models);
    const model = overlay.models[mi]!;

    let apiKey: string | undefined;
    const envVal = process.env[overlay.apiKeyEnv];

    if (envVal) {
      console.log(`\n  ${overlay.apiKeyEnv} is already set — using it.`);
    } else if (overlay.id === 'codex') {
      const stored = overlay.resolveTokenFromDisk ? await overlay.resolveTokenFromDisk() : null;
      if (stored) {
        console.log('\n  Codex CLI auth detected at ~/.codex/auth.json — using it.');
      } else {
        const raw = await rl.question(`\nEnter ${overlay.apiKeyEnv} or run \`codex login\` later (blank to skip): `);
        apiKey = raw.trim() || undefined;
      }
    } else {
      const raw = await rl.question(`\nEnter ${overlay.apiKeyEnv} (leave blank to set later): `);
      apiKey = raw.trim() || undefined;
    }

    const outputDir = await ask(rl, '\nKnowledge output dir (relative to repo root)', '.contextberg/knowledge');

    const maxRaw = await ask(rl, 'Max sessions per commit', '3');
    const maxSessionsPerCommit = Math.max(1, parseInt(maxRaw, 10) || 3);

    // Side-effect-free check just so we can warn the user up front.
    const overlayCheck = getOverlay(provider);
    if (overlayCheck.transport === 'openai_responses') {
      console.log('\n  Note: Codex requires the Responses API; ensure your subscription supports it.');
    }

    return { provider, model, apiKey, outputDir, maxSessionsPerCommit };
  } finally {
    rl.close();
  }
}
