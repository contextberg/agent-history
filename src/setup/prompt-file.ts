import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, type AgentHistoryConfig } from '../config.js';
import { DEFAULT_SYSTEM_PROMPT } from '../knowledge/extractor.js';

export const PROMPT_PATH = path.join(CONFIG_DIR, 'system-prompt.txt');

export interface ResolvedPrompt {
  prompt: string;
  source: 'file' | 'config' | 'default';
  path: string;
}

export async function ensurePromptFile(config: AgentHistoryConfig): Promise<string> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.access(PROMPT_PATH);
  } catch {
    await fs.writeFile(PROMPT_PATH, config.knowledge.prompt ?? DEFAULT_SYSTEM_PROMPT, { mode: 0o600 });
    try {
      await fs.chmod(PROMPT_PATH, 0o600);
    } catch { /* Windows / read-only mount defaults are acceptable. */ }
  }
  return PROMPT_PATH;
}

export async function resolvePrompt(config: AgentHistoryConfig): Promise<ResolvedPrompt> {
  try {
    const raw = await fs.readFile(PROMPT_PATH, 'utf-8');
    const prompt = raw.trimEnd();
    if (prompt.trim()) return { prompt, source: 'file', path: PROMPT_PATH };
  } catch {
    // Missing file is normal before edit-prompt or Settings writes it.
  }

  if (config.knowledge.prompt?.trim()) {
    return { prompt: config.knowledge.prompt.trimEnd(), source: 'config', path: PROMPT_PATH };
  }
  return { prompt: DEFAULT_SYSTEM_PROMPT, source: 'default', path: PROMPT_PATH };
}

export async function writePromptFile(prompt: string): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(PROMPT_PATH, prompt.trimEnd(), { mode: 0o600 });
  try {
    await fs.chmod(PROMPT_PATH, 0o600);
  } catch { /* Windows / read-only mount defaults are acceptable. */ }
}
