import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { KnowledgeProvider } from '../config.js';

export interface WizardResult {
  provider: KnowledgeProvider;
  model: string;
  apiKey: string | undefined;
  outputDir: string;
  maxSessionsPerCommit: number;
}

const PROVIDER_MODELS: Record<KnowledgeProvider, string[]> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'claude-haiku-4-5-20251001',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o4-mini',
  ],
};

const API_KEY_ENV: Record<KnowledgeProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

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
    const providers: KnowledgeProvider[] = ['anthropic', 'openai'];
    const pi = await pickFromList(rl, 'Provider', providers);
    const provider = providers[pi]!;

    const models = PROVIDER_MODELS[provider];
    console.log('\nSelect model:');
    const mi = await pickFromList(rl, 'Model', models);
    const model = models[mi]!;

    const envVar = API_KEY_ENV[provider];
    const envVal = process.env[envVar];
    let apiKey: string | undefined;

    if (envVal) {
      console.log(`\n  ${envVar} is already set — using it.`);
    } else {
      const raw = await rl.question(`\nEnter ${envVar} (leave blank to set later): `);
      apiKey = raw.trim() || undefined;
    }

    const outputDir = await ask(rl, '\nKnowledge output dir (relative to repo root)', '.contextberg/knowledge');

    const maxRaw = await ask(rl, 'Max sessions per commit', '3');
    const maxSessionsPerCommit = Math.max(1, parseInt(maxRaw, 10) || 3);

    return { provider, model, apiKey, outputDir, maxSessionsPerCommit };
  } finally {
    rl.close();
  }
}
