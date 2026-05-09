import type { ProviderProfile } from '../knowledge/providers/index.js';

/**
 * Render a step-by-step guide for getting auth set up for a profile.
 * Shown when `contextberg test` / `contextberg learn` finds no credentials,
 * so the user knows the exact URL to visit and what to do with the result.
 */
export function authMissingHint(profile: ProviderProfile): string {
  const lines: string[] = [];
  lines.push(`No credentials found for ${profile.displayName}.`);

  if (profile.authType === 'none') {
    lines.push(`This provider runs locally — make sure the server is up at ${profile.baseURL}`);
    return lines.join('\n');
  }

  if (profile.authType === 'oauth_disk') {
    // Codex / future OAuth-via-CLI providers
    lines.push('');
    lines.push(`To sign in:`);
    if (profile.signupUrl) lines.push(`  1. Visit:  ${profile.signupUrl}`);
    lines.push(`  2. Install the upstream CLI and run \`codex login\` (it stores ~/.codex/auth.json)`);
    lines.push(`  3. Re-run this command — contextberg will pick up the saved token automatically`);
    if (profile.envVars[0]) {
      lines.push('');
      lines.push(`Or set ${profile.envVars[0]} in your shell if you have a direct API key.`);
    }
    return lines.join('\n');
  }

  // Plain API key
  lines.push('');
  lines.push(`To get an API key:`);
  if (profile.signupUrl) lines.push(`  1. Visit:  ${profile.signupUrl}`);
  lines.push(`  2. Create or copy a key`);
  if (profile.envVars[0]) {
    lines.push(`  3. Either set the env var:    ${profile.envVars[0]}=...`);
    lines.push(`     or save it via wizard:     contextberg setup`);
  }
  return lines.join('\n');
}
