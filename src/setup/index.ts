import { loadConfig, saveConfig } from '../config.js';
import type { AgentHistoryConfig } from '../config.js';
import { runWizard } from './wizard.js';
import { installHook, getHookStatus, uninstallHook } from './hooks.js';
import { getProfile, resolveAuth } from '../knowledge/providers/index.js';
import { readRecentRuns, runLogPath } from '../knowledge/run-log.js';

export async function runSetup(): Promise<void> {
  console.log('contextberg setup\n');

  const config = await loadConfig();
  const result = await runWizard({ current: config.knowledge });

  // If the user kept the same provider and didn't enter a new key, preserve the
  // stored one. If they switched providers, drop the old key — it's the wrong
  // shape for the new transport.
  const switchedProvider = config.knowledge.provider !== result.provider;
  const preservedKey = switchedProvider ? undefined : config.knowledge.apiKey;
  const finalApiKey = result.apiKey ?? preservedKey;

  // Build the next config carefully — exactOptionalPropertyTypes refuses
  // `apiKey: undefined`, so we conditionally include the field instead.
  const next: AgentHistoryConfig['knowledge'] = {
    ...config.knowledge,
    provider: result.provider,
    model: result.model,
    outputDir: result.outputDir,
    maxSessionsPerCommit: result.maxSessionsPerCommit,
    maxPromptChars: result.maxPromptChars,
    maxOutputTokens: result.maxOutputTokens,
  };
  if (finalApiKey) next.apiKey = finalApiKey;
  else delete next.apiKey;
  config.knowledge = next;
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

  // Recent runs from learn.log — answers "did the hook actually fire?"
  const recent = await readRecentRuns(5);
  if (recent.length === 0) {
    console.log(`\n  Recent runs: (none — log at ${runLogPath()})`);
    return;
  }

  const totals = recent.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const totalsLine = Object.entries(totals)
    .map(([s, n]) => `${s}=${n}`)
    .join(' ');

  console.log(`\n  Recent ${recent.length} run(s) — ${totalsLine}`);
  // Newest first, compact one-line each.
  for (const r of recent.slice().reverse()) {
    const ts = r.ts.replace('T', ' ').slice(0, 19);
    const sha = r.sha ? r.sha.slice(0, 7) : '-------';
    const dur = r.durationMs !== undefined ? ` ${r.durationMs}ms` : '';
    const reason = r.reason ? `  ← ${r.reason}` : '';
    console.log(`    ${ts}  ${r.status.padEnd(11)} ${sha}${dur}${reason}`);
  }

  const errors = recent.filter((r) => r.status === 'error').slice(-1)[0];
  if (errors) {
    console.log(`\n  Last error: ${errors.reason ?? '(no reason captured)'}`);
  }
}

export async function runUninstall(): Promise<void> {
  await uninstallHook();
  console.log('post-commit hook removed.');
}
