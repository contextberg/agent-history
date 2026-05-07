import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';
import { wslHomePaths } from './wsl.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

export class OpenClawReader implements IReader {
  readonly source = 'openclaw' as const;

  async isInstalled(): Promise<boolean> {
    return (await agentsRoots()).length > 0;
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const roots = await agentsRoots();
    if (roots.length === 0) return [];

    const sessions: AgentSession[] = [];

    for (const agentsDir of roots) {
      try {
        const agentDirs = await fs.readdir(agentsDir);

        for (const agentDir of agentDirs) {
          const sessionsDir = path.join(agentsDir, agentDir, 'sessions');
          if (!await exists(sessionsDir)) continue;

          const files = await fs.readdir(sessionsDir);
          const jsonlFiles = files.filter(
            (f) =>
              (f.endsWith('.jsonl') && !f.endsWith('.trajectory.jsonl')) ||
              f.includes('.jsonl.reset.'),
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

      if (sessions.length >= maxSessions) break;
    }

    return sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, maxSessions);
  }
}

async function agentsRoots(): Promise<string[]> {
  const out: string[] = [];

  const native = path.join(os.homedir(), '.openclaw', 'agents');
  if (await exists(native)) out.push(native);

  for (const d of await wslHomePaths(path.join('.openclaw', 'agents'))) out.push(d);

  return [...new Set(out)];
}

async function parseSession(
  filePath: string,
  targetDate: Date | undefined,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  const turns: AgentTurn[] = [];
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  let cwd: string | undefined;
  let projectName = 'openclaw';
  let pendingUserMessage: string | null = null;
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const pendingCallIndex = new Map<string, number>(); // toolCall.id -> pendingItems index
  let pendingTurnStart: Date | null = null;
  let pendingTurnEnd: Date | null = null;
  let pendingTouchedFiles: Set<string> = new Set();
  // Distinct cwds observed in exec toolResult.details.cwd. When the agent
  // shells into a repo different from the workspace, these expose it.
  const observedExecCwds = new Set<string>();

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
    const turn: AgentTurn = { userMessage: pendingUserMessage, assistantSummary: summary, items: [...pendingItems] };
    if (pendingTurnStart) turn.startedAt = pendingTurnStart;
    if (pendingTurnEnd) turn.endedAt = pendingTurnEnd;
    if (pendingTouchedFiles.size > 0) turn.touchedFiles = [...pendingTouchedFiles];
    turns.push(turn);
    pendingUserMessage = null;
    pendingItems.length = 0;
    pendingTools.clear();
    pendingCallIndex.clear();
    pendingTurnStart = null;
    pendingTurnEnd = null;
    pendingTouchedFiles = new Set();
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      let root: Record<string, unknown>;
      try { root = JSON.parse(line); } catch { continue; }

      const type = root['type'];

      if (type === 'session') {
        const sessCwd = root['cwd'];
        if (typeof sessCwd === 'string') {
          cwd = sessCwd;
          projectName = path.basename(sessCwd.replace(/[/\\]+$/, '')) || projectName;
        }
        const ts = parseTimestamp(root['timestamp']);
        if (ts) startedAt = ts;
        continue;
      }

      if (type !== 'message') continue;

      const timestamp = parseTimestamp(root['timestamp']);
      if (!timestamp) continue;
      if (targetDate && !isWithinDate(timestamp, targetDate)) continue;
      endedAt = endedAt && endedAt.getTime() > timestamp.getTime() ? endedAt : timestamp;

      const msg = root['message'] as Record<string, unknown> | undefined;
      const role = msg?.['role'];

      if (role === 'toolResult' && pendingUserMessage !== null) {
        const callId = msg?.['toolCallId'] as string | undefined;
        // exec results carry `details.cwd` — the absolute working directory
        // the command actually ran in. Captured even when we can't attach
        // the result to a tool item (callId missing) so a `cd <repo> && git`
        // sequence still surfaces the repo.
        const details = msg?.['details'] as Record<string, unknown> | undefined;
        const detailsCwd = details?.['cwd'];
        if (typeof detailsCwd === 'string' && detailsCwd) observedExecCwds.add(detailsCwd);
        if (!callId) continue;
        const idx = pendingCallIndex.get(callId);
        if (idx === undefined) continue;
        const target = pendingItems[idx];
        if (!target || target.kind !== 'tool') continue;
        target.tool.output = truncate(stringifyOpenClawResult(msg?.['content']), maxChars);
        continue;
      }

      if (role === 'user') {
        flushTurn();
        const contentVal = msg?.['content'];
        const text = extractFirstText(contentVal);
        if (text.trim()) {
          pendingUserMessage = truncate(text, maxChars);
          pendingTurnStart = timestamp;
          pendingTurnEnd = timestamp;
          if (!startedAt) startedAt = timestamp;
        }
      } else if (role === 'assistant' && pendingUserMessage !== null) {
        const contentVal = msg?.['content'];
        const { items, toolUses, idIndex, files } = extractAssistantParts(contentVal, pendingItems.length, cwd);
        pendingItems.push(...items);
        for (const [name, count] of toolUses) {
          pendingTools.set(name, (pendingTools.get(name) ?? 0) + count);
        }
        for (const [id, idx] of idIndex) pendingCallIndex.set(id, idx);
        for (const f of files) pendingTouchedFiles.add(f);
        pendingTurnEnd = timestamp;
      }
    }

    flushTurn();
  } catch {
    return null;
  }

