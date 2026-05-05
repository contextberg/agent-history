import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, extractProjectName, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const THINKING_BLOCK_RE = /\n\n\*\*[A-Z][a-zA-Z ]+\*\*\n/;

export class CursorReader implements IReader {
  readonly source = 'cursor' as const;

  async isInstalled(): Promise<boolean> {
    return exists(path.join(os.homedir(), '.cursor', 'projects'));
  }

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
      // return empty on unreadable directories
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
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();

  function flushTurn(): void {
    if (!pendingUserMessage || pendingItems.length === 0) return;
    const textParts = pendingItems
      .filter((i): i is { kind: 'text'; text: string } => i.kind === 'text')
      .map((i) => i.text)
      .join(' ');
    let summary = '';
    if (textParts) {
      if (pendingTools.size > 0) {
        const suffix = ' [' + [...pendingTools.entries()].map(([k, v]) => `${k}×${v}`).join(', ') + ']';
        summary = truncate(textParts, Math.max(0, maxChars - suffix.length)) + suffix;
      } else {
        summary = truncate(textParts, maxChars);
      }
    } else if (pendingTools.size > 0) {
      summary = '→ ' + [...pendingTools.entries()].map(([k, v]) => `${k}×${v}`).join(', ');
    }
    turns.push({ userMessage: pendingUserMessage, assistantSummary: summary, items: [...pendingItems] });
    pendingUserMessage = null;
    pendingItems.length = 0;
    pendingTools.clear();
  }

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
        const text = extractFirstText(contentVal);
        if (!text) continue;

        const match = USER_QUERY_RE.exec(text);
        if (!match) continue;

        flushTurn();
        pendingUserMessage = truncate(match[1]!.trim(), maxChars);
      } else if (role === 'assistant' && pendingUserMessage !== null) {
        const { items, toolUses } = extractAssistantParts(contentVal);
        pendingItems.push(...items);
        for (const [name, count] of toolUses) {
          pendingTools.set(name, (pendingTools.get(name) ?? 0) + count);
        }
      }
    }

    flushTurn();
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

function extractFirstText(contentArray: unknown[]): string {
  for (const item of contentArray) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it['type'] === 'text' && typeof it['text'] === 'string') return it['text'];
  }
  return '';
}

function extractAssistantParts(
  contentArray: unknown[],
): { items: AssistantItem[]; toolUses: Map<string, number> } {
  const items: AssistantItem[] = [];
  const toolUses = new Map<string, number>();

  for (const item of contentArray) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;

    if (it['type'] === 'text' && typeof it['text'] === 'string') {
      const stripped = stripThinkingBlock(it['text']).trim();
      if (stripped) items.push({ kind: 'text', text: stripped });
    } else if (it['type'] === 'tool_use' || it['type'] === 'tool_call') {
      const name = typeof it['name'] === 'string' ? it['name'] : '?';
      const input = (it['input'] as Record<string, unknown>) ?? {};
      toolUses.set(name, (toolUses.get(name) ?? 0) + 1);
      items.push({ kind: 'tool', tool: { name, input } });
    }
  }

  return { items, toolUses };
}

function stripThinkingBlock(text: string): string {
  const match = THINKING_BLOCK_RE.exec(text);
  if (match && match.index > 10) return text.slice(0, match.index).trim();
  return text;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
