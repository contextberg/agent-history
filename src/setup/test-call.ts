import { loadConfig } from '../config.js';
import { callProvider, findModel, getProfile, resolveAuth } from '../knowledge/providers/index.js';

/**
 * Smoke test: send a one-shot prompt to the configured provider and print
 * the response. Lets the user verify auth + model + transport work without
 * needing a real commit / linked sessions.
 */
export async function runTest(): Promise<void> {
  const config = await loadConfig();
  const k = config.knowledge;
  const profile = getProfile(k.provider);

  console.log(`contextberg test\n`);
  console.log(`  Provider : ${profile.displayName} (${k.provider})`);
  console.log(`  Model    : ${k.model}`);

  const auth = await resolveAuth(profile, k.apiKey);
  if (!auth) {
    const envHint = profile.envVars[0] ?? 'an API key';
    const oauthHint = profile.authType === 'oauth_disk' ? ' or run `codex login`' : '';
    console.error(`  Auth     : NOT set — set ${envHint}${oauthHint}`);
    process.exit(1);
  }
  console.log(`  Auth     : ${auth.source}\n`);

  const model = findModel(profile, k.model);
  const startedAt = Date.now();

  try {
    const result = await callProvider({
      profile,
      model,
      systemPrompt:
        'You are a connectivity test. Reply with a short confirmation that you can read this message.',
      userContent:
        'Reply with one sentence confirming you received this. Include the model name you are running on.',
      auth,
      maxTokens: 256,
    });
    const elapsed = Date.now() - startedAt;
    console.log(`Response (${elapsed}ms):`);
    console.log(`---`);
    console.log(result.text || '(empty response)');
    console.log(`---`);
    console.log(`\nOK — ${profile.displayName} is reachable and authenticated.`);
  } catch (err) {
    console.error(`\nFAILED after ${Date.now() - startedAt}ms`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      const cause = (err as Error & { cause?: unknown }).cause;
      if (cause) console.error(`  cause: ${cause}`);
    }
    process.exit(1);
  }
}
