import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CONFIG_DIR } from '../config.js';

export interface KnowledgeEntry {
  sha: string;
  subject: string;
  repo: string;
  extractedAt: string;
  model: string;
  provider: string;
  body: string;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatEntry(entry: KnowledgeEntry): string {
  const lines = [
    `<!-- sha:${entry.sha} -->`,
    `# ${entry.subject}`,
    ``,
    `**Repo:** \`${entry.repo}\` · **Commit:** \`${entry.sha.slice(0, 8)}\` · **Extracted:** ${entry.extractedAt} · **Model:** ${entry.provider}/${entry.model}`,
    ``,
    entry.body.trim(),
    ``,
    `---`,
    ``,
  ];
  return lines.join('\n');
}

async function appendToFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, content, 'utf-8');
}

async function alreadyStored(filePath: string, sha: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.includes(`<!-- sha:${sha} -->`);
  } catch {
    return false;
  }
}

export async function storeKnowledge(
  entry: KnowledgeEntry,
  options: {
    /** Absolute path to the local repo output directory (e.g. /repo/.contextberg/knowledge). */
    localDir: string | null;
  },
): Promise<{ localPath: string | null; globalPath: string }> {
  const month = monthKey(new Date(entry.extractedAt));
  const filename = `${month}.md`;
  const formatted = formatEntry(entry);

  const globalDir = path.join(CONFIG_DIR, 'knowledge', path.basename(entry.repo));
  const globalPath = path.join(globalDir, filename);

  let localPath: string | null = null;

  if (options.localDir) {
    const lp = path.join(options.localDir, filename);
    if (!(await alreadyStored(lp, entry.sha))) {
      await appendToFile(lp, formatted);
    }
    localPath = lp;
  }

  if (!(await alreadyStored(globalPath, entry.sha))) {
    await appendToFile(globalPath, formatted);
  }

  return { localPath, globalPath };
}

export function globalKnowledgeDir(): string {
  return path.join(CONFIG_DIR, 'knowledge');
}
