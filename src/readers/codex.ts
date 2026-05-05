import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };
const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

export class CodexReader implements IReader {
  readonly source = 'codex' as const;

  async isInstalled(): Promise<boolean> {
    return exists(SESSIONS_ROOT);
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    if (!await exists(SESSIONS_ROOT)) return [];

    const allFiles: { fp: string; mtime: Date }[] = [];
    try {
      await collectJsonlFiles(SESSIONS_ROOT, allFiles);
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
  let project = 'codex';
  let startedAt: Date | null = null;

  let pendingUserMessage: string | null = null;
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const turns: AgentTurn[] = [];

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
      const payload = root['payload'] as Record<string, unknown> | undefined;

      // Project name and start time from session metadata
      if (type === 'session_meta' && payload) {
        const cwd = payload['cwd'] as string | undefined;
        if (cwd) project = path.basename(cwd.replace(/[/\\]+$/, '')) || project;
        const ts = payload['timestamp'] as string | undefined;
        if (ts) {
          const d = new Date(ts);
          if (!isNaN(d.getTime())) startedAt = d;
        }
        continue;
      }

      if (type !== 'response_item' || !payload) continue;

      const role = payload['role'] as string | undefined;
      const itemType = payload['type'] as string | undefined;

      // User message — skip system/environment injections
      if (role === 'user') {
        const contentArr = payload['content'] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(contentArr)) continue;
        for (const c of contentArr) {
          if (c['type'] === 'input_text' && typeof c['text'] === 'string') {
            const text = (c['text'] as string).trim();
            if (text && !text.startsWith('<environment_context>')) {
              flushTurn();
              pendingUserMessage = truncate(text, maxChars);
              if (!startedAt) startedAt = new Date();
            }
          }
        }
        continue;
      }

      // Assistant text response
      if (role === 'assistant' && pendingUserMessage !== null) {
        const contentArr = payload['content'] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(contentArr)) continue;
        for (const c of contentArr) {
          if (c['type'] === 'output_text' && typeof c['text'] === 'string') {
            const text = (c['text'] as string).trim();
            if (text) pendingItems.push({ kind: 'text', text: truncate(text, maxChars) });
          }
        }
        continue;
      }

      // Tool call (function_call)
      if (itemType === 'function_call' && pendingUserMessage !== null) {
        const name = (payload['name'] as string | undefined) ?? '?';
        const argsRaw = payload['arguments'];
        let input: Record<string, unknown> = {};
        if (typeof argsRaw === 'string') {
          try { input = JSON.parse(argsRaw) as Record<string, unknown>; } catch { /* use empty */ }
        } else if (argsRaw && typeof argsRaw === 'object') {
          input = argsRaw as Record<string, unknown>;
        }
        pendingTools.set(name, (pendingTools.get(name) ?? 0) + 1);
        pendingItems.push({ kind: 'tool', tool: { name, input } });
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
    project,
    startedAt: startedAt ?? stat?.mtime ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
