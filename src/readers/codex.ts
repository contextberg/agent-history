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
  let endedAt: Date | null = null;
  let cwd: string | undefined;
  let entrypoint: string | undefined;

  let pendingUserMessage: string | null = null;
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const pendingCallIndex = new Map<string, number>(); // call_id -> pendingItems index
  let pendingTurnStart: Date | null = null;
  let pendingTurnEnd: Date | null = null;
  let pendingTouchedFiles: Set<string> = new Set();
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
      const turn: AgentTurn = { userMessage: pendingUserMessage, assistantSummary: summary, items: [...pendingItems] };
      if (pendingTurnStart) turn.startedAt = pendingTurnStart;
      if (pendingTurnEnd) turn.endedAt = pendingTurnEnd;
      if (pendingTouchedFiles.size > 0) turn.touchedFiles = [...pendingTouchedFiles];
      turns.push(turn);
    }
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

      const type = root['type'] as string | undefined;
      const payload = root['payload'] as Record<string, unknown> | undefined;
      const lineTs = parseTimestamp(root['timestamp']);
      if (lineTs) endedAt = endedAt && endedAt.getTime() > lineTs.getTime() ? endedAt : lineTs;

      // Project name, cwd, and start time from session metadata
      if (type === 'session_meta' && payload) {
        const c = payload['cwd'] as string | undefined;
        if (c) {
          cwd = c;
          project = path.basename(c.replace(/[/\\]+$/, '')) || project;
        }
        const orig = payload['originator'] as string | undefined;
        if (orig) entrypoint = orig;
        const ts = payload['timestamp'] as string | undefined;
        if (ts) {
          const d = new Date(ts);
          if (!isNaN(d.getTime())) startedAt = d;
        }
        continue;
      }

      // turn_context can update cwd between turns
      if (type === 'turn_context' && payload) {
        const c = payload['cwd'] as string | undefined;
        if (c) cwd = c;
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
              pendingTurnStart = lineTs;
              pendingTurnEnd = lineTs;
              if (!startedAt) startedAt = lineTs ?? new Date();
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
        const callId = payload['call_id'] as string | undefined;
        const idx = pendingItems.length;
        pendingItems.push({ kind: 'tool', tool: { name, input } });
        if (callId) pendingCallIndex.set(callId, idx);
        for (const f of extractEditedFilesFromCodexCall(name, input, cwd)) pendingTouchedFiles.add(f);
        if (lineTs) pendingTurnEnd = lineTs;
        continue;
      }

      // Tool result (function_call_output)
      if (itemType === 'function_call_output' && pendingUserMessage !== null) {
        const callId = payload['call_id'] as string | undefined;
        if (!callId) continue;
        const idx = pendingCallIndex.get(callId);
        if (idx === undefined) continue;
        const target = pendingItems[idx];
        if (!target || target.kind !== 'tool') continue;
        const out = payload['output'];
        const outStr = typeof out === 'string' ? out : JSON.stringify(out ?? '');
        target.tool.output = truncate(outStr, maxChars);
      }
    }

    flushTurn();
  } catch {
    return null;
  }

  if (turns.length === 0) return null;

  const stat = await fs.stat(filePath).catch(() => null);
  const session: AgentSession = {
    id: randomUUID(),
    source: 'codex',
    project,
    startedAt: startedAt ?? stat?.mtime ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
  if (cwd) session.cwd = cwd;
  if (endedAt) session.endedAt = endedAt;
  if (entrypoint) session.entrypoint = entrypoint;
  return session;
}

/**
 * Best-effort file-path extraction from a codex function_call. Codex's tool
 * surface is mostly `shell_command` (where edits happen via apply_patch heredoc)
 * and `apply_patch`-style structured tools we haven't seen samples of. We err
 * conservative: only return paths from structured argument keys, never parse
 * shell command strings (too noisy / risk of false positives).
 */
function extractEditedFilesFromCodexCall(
  name: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): string[] {
  // shell_command with `apply_patch` is by far the most common edit channel.
  // The patch is in `command` as a string — we parse it for `*** Update File: <path>`
  // / `*** Add File: <path>` / `*** Delete File: <path>` markers (apply_patch's
  // own format), which are unambiguous and reliable.
  if (name === 'shell_command' || name === 'shell') {
    const cmd = typeof input['command'] === 'string'
      ? (input['command'] as string)
      : Array.isArray(input['command'])
        ? (input['command'] as unknown[]).filter((x) => typeof x === 'string').join(' ')
        : '';
    if (!cmd.includes('apply_patch')) return [];
    const out: string[] = [];
    const re = /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
      const raw = m[1]?.trim();
      if (!raw) continue;
      out.push(path.isAbsolute(raw) ? raw : (cwd ? path.resolve(cwd, raw) : raw));
    }
    return out;
  }

  // Generic: structured tools with a path-like key.
  for (const key of ['path', 'file_path', 'filepath', 'file', 'target_file']) {
    const v = input[key];
    if (typeof v === 'string' && v) {
      return [path.isAbsolute(v) ? v : (cwd ? path.resolve(cwd, v) : v)];
    }
  }
  const paths = input['paths'];
  if (Array.isArray(paths)) {
    return paths
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map((p) => (path.isAbsolute(p) ? p : (cwd ? path.resolve(cwd, p) : p)));
  }
  return [];
}

function parseTimestamp(val: unknown): Date | null {
  if (!val) return null;
  const d = new Date(val as string);
  return isNaN(d.getTime()) ? null : d;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
