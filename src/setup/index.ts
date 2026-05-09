import { loadConfig, saveConfig } from '../config.js';
import { runWizard } from './wizard.js';
import { installHook, getHookStatus, uninstallHook } from './hooks.js';

export async function runSetup(): Promise<void> {
  console.log('contextberg setup\n');

  const result = await runWizard();

  const config = await loadConfig();
  config.knowledge = {
    ...config.knowledge,
    provider: result.provider,
    model: result.model,
    outputDir: result.outputDir,
    maxSessionsPerCommit: result.maxSessionsPerCommit,
    ...(result.apiKey ? { apiKey: result.apiKey } : {}),
  };
  await saveConfig(config);
  console.log('\n  Config saved.');

  const status = await getHookStatus();
  if (!status.repoRoot) {
    console.log('  Not inside a git repository — skipping hook installation.');
    console.log('\nSetup complete. Run `contextberg learn` manually to extract knowledge from commits.');
    return;
  }

  if (status.installed) {
    console.log(`  post-commit hook already installed in ${status.repoRoot}`);
  } else {
    const { repoRoot } = await installHook();
    console.log(`  post-commit hook installed in ${repoRoot}`);
  }

  console.log('\nSetup complete. Knowledge will be extracted automatically on each git commit.');
}

export async function runStatus(): Promise<void> {
  const config = await loadConfig();
  const k = config.knowledge;
  const status = await getHookStatus();

  console.log('contextberg status\n');
  console.log(`  Provider : ${k.provider}`);
  console.log(`  Model    : ${k.model}`);
  console.log(`  Output   : ${k.outputDir}`);
  console.log(`  Max sess : ${k.maxSessionsPerCommit}`);
  console.log(`  API key  : ${resolveApiKey(config) ? 'set' : 'not set'}`);
  console.log(`  Hook     : ${status.installed ? `installed (${status.repoRoot})` : 'not installed'}`);
}

export async function runUninstall(): Promise<void> {
  await uninstallHook();
  console.log('post-commit hook removed.');
}

function resolveApiKey(config: ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never): string | undefined {
  const envVar = config.knowledge.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  return process.env[envVar] ?? config.knowledge.apiKey;
}
