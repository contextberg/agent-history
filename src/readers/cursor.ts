import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, IReader, ReaderOptions } from './types.js';
import { truncate, extractProjectName, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const THINKING_BLOCK_RE = /\n\n\*\*[A-Z][a-zA-Z ]+\*\*\n/;

export class CursorReader implements IReader {
  readonly source = 'cursor' as const;

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const cursorDir = path.join(os.homedir(), '.cursor', 'projects');
    if (!await exists(cursorDir)) return [];

    const sessions: AgentSession[] = [];

    try {
      const projectDirs = await fs.readdir(cursorDir);

      for (const dirName of projectDirs) {
        const transcriptDir = path.join(cursorDir, dirName, 'agent-transcripts');
        if (!await exists(transcriptDir)) continue;

        const projectName = extractProjectName(dirName);
        const sessionDirs = await fs.readdir(transcriptDir);

        const allFiles: { fp: string; mtime: Date }[] = [];
        for (const sessionDir of sessionDirs) {
          const sd = path.join(transcriptDir, sessionDir);
          const stat = await fs.stat(sd).catch(() => null);
          if (!stat?.isDirectory()) continue;

          const files = await fs.readdir(sd);
          for (const f of files.filter((f) => f.endsWith('.jsonl'))) {
            const fp = path.join(sd, f);
            const s = await fs.stat(fp).catch(() => null);
            if (s) allFiles.push({ fp, mtime: s.mtime });
          }
        }

        const filtered = allFiles
          .filter((x) => {
            if (options.date) return isWithinDate(x.mtime, options.date);
            return true;
          })
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
          .slice(0, maxSessions);

        for (const { fp } of filtered) {
          const session = await parseSession(fp, projectName, maxTurns, maxChars);
          if (session) sessions.push(session);
          if (sessions.length >= maxSessions) break;
        }

        if (sessions.length >= maxSessions) break;
      }
    } catch {
      // 空を返す
    }

    return sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, maxSessions);
  }
}

async function parseSession(
  filePath: string,
  projectName: string,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  const turns: AgentTurn[] = [];
  let pendingUserMessage: string | null = null;
  let lastAssistantText: string | null = null;

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      let root: Record<string, unknown>;
      try { root = JSON.parse(line); } catch { continue; }

      const role = (root['role'] as string | undefined);
      const msg = root['message'] as Record<string, unknown> | undefined;
      const contentVal = msg?.['content'];
      if (!Array.isArray(contentVal)) continue;

      if (role === 'user') {
        const text = extractText(contentVal);
        if (!text) continue;

        const match = USER_QUERY_RE.exec(text);
        if (!match) continue;

        if (pendingUserMessage !== null && lastAssistantText !== null) {
          const t = truncate(lastAssistantText, maxChars);
          turns.push({ userMessage: pendingUserMessage, assistantSummary: t, items: [{ kind: 'text', text: t }] });
        }

        pendingUserMessage = truncate(match[1]!.trim(), maxChars);
        lastAssistantText = null;
      } else if (role === 'assistant' && pendingUserMessage !== null) {
        const text = extractText(contentVal);
        if (text) lastAssistantText = stripThinkingBlock(text);
      }
    }

    if (pendingUserMessage !== null && lastAssistantText !== null) {
      const t = truncate(lastAssistantText, maxChars);
      turns.push({ userMessage: pendingUserMessage, assistantSummary: t, items: [{ kind: 'text', text: t }] });
    }
  } catch {
    return null;
  }

  if (turns.length === 0) return null;

  const stat = await fs.stat(filePath).catch(() => null);
  return {
    id: randomUUID(),
    source: 'cursor',
    project: projectName,
    startedAt: stat?.mtime ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
}

function extractText(contentArray: unknown[]): string {
  for (const item of contentArray) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it['type'] === 'text' && typeof it['text'] === 'string') return it['text'];
  }
  return '';
}

function stripThinkingBlock(text: string): string {
  const match = THINKING_BLOCK_RE.exec(text);
  if (match && match.index > 10) return text.slice(0, match.index).trim();
  return text;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
