import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

export class OpenClawReader implements IReader {
  readonly source = 'openclaw' as const;

  async isInstalled(): Promise<boolean> {
    return exists(path.join(os.homedir(), '.openclaw', 'agents'));
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const agentsDir = path.join(os.homedir(), '.openclaw', 'agents');
    if (!await exists(agentsDir)) return [];

    const sessions: AgentSession[] = [];

    try {
      const agentDirs = await fs.readdir(agentsDir);

      for (const agentDir of agentDirs) {
        const sessionsDir = path.join(agentsDir, agentDir, 'sessions');
        if (!await exists(sessionsDir)) continue;

        const files = await fs.readdir(sessionsDir);
        const jsonlFiles = files.filter(
          (f) => f.endsWith('.jsonl') && !f.endsWith('.trajectory.jsonl'),
        );

        const withMtime = await Promise.all(
          jsonlFiles.map(async (f) => {
            const fp = path.join(sessionsDir, f);
            const s = await fs.stat(fp).catch(() => null);
            return s ? { fp, mtime: s.mtime } : null;
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

        for (const { fp } of filtered) {
          const session = await parseSession(fp, options.date, maxTurns, maxChars);
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
  targetDate: Date | undefined,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  const turns: AgentTurn[] = [];
  let startedAt: Date | null = null;
  let projectName = 'openclaw';
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

      const type = root['type'];

      if (type === 'session') {
        const cwd = root['cwd'];
        if (typeof cwd === 'string') {
          projectName = path.basename(cwd.replace(/[/\\]+$/, '')) || projectName;
        }
        const ts = parseTimestamp(root['timestamp']);
        if (ts) startedAt = ts;
        continue;
      }

      if (type !== 'message') continue;

      const timestamp = parseTimestamp(root['timestamp']);
      if (!timestamp) continue;
      if (targetDate && !isWithinDate(timestamp, targetDate)) continue;

      const msg = root['message'] as Record<string, unknown> | undefined;
      const role = msg?.['role'];
      if (role === 'toolResult') continue;

      if (role === 'user') {
        flushTurn();
        const contentVal = msg?.['content'];
        const text = extractFirstText(contentVal);
        if (text.trim()) {
          pendingUserMessage = truncate(text, maxChars);
          if (!startedAt) startedAt = timestamp;
        }
      } else if (role === 'assistant' && pendingUserMessage !== null) {
        const contentVal = msg?.['content'];
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

  return {
    id: randomUUID(),
    source: 'openclaw',
    project: projectName,
    startedAt: startedAt ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
}

function extractFirstText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it['type'] === 'text' && typeof it['text'] === 'string') return it['text'];
  }
  return '';
}

function extractAssistantParts(
  content: unknown,
): { items: AssistantItem[]; toolUses: Map<string, number> } {
  const items: AssistantItem[] = [];
  const toolUses = new Map<string, number>();

  if (!Array.isArray(content)) return { items, toolUses };

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;

    if (it['type'] === 'text' && typeof it['text'] === 'string' && it['text'].trim()) {
      items.push({ kind: 'text', text: it['text'] });
    } else if (it['type'] === 'toolCall' || it['type'] === 'tool_use') {
      const name = typeof it['name'] === 'string' ? it['name'] : '?';
      const input = (it['input'] as Record<string, unknown> | undefined) ??
                    (it['parameters'] as Record<string, unknown> | undefined) ?? {};
      toolUses.set(name, (toolUses.get(name) ?? 0) + 1);
      items.push({ kind: 'tool', tool: { name, input } });
    }
  }

  return { items, toolUses };
}

function parseTimestamp(val: unknown): Date | null {
  if (!val) return null;
  const d = new Date(val as string);
  return isNaN(d.getTime()) ? null : d;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
