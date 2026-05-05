import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

const DB_PATH = path.join(os.homedir(), '.hermes', 'state.db');

export class HermesReader implements IReader {
  readonly source = 'hermes' as const;

  async isInstalled(): Promise<boolean> {
    return fs.access(DB_PATH).then(() => true).catch(() => false);
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    if (!await this.isInstalled()) return [];

    let Database: typeof import('better-sqlite3').default;
    try {
      Database = (await import('better-sqlite3')).default;
    } catch {
      return [];
    }

    try {
      const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

      // Load sessions sorted by most recent message
      const sessionRows = db.prepare(`
        SELECT DISTINCT session_id,
               MIN(timestamp) AS started_at,
               MAX(timestamp) AS updated_at
        FROM messages
        GROUP BY session_id
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(maxSessions) as { session_id: string; started_at: number; updated_at: number }[];

      const sessions: AgentSession[] = [];

      for (const row of sessionRows) {
        const startedAt = new Date(row.started_at * 1000);

        if (options.date) {
          const d = options.date;
          const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
          const dayEnd = dayStart + 86400000;
          if (startedAt.getTime() < dayStart || startedAt.getTime() >= dayEnd) continue;
        }

        const msgRows = db.prepare(`
          SELECT role, content, tool_calls
          FROM messages
          WHERE session_id = ?
          ORDER BY timestamp ASC
        `).all(row.session_id) as { role: string; content: string | null; tool_calls: string | null }[];

        const turns: AgentTurn[] = [];
        let pendingUser: string | null = null;
        const pendingItems: AssistantItem[] = [];
        const pendingTools = new Map<string, number>();

        function flushTurn(): void {
          if (!pendingUser || pendingItems.length === 0) return;
          const textParts = pendingItems
            .filter((i): i is { kind: 'text'; text: string } => i.kind === 'text')
            .map((i) => i.text).join(' ');
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
          if (summary) turns.push({ userMessage: pendingUser!, assistantSummary: summary, items: [...pendingItems] });
          pendingUser = null;
          pendingItems.length = 0;
          pendingTools.clear();
        }

        for (const msg of msgRows) {
          if (msg.role === 'user') {
            flushTurn();
            if (msg.content?.trim()) pendingUser = truncate(msg.content.trim(), maxChars);
          } else if (msg.role === 'assistant' && pendingUser !== null) {
            if (msg.content?.trim()) pendingItems.push({ kind: 'text', text: msg.content.trim() });
            if (msg.tool_calls) {
              try {
                const calls = JSON.parse(msg.tool_calls) as { name: string; arguments?: Record<string, unknown> }[];
                for (const call of calls) {
                  const name = call.name ?? '?';
                  pendingTools.set(name, (pendingTools.get(name) ?? 0) + 1);
                  pendingItems.push({ kind: 'tool', tool: { name, input: call.arguments ?? {} } });
                }
              } catch { /* ignore malformed tool_calls */ }
            }
          }
        }
        flushTurn();

        if (turns.length === 0) continue;

        sessions.push({
          id: row.session_id,
          source: 'hermes',
          project: inferProject(db, row.session_id),
          startedAt,
          turns: selectTurns(turns, maxTurns),
        });
      }

      db.close();
      return sessions;
    } catch {
      return [];
    }
  }
}

function inferProject(
  db: import('better-sqlite3').Database,
  sessionId: string,
): string {
  try {
    const row = db.prepare(
      `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp ASC LIMIT 1`,
    ).get(sessionId) as { content: string } | undefined;
    if (row?.content) {
      const lines = row.content.split('\n').filter(Boolean);
      return lines[0]?.slice(0, 40) ?? 'hermes';
    }
  } catch { /* ignore */ }
  return 'hermes';
}
