import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

export class HermesReader implements IReader {
  readonly source = 'hermes' as const;

  async isInstalled(): Promise<boolean> {
    return (await sessionDirs()).length > 0;
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const dirs = await sessionDirs();
    if (dirs.length === 0) return [];

    const allFiles: { fp: string; mtime: Date }[] = [];
    for (const dir of dirs) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith('session_') || !entry.name.endsWith('.json')) continue;
        const fp = path.join(dir, entry.name);
        const stat = await fs.stat(fp).catch(() => null);
        if (stat) allFiles.push({ fp, mtime: stat.mtime });
      }
    }

    const filtered = allFiles
      .filter((x) => (options.date ? isWithinDate(x.mtime, options.date) : true))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, maxSessions);

    const sessions: AgentSession[] = [];
    for (const { fp } of filtered) {
      const session = await parseSession(fp, maxTurns, maxChars);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
}

interface HermesToolCall {
  id?: string;
  call_id?: string;
  function?: { name?: string; arguments?: string };
  name?: string;
  arguments?: string | Record<string, unknown>;
}

interface HermesMessage {
  role?: string;
  content?: unknown;
  tool_calls?: HermesToolCall[];
  tool_call_id?: string;
}

interface HermesSessionFile {
  session_id?: string;
  session_start?: string;
  platform?: string;
  messages?: HermesMessage[];
}

async function parseSession(
  filePath: string,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  let raw: string;
  try { raw = await fs.readFile(filePath, 'utf-8'); } catch { return null; }
  let data: HermesSessionFile;
  try { data = JSON.parse(raw) as HermesSessionFile; } catch { return null; }

  const messages = Array.isArray(data.messages) ? data.messages : [];

  let pendingUser: string | null = null;
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const pendingCallIndex = new Map<string, number>(); // tool_call_id -> pendingItems index
  const turns: AgentTurn[] = [];
  let firstUser: string | null = null;

  function flushTurn(): void {
    if (!pendingUser || pendingItems.length === 0) {
      pendingUser = null;
      pendingItems.length = 0;
      pendingTools.clear();
      pendingCallIndex.clear();
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
    pendingCallIndex.clear();
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      flushTurn();
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) {
        pendingUser = truncate(text, maxChars);
        if (!firstUser) firstUser = text;
      }
    } else if (msg.role === 'assistant' && pendingUser !== null) {
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (text) pendingItems.push({ kind: 'text', text: truncate(text, maxChars) });
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const call of calls) {
        const name = call.function?.name ?? call.name ?? '?';
        const argsRaw = call.function?.arguments ?? call.arguments;
        let input: Record<string, unknown> = {};
        if (typeof argsRaw === 'string') {
          try { input = JSON.parse(argsRaw) as Record<string, unknown>; } catch { /* ignore */ }
        } else if (argsRaw && typeof argsRaw === 'object') {
          input = argsRaw as Record<string, unknown>;
        }
        pendingTools.set(name, (pendingTools.get(name) ?? 0) + 1);
        const callId = call.id ?? call.call_id;
        const itemIndex = pendingItems.length;
        pendingItems.push({ kind: 'tool', tool: { name, input } });
        if (callId) pendingCallIndex.set(callId, itemIndex);
      }
    } else if (msg.role === 'tool' && pendingUser !== null && msg.tool_call_id) {
      const idx = pendingCallIndex.get(msg.tool_call_id);
      if (idx !== undefined) {
        const item = pendingItems[idx];
        if (item && item.kind === 'tool') {
          const raw = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
          item.tool.output = truncate(raw, maxChars);
        }
      }
    }
  }
  flushTurn();

  if (turns.length === 0) return null;

  const startedAt =
    parseDate(data.session_start) ??
    (await fs.stat(filePath).catch(() => null))?.mtime ??
    new Date();

  const project = firstUser
    ? (firstUser.split('\n').filter(Boolean)[0]?.slice(0, 40) ?? 'hermes')
    : 'hermes';

  return {
    id: data.session_id ?? randomUUID(),
    source: 'hermes',
    project,
    startedAt,
    turns: selectTurns(turns, maxTurns),
  };
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

async function sessionDirs(): Promise<string[]> {
  const dirs: string[] = [];

  const fromEnv = process.env.HERMES_SESSIONS_DIR;
  if (fromEnv) {
    for (const p of fromEnv.split(path.delimiter).map((x) => x.trim()).filter(Boolean)) {
      if (await exists(p)) dirs.push(p);
    }
  }

  const homeDir = path.join(os.homedir(), '.hermes', 'sessions');
  if (await exists(homeDir)) dirs.push(homeDir);

  if (process.platform === 'win32') {
    for (const d of await wslSessionDirs()) dirs.push(d);
  }

  return [...new Set(dirs)];
}

async function wslSessionDirs(): Promise<string[]> {
  const out: string[] = [];

  // Node cannot enumerate the UNC server root (\\wsl.localhost\), so we list
  // distros via `wsl.exe -l -q` (UTF-16LE output) and probe each share.
  const distros = await listWslDistros();
  if (distros.length === 0) return out;

  for (const distro of distros) {
    const homeRoot = `\\\\wsl.localhost\\${distro}\\home`;
    const entries = await fs.readdir(homeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(homeRoot, entry.name, '.hermes', 'sessions');
      if (await exists(candidate)) out.push(candidate);
    }
  }
  return out;
}

async function listWslDistros(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
    return stdout
      .toString('utf16le')
      .split(/\r?\n/)
      .map((s) => s.replace(/\0/g, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
