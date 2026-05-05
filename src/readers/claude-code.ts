import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions, ToolCall } from './types.js';
import { truncate, extractProjectName, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

export class ClaudeCodeReader implements IReader {
  readonly source = 'claude-code' as const;

  async isInstalled(): Promise<boolean> {
    return exists(path.join(os.homedir(), '.claude', 'projects'));
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (!await exists(claudeDir)) return [];

    const sessions: AgentSession[] = [];

    try {
      const projectDirs = await fs.readdir(claudeDir);

      for (const dirName of projectDirs) {
        const projectDir = path.join(claudeDir, dirName);
        const stat = await fs.stat(projectDir).catch(() => null);
        if (!stat?.isDirectory()) continue;

        const projectName = extractProjectName(dirName);
        const files = await fs.readdir(projectDir);
        const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

        const withMtime = await Promise.all(
          jsonlFiles.map(async (f) => {
            const fp = path.join(projectDir, f);
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
          const session = await parseSession(fp, projectName, options.date, maxTurns, maxChars);
          if (session) sessions.push(session);
          if (sessions.length >= maxSessions) break;
        }

        if (sessions.length >= maxSessions) break;
      }
    } catch {
      // ディレクトリが読めない環境では空を返す
    }

    return sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, maxSessions);
  }
}

async function parseSession(
  filePath: string,
  projectName: string,
  targetDate: Date | undefined,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  const turns: AgentTurn[] = [];
  let startedAt: Date | null = null;
  let pendingUserMessage: string | null = null;
  // Ordered sequence of items within the current turn (text blocks and tool calls).
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      let root: Record<string, unknown>;
      try { root = JSON.parse(line); } catch { continue; }

      // ルートに type があればそれを使う。アシスタントは message.role で判定（新形式）
      const rootType = root['type'] as string | undefined;
      const msg = root['message'] as Record<string, unknown> | undefined;
      const msgRole = msg?.['role'] as string | undefined;
      const type = rootType ?? msgRole;
      const timestamp = parseTimestamp(root['timestamp'] ?? msg?.['created_at']);

      if (targetDate && timestamp && !isWithinDate(timestamp, targetDate)) continue;

      if (type === 'user') {
        const contentVal = msg?.['content'];
        // tool_result は配列になる → スキップ
        if (typeof contentVal !== 'string') continue;

        flushTurn(turns, pendingUserMessage, pendingItems, pendingTools, maxChars);
        pendingUserMessage = truncate(contentVal, maxChars);
        pendingItems.length = 0;
        pendingTools.clear();
        if (!startedAt) startedAt = timestamp ?? new Date();
      } else if ((type === 'assistant' || msgRole === 'assistant') && pendingUserMessage !== null) {
        const contentVal = msg?.['content'];
        if (!Array.isArray(contentVal)) continue;

        const { items, toolUses } = extractAssistantParts(contentVal);
        pendingItems.push(...items);
        for (const [name, count] of toolUses) {
          pendingTools.set(name, (pendingTools.get(name) ?? 0) + count);
        }
      }
    }

    flushTurn(turns, pendingUserMessage, pendingItems, pendingTools, maxChars);
  } catch {
    return null;
  }

  if (turns.length === 0) return null;

  return {
    id: randomUUID(),
    source: 'claude-code',
    project: projectName,
    startedAt: startedAt ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
}

function flushTurn(
  turns: AgentTurn[],
  userMessage: string | null,
  items: AssistantItem[],
  toolUses: Map<string, number>,
  maxChars: number,
): void {
  if (!userMessage || items.length === 0) return;

  // Build plain-text summary for MCP/copy output.
  const textParts = items.filter((i): i is { kind: 'text'; text: string } => i.kind === 'text');
  const combinedText = textParts.map((i) => i.text).join(' ');
  let summary = '';
  if (combinedText) {
    if (toolUses.size > 0) {
      const suffix = ' [' + [...toolUses.entries()].map(([k, v]) => `${k}×${v}`).join(', ') + ']';
      summary = truncate(combinedText, Math.max(0, maxChars - suffix.length)) + suffix;
    } else {
      summary = truncate(combinedText, maxChars);
    }
  } else if (toolUses.size > 0) {
    summary = '→ ' + [...toolUses.entries()].map(([k, v]) => `${k}×${v}`).join(', ');
  }

  turns.push({ userMessage, assistantSummary: summary, items: [...items] });
}

function extractAssistantParts(
  contentArray: unknown[],
): { items: AssistantItem[]; toolUses: Map<string, number> } {
  const items: AssistantItem[] = [];
  const toolUses = new Map<string, number>();

  for (const item of contentArray) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it['type'] === 'text' && typeof it['text'] === 'string' && it['text'].trim()) {
      items.push({ kind: 'text', text: it['text'] });
    } else if (it['type'] === 'tool_use') {
      const name = typeof it['name'] === 'string' ? it['name'] : '?';
      const input = (it['input'] as Record<string, unknown>) ?? {};
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
