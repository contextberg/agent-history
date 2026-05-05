import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

export class AntigravityReader implements IReader {
  readonly source = 'antigravity' as const;

  async isInstalled(): Promise<boolean> {
    return fs.access(BRAIN_DIR).then(() => true).catch(() => false);
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    if (!await this.isInstalled()) return [];

    const sessions: AgentSession[] = [];

    try {
      const guids = await fs.readdir(BRAIN_DIR);

      const withMtime = await Promise.all(
        guids.map(async (guid) => {
          const dir = path.join(BRAIN_DIR, guid);
          const stat = await fs.stat(dir).catch(() => null);
          if (!stat?.isDirectory()) return null;
          return { guid, dir, mtime: stat.mtime };
        }),
      );

      const filtered = withMtime
        .filter((x): x is NonNullable<typeof x> => {
          if (!x) return false;
          if (options.date) return isWithinDate(x.mtime, options.date);
          return true;
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, maxSessions);

      for (const { guid, dir, mtime } of filtered) {
        const session = await parseTask(guid, dir, mtime, maxTurns, maxChars);
        if (session) sessions.push(session);
      }
    } catch {
      return [];
    }

    return sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
}

async function parseTask(
  guid: string,
  dir: string,
  mtime: Date,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  // Read task.md as the user request and walkthrough.md as the assistant response.
  const taskText = await readMd(path.join(dir, 'task.md'));
  const walkthroughText = await readMd(path.join(dir, 'walkthrough.md'));
  const planText = await readMd(path.join(dir, 'implementation_plan.md'));

  if (!taskText) return null;

  // Derive startedAt from metadata if available
  const metaPath = path.join(dir, 'task.md.metadata.json');
  let startedAt = mtime;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as { updatedAt?: string };
    if (meta.updatedAt) {
      const d = new Date(meta.updatedAt);
      if (!isNaN(d.getTime())) startedAt = d;
    }
  } catch { /* use mtime */ }

  // Build turns: task → walkthrough, then plan if present
  const turns: AgentTurn[] = [];

  const assistantText = [walkthroughText, planText].filter(Boolean).join('\n\n');

  if (assistantText) {
    const summary = truncate(assistantText, maxChars);
    turns.push({
      userMessage: truncate(taskText, maxChars),
      assistantSummary: summary,
      items: [{ kind: 'text', text: summary }],
    });
  }

  if (turns.length === 0) return null;

  // Use task summary line as project name
  const project = taskText.split('\n').find((l) => l.trim())?.trim().slice(0, 60) ?? 'antigravity';

  return {
    id: guid,
    source: 'antigravity',
    project,
    startedAt,
    turns: selectTurns(turns, maxTurns),
  };
}

async function readMd(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8').catch(() => '');
}
