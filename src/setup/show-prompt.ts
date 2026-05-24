import { loadConfig } from '../config.js';
import { resolvePrompt } from './prompt-file.js';

/**
 * Print the system prompt that `contextberg learn` will send to the LLM.
 *
 * Two sources, with the same precedence the runtime uses:
 *   1. ~/.agent-history/system-prompt.txt  (editable file)
 *   2. config.knowledge.prompt             (legacy user override)
 *   3. DEFAULT_SYSTEM_PROMPT               (built-in)
 *
 * Reviewers and contributors can run this once to see exactly what shapes
 * the per-commit notes — no need to grep the source.
 */
export async function showPrompt(): Promise<void> {
  const config = await loadConfig();
  const resolved = await resolvePrompt(config);
  const active = resolved.prompt;
  const source = resolved.source === 'file'
    ? resolved.path
    : resolved.source === 'config'
      ? 'config.knowledge.prompt (legacy override in ~/.agent-history/config.json)'
      : 'built-in default (src/knowledge/extractor.ts)';

  console.log('contextberg show-prompt\n');
  console.log(`Source: ${source}`);
  console.log(`Length: ${active.length} characters\n`);
  console.log('─── system prompt ───');
  console.log(active);
  console.log('─── end ───');
}
