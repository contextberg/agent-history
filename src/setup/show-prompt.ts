import { loadConfig } from '../config.js';
import { DEFAULT_SYSTEM_PROMPT } from '../knowledge/extractor.js';

/**
 * Print the system prompt that `contextberg learn` will send to the LLM.
 *
 * Two sources, with the same precedence the runtime uses:
 *   1. config.knowledge.prompt  (user override)
 *   2. DEFAULT_SYSTEM_PROMPT    (built-in)
 *
 * Reviewers and contributors can run this once to see exactly what shapes
 * the per-commit notes — no need to grep the source.
 */
export async function showPrompt(): Promise<void> {
  const config = await loadConfig();
  const customPrompt = config.knowledge.prompt;
  const active = customPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const source = customPrompt
    ? 'config.knowledge.prompt (custom override in ~/.agent-history/config.json)'
    : 'built-in default (src/knowledge/extractor.ts)';

  console.log('contextberg show-prompt\n');
  console.log(`Source: ${source}`);
  console.log(`Length: ${active.length} characters\n`);
  console.log('─── system prompt ───');
  console.log(active);
  console.log('─── end ───');
}
