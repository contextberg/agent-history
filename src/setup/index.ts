import { loadConfig, saveConfig } from '../config.js';
import type { AgentHistoryConfig } from '../config.js';
import { runWizard } from './wizard.js';
import { installHook, getHookStatus, uninstallHook } from './hooks.js';
import { getProfile, resolveAuth } from '../knowledge/providers/index.js';

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
  const config: AgentHistoryConfig = await loadConfig();
  const k = config.knowledge;
  const profile = getProfile(k.provider);
  const auth = await resolveAuth(profile, k.apiKey);
  const status = await getHookStatus();

  const authLabel =
    profile.authType === 'none'
      ? 'not required (local)'
      : auth
      ? `set (${auth.source})`
      : 'NOT set';

  console.log('contextberg status\n');
  console.log(`  Provider : ${profile.displayName} (${k.provider})`);
  console.log(`  Model    : ${k.model}`);
  console.log(`  Output   : ${k.outputDir}`);
  console.log(`  Max sess : ${k.maxSessionsPerCommit}`);
  console.log(`  Auth     : ${authLabel}`);
  console.log(`  Hook     : ${status.installed ? `installed (${status.repoRoot})` : 'not installed'}`);
}

export async function runUninstall(): Promise<void> {
  await uninstallHook();
  console.log('post-commit hook removed.');
}
