import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

interface ConversationHeader { bubbleId: string; type?: number }

interface ComposerSummary {
  id: string;
  name: string | null;
  createdAt: number;
  lastUpdatedAt: number;
  headers: ConversationHeader[];
}

export class CursorReader implements IReader {
  readonly source = 'cursor' as const;

  async isInstalled(): Promise<boolean> {
    return exists(dbPath());
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const dbp = dbPath();
    if (!await exists(dbp)) return [];

    let Database: typeof import('better-sqlite3');
    try {
      Database = (await import('better-sqlite3')).default;
    } catch {
      return [];
    }

    let db: import('better-sqlite3').Database;
    try {
      db = new Database(dbp, { readonly: true, fileMustExist: true });
    } catch {
      return [];
    }

    try {
      const composerRows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as { key: string; value: string | null }[];

      const composers: ComposerSummary[] = [];
      for (const row of composerRows) {
        if (!row.value) continue;
        let cd: Record<string, unknown>;
        try { cd = JSON.parse(row.value) as Record<string, unknown>; } catch { continue; }

        const headers = Array.isArray(cd['fullConversationHeadersOnly'])
          ? (cd['fullConversationHeadersOnly'] as ConversationHeader[])
          : Array.isArray(cd['conversation'])
            ? (cd['conversation'] as ConversationHeader[])
            : [];
        if (headers.length === 0) continue;

        const id = row.key.slice('composerData:'.length);
        composers.push({
          id,
          name: typeof cd['name'] === 'string' ? cd['name'] : null,
          createdAt: numberOr(cd['createdAt'], 0),
          lastUpdatedAt: numberOr(cd['lastUpdatedAt'], numberOr(cd['createdAt'], 0)),
          headers,
        });
      }

      composers.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);

      const filtered = composers
        .filter((c) => {
          if (!options.date) return true;
          const t = c.lastUpdatedAt || c.createdAt;
          return t > 0 && isWithinDate(new Date(t), options.date);
        })
        .slice(0, maxSessions);

      const sessions: AgentSession[] = [];
      for (const c of filtered) {
        const session = parseComposer(c, db, maxTurns, maxChars);
        if (session) sessions.push(session);
      }
      return sessions;
    } finally {
      db.close();
    }
  }
}

function parseComposer(
  c: ComposerSummary,
  db: import('better-sqlite3').Database,
  maxTurns: number,
  maxChars: number,
): AgentSession | null {
  // Bulk-load all bubbles for this composer in a single query, then index by bubbleId.
  const bubbleRows = db
    .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
    .all(`bubbleId:${c.id}:%`) as { key: string; value: string | null }[];

  const prefix = `bubbleId:${c.id}:`;
  const bubblesById = new Map<string, Record<string, unknown>>();
  for (const row of bubbleRows) {
    if (!row.value) continue;
    try {
      const b = JSON.parse(row.value);
      if (b && typeof b === 'object') {
        bubblesById.set(row.key.slice(prefix.length), b);
      }
    } catch { /* skip */ }
  }

  let pendingUser: string | null = null;
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const turns: AgentTurn[] = [];

  function flushTurn(): void {
    if (!pendingUser || pendingItems.length === 0) {
      pendingUser = null;
      pendingItems.length = 0;
      pendingTools.clear();
      return;
    }
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
      turns.push({ userMessage: pendingUser, assistantSummary: summary, items: [...pendingItems] });
    }
    pendingUser = null;
    pendingItems.length = 0;
    pendingTools.clear();
  }

  for (const h of c.headers) {
    const b = bubblesById.get(h.bubbleId);
    if (!b) continue;

    const type = (typeof h.type === 'number' ? h.type : (b['type'] as number | undefined)) ?? 0;

    if (type === 1) {
      flushTurn();
      const text = typeof b['text'] === 'string' ? (b['text'] as string).trim() : '';
      if (text) pendingUser = truncate(text, maxChars);
      continue;
    }

    if (type !== 2 || pendingUser === null) continue;

    const text = typeof b['text'] === 'string' ? (b['text'] as string).trim() : '';
    if (text) pendingItems.push({ kind: 'text', text: truncate(text, maxChars) });

    const tfd = b['toolFormerData'] as Record<string, unknown> | undefined;
    if (tfd && typeof tfd === 'object') {
      const name = typeof tfd['name'] === 'string' ? (tfd['name'] as string) : '?';
      pendingTools.set(name, (pendingTools.get(name) ?? 0) + 1);
      pendingItems.push({
        kind: 'tool',
        tool: {
          name,
          input: extractToolInput(tfd),
          ...maybeOutput(tfd, maxChars),
        },
      });
    }
  }
  flushTurn();

  if (turns.length === 0) return null;

  const startedAt = c.createdAt > 0
    ? new Date(c.createdAt)
    : c.lastUpdatedAt > 0
      ? new Date(c.lastUpdatedAt)
      : new Date();

  return {
    id: c.id,
    source: 'cursor',
    project: (c.name ?? 'cursor').slice(0, 60) || 'cursor',
    startedAt,
    turns: selectTurns(turns, maxTurns),
  };
}

function extractToolInput(tfd: Record<string, unknown>): Record<string, unknown> {
  // Prefer the parsed params; fall back to rawArgs. Both are JSON-encoded strings.
  for (const key of ['params', 'rawArgs']) {
    const raw = tfd[key];
    if (typeof raw === 'string' && raw.length) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          // Drop noisy plumbing fields that aren't meaningful for browsing.
          const { repositoryInfo: _ri, explanation: _ex, ...rest } = parsed;
          return rest;
        }
      } catch { /* try next */ }
    } else if (raw && typeof raw === 'object') {
      return raw as Record<string, unknown>;
    }
  }
  return {};
}

function maybeOutput(tfd: Record<string, unknown>, maxChars: number): { output?: string } {
  const result = tfd['result'];
  if (result == null) return {};
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  if (!s) return {};
  return { output: truncate(s, maxChars) };
}

function dbPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