  if (turns.length === 0) return null;

  const session: AgentSession = {
    id: randomUUID(),
    source: 'openclaw',
    project: projectName,
    startedAt: startedAt ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
  if (cwd) session.cwd = cwd;
  if (endedAt) session.endedAt = endedAt;
  // Surface only exec cwds that differ from the primary cwd — duplicates of
  // the workspace dir provide no new repo-discovery signal.
  const primary = cwd;
  const extras = [...observedExecCwds].filter((c) => c !== primary);
  if (extras.length > 0) session.additionalCwds = extras;
  return session;
}

// OpenClaw injects system content before user messages. The actual user text
// follows a "[DayAbbr YYYY-MM-DD HH:MM GMT±N]" timestamp at the end of the content.
const OC_TIMESTAMP_RE = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+\-][\d]+\]\s+([\s\S]+)$/;

function extractFirstText(content: unknown): string {
  const raw = rawText(content);
  if (!raw) return '';
  const m = raw.match(OC_TIMESTAMP_RE);
  return m ? m[1]!.trim() : '';
}

function rawText(content: unknown): string {
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
  baseOffset: number,
  cwd: string | undefined,
): { items: AssistantItem[]; toolUses: Map<string, number>; idIndex: Map<string, number>; files: string[] } {
  const items: AssistantItem[] = [];
  const toolUses = new Map<string, number>();
  const idIndex = new Map<string, number>();
  const files: string[] = [];

  if (!Array.isArray(content)) return { items, toolUses, idIndex, files };

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;

    if (it['type'] === 'text' && typeof it['text'] === 'string' && it['text'].trim()) {
      items.push({ kind: 'text', text: it['text'] });
    } else if (it['type'] === 'toolCall' || it['type'] === 'tool_use') {
      const name = typeof it['name'] === 'string' ? it['name'] : '?';
      const input = (it['input'] as Record<string, unknown> | undefined) ??
                    (it['parameters'] as Record<string, unknown> | undefined) ??
                    (it['arguments'] as Record<string, unknown> | undefined) ?? {};
      toolUses.set(name, (toolUses.get(name) ?? 0) + 1);
      const id = typeof it['id'] === 'string' ? it['id'] : undefined;
      const idx = baseOffset + items.length;
      items.push({ kind: 'tool', tool: { name, input } });
      if (id) idIndex.set(id, idx);
      // Edit-only file extraction. OpenClaw's write tool takes a `path`;
      // read/exec/etc. are exploration noise that would muddy commit linkage.
      if (name === 'write' || name === 'edit') {
        const p = input['path'] ?? input['file_path'];
        if (typeof p === 'string' && p) {
          files.push(path.isAbsolute(p) ? p : (cwd ? path.resolve(cwd, p) : p));
        }
      }
    }
  }

  return { items, toolUses, idIndex, files };
}

function stringifyOpenClawResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>;
      if (typeof it['text'] === 'string') { parts.push(it['text']); continue; }
    }
    parts.push(JSON.stringify(item));
  }
  return parts.join('\n');
}

function parseTimestamp(val: unknown): Date | null {
  if (!val) return null;
  const d = new Date(val as string);
  return isNaN(d.getTime()) ? null : d;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
