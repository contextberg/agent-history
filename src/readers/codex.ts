import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

export class CodexReader implements IReader {
  readonly source = 'codex' as const;

  async isInstalled(): Promise<boolean> {
    return exists(path.join(os.homedir(), '.codex', 'sessions'));
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    if (!await exists(sessionsRoot)) return [];

    const allFiles: { fp: string; mtime: Date }[] = [];

    try {
      await collectJsonlFiles(sessionsRoot, allFiles);
    } catch {
      return [];
    }

    const filtered = allFiles
      .filter((x) => {
        if (options.date) return isWithinDate(x.mtime, options.date);
        return true;
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, maxSessions);

    const sessions: AgentSession[] = [];
    for (const { fp } of filtered) {
      const session = await parseSession(fp, maxTurns, maxChars);
      if (session) sessions.push(session);
      if (sessions.length >= maxSessions) break;
    }

    return sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
}

async function collectJsonlFiles(
  dir: string,
  out: { fp: string; mtime: Date }[],
  depth = 0,
): Promise<void> {
  if (depth > 4) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const s = await fs.stat(fullPath).catch(() => null);
      if (s) out.push({ fp: fullPath, mtime: s.mtime });
    }
  }
}

async function parseSession(
  filePath: string,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  const turns: AgentTurn[] = [];
  let startedAt: Date | null = null;
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
    if (summary) {
      turns.push({ userMessage: pendingUserMessage, assistantSummary: summary, items: [...pendingItems] });
    }
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

      const type = root['type'] as string | undefined;
      const timestamp = parseTimestamp(root['timestamp']);

      if (type === 'thread.started') {
        if (timestamp && !startedAt) startedAt = timestamp;
        continue;
      }

      if (type === 'turn.started') {
        flushTurn();
        // input can be a string, array, or object with content
        const input = root['input'];
        const userText = extractUserText(input);
        if (userText) {
          pendingUserMessage = truncate(userText, maxChars);
          if (!startedAt) startedAt = timestamp ?? new Date();
        }
        continue;
      }

      if (type === 'item.completed') {
        const item = root['item'] as Record<string, unknown> | undefined;
        if (!item) continue;
        const itemType = item['type'] as string | undefined;

        if (itemType === 'agent_message' || itemType === 'message') {
          // Try various field names for text content
          const text = extractItemText(item);
          if (text) pendingItems.push({ kind: 'text', text });
        } else if (isToolType(itemType)) {
          const name = (item['name'] as string | undefined) ?? itemType ?? '?';
          const input = (item['input'] as Record<string, unknown> | undefined) ??
                        (item['arguments'] as Record<string, unknown> | undefined) ?? {};
          pendingTools.set(name, (pendingTools.get(name) ?? 0) + 1);
          pendingItems.push({ kind: 'tool', tool: { name, input } });
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
    source: 'codex',
    project: inferProject(filePath),
    startedAt: startedAt ?? stat?.mtime ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
}

function extractUserText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      if (it['role'] === 'user') {
        const c = it['content'];
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
          for (const part of c) {
            if (part && typeof part === 'object') {
              const p = part as Record<string, unknown>;
              if ((p['type'] === 'input_text' || p['type'] === 'text') && typeof p['text'] === 'string') return p['text'];
            }
          }
        }
      }
    }
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['content'] === 'string') return obj['content'];
  }
  return '';
}

function extractItemText(item: Record<string, unknown>): string {
  if (typeof item['text'] === 'string') return item['text'];
  const content = item['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if ((p['type'] === 'output_text' || p['type'] === 'text') && typeof p['text'] === 'string') {
        parts.push(p['text']);
      }
    }
    if (parts.length > 0) return parts.join(' ');
  }
  return '';
}

function isToolType(t: string | undefined): boolean {
  if (!t) return false;
  return t.includes('tool') || t.includes('function') || t.includes('command') || t.includes('mcp');
}

function inferProject(filePath: string): string {
  // ~/.codex/sessions/YYYY/MM/DD/rollout-<name>.jsonl → use filename
  const base = path.basename(filePath, '.jsonl');
  return base.startsWith('rollout-') ? base.slice('rollout-'.length) : base;
}

function parseTimestamp(val: unknown): Date | null {
  if (!val) return null;
  const d = new Date(val as string);
  return isNaN(d.getTime()) ? null : d;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
