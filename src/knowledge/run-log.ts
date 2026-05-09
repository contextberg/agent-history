import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';

/**
 * Per-run JSONL log for `contextberg learn`. Powers `contextberg status` and
 * makes "did the post-commit hook actually run?" debuggable without needing
 * to dig through stderr logs.
 *
 * One line per invocation. File rotates at ROTATE_BYTES — old log moved
 * aside as learn.log.1 (single backup; older history is git's job).
 */

const ROTATE_BYTES = 10 * 1024 * 1024; // 10MB

export type RunStatus = 'ok' | 'skip' | 'no-sessions' | 'no-auth' | 'empty' | 'error';

export interface RunLogEntry {
  ts: string;
  sha: string | null;
  repo: string;
  status: RunStatus;
  /** Why we got this status (skip reason, error message, etc.). */
  reason?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  inputChars?: number;
  outputChars?: number;
  /** Sessions actually fed to the LLM, by id. */
  sessions?: string[];
}

export function runLogPath(): string {
  return path.join(CONFIG_DIR, 'learn.log');
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const stat = await fs.stat(file);
    if (stat.size < ROTATE_BYTES) return;
    const backup = `${file}.1`;
    await fs.rm(backup, { force: true });
    await fs.rename(file, backup);
  } catch { /* file doesn't exist yet */ }
}

export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  const file = runLogPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await rotateIfNeeded(file);
  await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Read the most recent N lines of learn.log. Used by `contextberg status` to
 * show recent runs without loading the whole file.
 *
 * Reads the entire file (capped via rotation), splits, and tails — JSONL
 * doesn't allow seeking by entry without an index, but with 10MB max this
 * stays cheap.
 */
export async function readRecentRuns(n: number): Promise<RunLogEntry[]> {
  const file = runLogPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-n);
  const out: RunLogEntry[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as RunLogEntry);
    } catch { /* skip malformed line */ }
  }
  return out;
}
