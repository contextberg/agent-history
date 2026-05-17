import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { globalKnowledgeDir } from '../knowledge/store.js';

/**
 * MCP-side reader for per-commit knowledge entries written by `contextberg learn`.
 * Reads from the global mirror under `~/.agent-history/knowledge/<repo>/`.
 * The on-disk layout matches `.contextberg/knowledge/` in each watched repo,
 * so other AI agents in unrelated cwd values can pull accumulated decisions.
 */

export const GetCommitKnowledgeSchema = z.object({
  repo: z.string()
    .optional()
    .describe('Filter by repo basename (e.g. "agent-history"). Omit to scan all repos.'),
  since: z.string()
    .optional()
    .describe('ISO date; return only commits extracted on or after this date.'),
  until: z.string()
    .optional()
    .describe('ISO date; return only commits extracted on or before this date.'),
  query: z.string()
    .optional()
    .describe('Substring filter (case-insensitive) over subject and body.'),
  limit: z.number().int().min(1).max(20)
    .optional()
    .describe('Max entries to return. Default 10, hard cap 20.'),
  maxCharsPerEntry: z.number().int().min(200).max(2000)
    .optional()
    .describe('Truncate body_md to this length. Default 1500, hard cap 2000.'),
});

export type GetCommitKnowledgeInput = z.infer<typeof GetCommitKnowledgeSchema>;

export interface StoredEntry {
  sha: string;
  subject: string;
  repo: string;
  repoName: string;
  branch: string;
  authorName: string;
  authoredAt: string;
  extractedAt: string;
  provider: string;
  model: string;
  body: string;
  sessions: Array<{ id: string; score: number; reason: string }>;
  filesChanged: string[];
  inputChars: number;
  outputChars: number;
  durationMs: number;
}

async function listJsonFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listJsonFilesUnder(full)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

async function readEntry(file: string): Promise<StoredEntry | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as StoredEntry;
  } catch {
    return null;
  }
}

function passesFilters(entry: StoredEntry, params: GetCommitKnowledgeInput): boolean {
  if (params.repo && entry.repoName !== params.repo) return false;
  if (params.since && entry.extractedAt < params.since) return false;
  if (params.until && entry.extractedAt > params.until) return false;
  if (params.query) {
    const needle = params.query.toLowerCase();
    const hay = `${entry.subject}\n${entry.body}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export async function readCommitKnowledge(
  params: GetCommitKnowledgeInput,
): Promise<StoredEntry[]> {
  const root = globalKnowledgeDir();
  const limit = Math.min(params.limit ?? 10, 20);
  const cap = Math.min(params.maxCharsPerEntry ?? 1500, 2000);

  // Narrow to a single repo dir if filter says so; saves a lot of I/O when
  // the global cache holds many repos.
  const scanRoot = params.repo ? path.join(root, params.repo) : root;
  const files = await listJsonFilesUnder(scanRoot);

  const entries: StoredEntry[] = [];
  for (const file of files) {
    const entry = await readEntry(file);
    if (!entry) continue;
    if (!passesFilters(entry, params)) continue;
    entries.push({ ...entry, body: entry.body.slice(0, cap) });
  }

  entries.sort((a, b) => b.extractedAt.localeCompare(a.extractedAt));
  return entries.slice(0, limit);
}

export function formatEntriesAsMarkdown(entries: StoredEntry[]): string {
  if (entries.length === 0) {
    return 'No commit knowledge entries match those filters.\nRun `contextberg learn --commit HEAD` in the target repo to populate.';
  }
  const lines: string[] = [];
  for (const e of entries) {
    const sha7 = e.sha.slice(0, 7);
    const date = (e.authoredAt || e.extractedAt).slice(0, 10);
    lines.push(`### \`${sha7}\` ${e.subject}`);
    lines.push(`*${e.repoName}/${e.branch || 'unknown'} | ${date} | ${e.provider}/${e.model} | ${e.sessions.length} session(s)*`);
    lines.push('');
    lines.push(e.body.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}
