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

    // Read both sources and merge. state.db has per-message timestamps and
    // parent_session_id (resume) — richer than the legacy session_*.json — but
    // doesn't always cover every session, so JSON is kept as a fallback.
    const [dbSessions, jsonSessions] = await Promise.all([
      loadAllStateDbs(dirs, maxTurns, maxChars).catch(() => [] as AgentSession[]),
      loadJsonSessions(dirs, options, maxTurns, maxChars),
    ]);

    const byId = new Map<string, AgentSession>();
    for (const s of jsonSessions) byId.set(s.id, s);
    for (const s of dbSessions) byId.set(s.id, s); // DB wins on collision

    return [...byId.values()]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, maxSessions);
  }
}

async function loadJsonSessions(
  dirs: string[],
  options: ReaderOptions,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession[]> {
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
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const sessions: AgentSession[] = [];
  for (const { fp } of filtered) {
    const session = await parseSession(fp, maxTurns, maxChars);
    if (session) sessions.push(session);
  }
  return sessions;
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
  last_updated?: string;
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
  let pendingTouchedFiles: Set<string> = new Set();
  const turns: AgentTurn[] = [];
  let firstUser: string | null = null;
  // Hermes doesn't record cwd; we scan tool outputs for git SHAs as a way to
  // infer which repo the session was in. The aggregator then matches these
  // against fetched commit SHAs to attribute the session to a repo.
  const referencedCommits = new Set<string>();
  // Absolute paths the agent referenced in `terminal` commands. WSL paths
  // (`/mnt/c/...`) are translated to Windows drive paths so they line up with
  // commit.repo strings produced by the Windows-side git binary.
  const observedCwds = new Set<string>();

  function flushTurn(): void {
    if (!pendingUser || pendingItems.length === 0) {
      pendingUser = null;
      pendingItems.length = 0;
      pendingTools.clear();
      pendingCallIndex.clear();
      pendingTouchedFiles = new Set();
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
      const turn: AgentTurn = { userMessage: pendingUser, assistantSummary: summary, items: [...pendingItems] };
      if (pendingTouchedFiles.size > 0) turn.touchedFiles = [...pendingTouchedFiles];
      turns.push(turn);
    }
    pendingUser = null;
    pendingItems.length = 0;
    pendingTools.clear();
    pendingCallIndex.clear();
    pendingTouchedFiles = new Set();
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
        // write_file is hermes' edit channel. Path is usually relative; we
        // keep it as-is — the scorer/aggregator handles abs-vs-rel matching.
        if (name === 'write_file' || name === 'edit_file') {
          const p = input['path'] ?? input['file_path'];
          if (typeof p === 'string' && p) pendingTouchedFiles.add(p);
        }
        // terminal commands carry the only cwd signal hermes exposes — mine
        // absolute paths from the command string.
        if (name === 'terminal') {
          const cmd = input['command'];
          if (typeof cmd === 'string') {
            for (const p of extractAbsolutePaths(cmd)) observedCwds.add(p);
          }
        }
      }
    } else if (msg.role === 'tool' && pendingUser !== null && msg.tool_call_id) {
      const idx = pendingCallIndex.get(msg.tool_call_id);
      const raw = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      // Mine SHAs out of any tool result (most often `git log`/`git diff`).
      for (const sha of extractShas(raw)) referencedCommits.add(sha);
      if (idx !== undefined) {
        const item = pendingItems[idx];
        if (item && item.kind === 'tool') {
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
  const endedAt = parseDate(data.last_updated);

  const project = firstUser
    ? (firstUser.split('\n').filter(Boolean)[0]?.slice(0, 40) ?? 'hermes')
    : 'hermes';

  const session: AgentSession = {
    id: data.session_id ?? randomUUID(),
    source: 'hermes',
    project,
    startedAt,
    turns: selectTurns(turns, maxTurns),
  };
  if (endedAt) session.endedAt = endedAt;
  if (referencedCommits.size > 0) session.referencedCommits = [...referencedCommits];
  if (observedCwds.size > 0) session.additionalCwds = [...observedCwds];
  return session;
}

/**
 * Pull plausible absolute paths out of a shell command string.
 *
 * Hermes runs in WSL where the path that matters for our linkage is the
 * underlying Windows path (because git/findRepoRoot run on Windows). We
 * translate `/mnt/<drive>/...` → `<DRIVE>:\...` so the result lines up with
 * `commit.repo`. Linux-only paths (`/home/...`, `/etc/...`) are skipped —
 * they can't be a Windows git repo root.
 *
 * Tilde expansion (`~/...`) is not attempted: we don't know the user's home,
 * and the path lives on the WSL side anyway.
 *
 * Yields *directories*. If a path looks like a file (last segment has a
 * common extension), the parent directory is returned instead.
 */
function extractAbsolutePaths(cmd: string): string[] {
  const out: string[] = [];
  // Match /mnt/<letter>/<rest>, capturing rest until a shell metacharacter or quote.
  const re = /\/mnt\/([a-z])((?:\/[^\s"'`;|&<>]+)+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const drive = m[1]!.toUpperCase();
    let rest = m[2]!.replace(/\//g, '\\');
    // If the path tail looks like a file (has a "." in the last segment),
    // strip it to the containing directory.
    const lastSlash = rest.lastIndexOf('\\');
    if (lastSlash >= 0) {
      const tail = rest.slice(lastSlash + 1);
      if (/\.[A-Za-z0-9]{1,8}$/.test(tail)) rest = rest.slice(0, lastSlash);
    }
    out.push(`${drive}:${rest}`);
  }
  return out;
}

/**
 * Pull plausible git SHAs out of arbitrary text. A SHA is a 7–40 char
 * lowercase hex string. We also require at least one a-f character to
 * filter out things like `20260321` (a date that happens to be all digits).
 */
function extractShas(text: string): string[] {
  const out: string[] = [];
  const re = /\b[a-f0-9]{7,40}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0];
    if (/[a-f]/.test(s)) out.push(s);
  }
  return out;
}

interface StateDbSessionRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  parent_session_id: string | null;
  title: string | null;
}
interface StateDbMessageRow {
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  timestamp: number;
}

/**
 * Read every reachable Hermes state.db (one per WSL distro home / one per
 * native install). Returns sessions in the same shape as the JSON reader,
 * but with per-message timestamps (enabling edit-window scoring) and
 * resumedFrom populated from parent_session_id.
 *
 * Hermes keeps the DB in WAL mode and may have it open while running; we
 * sidestep SQLITE_BUSY by copying the file to a temp location before
 * reading. The copy is cheap (low MB).
 */
async function loadAllStateDbs(
  sessionDirsList: string[],
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession[]> {
  let Database: typeof import('better-sqlite3');
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return [];
  }

  // state.db sits one level up from the sessions/ dirs.
  const dbPaths = new Set<string>();
  for (const d of sessionDirsList) {
    const candidate = path.join(d, '..', 'state.db');
    if (await exists(candidate)) dbPaths.add(path.normalize(candidate));
  }
  if (dbPaths.size === 0) return [];

  const out: AgentSession[] = [];
  for (const dbPath of dbPaths) {
    const sessions = await loadOneStateDb(Database, dbPath, maxTurns, maxChars).catch(() => []);
    out.push(...sessions);
  }
  return out;
}

async function loadOneStateDb(
  Database: typeof import('better-sqlite3'),
  dbPath: string,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession[]> {
  // Copy to bypass the WAL lock that the live hermes process may hold.
  const tmpPath = path.join(os.tmpdir(), `agent-history-hermes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  try {
    await fs.copyFile(dbPath, tmpPath);
  } catch {
    return [];
  }

  let db: import('better-sqlite3').Database;
  try {
    db = new Database(tmpPath, { readonly: true, fileMustExist: true });
  } catch {
    fs.unlink(tmpPath).catch(() => undefined);
    return [];
  }

  try {
    const sessRows = db
      .prepare(
        'SELECT id, started_at, ended_at, parent_session_id, title FROM sessions ORDER BY started_at DESC',
      )
      .all() as StateDbSessionRow[];

    const out: AgentSession[] = [];
    for (const row of sessRows) {
      const msgs = db
        .prepare(
          'SELECT role, content, tool_calls, tool_call_id, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC',
        )
        .all(row.id) as StateDbMessageRow[];
      const session = buildSessionFromDbRows(row, msgs, maxTurns, maxChars);
      if (session) out.push(session);
    }
    return out;
  } finally {
    db.close();
    fs.unlink(tmpPath).catch(() => undefined);
  }
}

/**
 * Convert state.db's per-message rows into our AgentSession shape. The
 * payoff over the JSON reader: each turn gets `startedAt`/`endedAt` from
 * the actual message timestamps, which lets the linkage scorer use a real
 * edit-active window instead of falling back to the whole session span.
 */
function buildSessionFromDbRows(
  sess: StateDbSessionRow,
  msgs: StateDbMessageRow[],
  maxTurns: number,
  maxChars: number,
): AgentSession | null {
  const turns: AgentTurn[] = [];
  let pendingUser: string | null = null;
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const pendingCallIndex = new Map<string, number>();
  let pendingTurnStart: Date | null = null;
  let pendingTurnEnd: Date | null = null;
  let pendingTouchedFiles: Set<string> = new Set();
  const referencedCommits = new Set<string>();
  const observedCwds = new Set<string>();
  let firstUser: string | null = null;

  function flushTurn(): void {
    if (!pendingUser || pendingItems.length === 0) {
      pendingUser = null;
      pendingItems.length = 0;
      pendingTools.clear();
      pendingCallIndex.clear();
      pendingTurnStart = null;
      pendingTurnEnd = null;
      pendingTouchedFiles = new Set();
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
      const turn: AgentTurn = { userMessage: pendingUser, assistantSummary: summary, items: [...pendingItems] };
      if (pendingTurnStart) turn.startedAt = pendingTurnStart;
      if (pendingTurnEnd) turn.endedAt = pendingTurnEnd;
      if (pendingTouchedFiles.size > 0) turn.touchedFiles = [...pendingTouchedFiles];
      turns.push(turn);
    }
    pendingUser = null;
    pendingItems.length = 0;
    pendingTools.clear();
    pendingCallIndex.clear();
    pendingTurnStart = null;
    pendingTurnEnd = null;
    pendingTouchedFiles = new Set();
  }

  for (const m of msgs) {
    const ts = msgTimestamp(m.timestamp);
    if (m.role === 'user') {
      flushTurn();
      const text = (m.content ?? '').trim();
      if (text) {
        pendingUser = truncate(text, maxChars);
        if (!firstUser) firstUser = text;
        pendingTurnStart = ts;
        pendingTurnEnd = ts;
      }
    } else if (m.role === 'assistant' && pendingUser !== null) {
      const text = (m.content ?? '').trim();
      if (text) pendingItems.push({ kind: 'text', text: truncate(text, maxChars) });
      let calls: HermesToolCall[] = [];
      if (m.tool_calls) {
        try { calls = JSON.parse(m.tool_calls) as HermesToolCall[]; } catch { /* ignore */ }
      }
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
        if (name === 'write_file' || name === 'edit_file') {
          const p = input['path'] ?? input['file_path'];
          if (typeof p === 'string' && p) pendingTouchedFiles.add(p);
        }
        if (name === 'terminal') {
          const cmd = input['command'];
          if (typeof cmd === 'string') {
            for (const p of extractAbsolutePaths(cmd)) observedCwds.add(p);
          }
        }
      }
      pendingTurnEnd = ts;
    } else if (m.role === 'tool' && pendingUser !== null) {
      const raw = m.content ?? '';
      for (const sha of extractShas(raw)) referencedCommits.add(sha);
      const idx = m.tool_call_id ? pendingCallIndex.get(m.tool_call_id) : undefined;
      if (idx !== undefined) {
        const item = pendingItems[idx];
        if (item && item.kind === 'tool') item.tool.output = truncate(raw, maxChars);
      }
      pendingTurnEnd = ts;
    }
  }
  flushTurn();

  if (turns.length === 0) return null;

  const startedAt = msgTimestamp(sess.started_at) ?? new Date();
  const endedAt = sess.ended_at ? msgTimestamp(sess.ended_at) : null;
  const project = sess.title ?? (firstUser?.split('\n')[0]?.slice(0, 40) ?? 'hermes');

  const session: AgentSession = {
    id: sess.id,
    source: 'hermes',
    project: project.slice(0, 60) || 'hermes',
    startedAt,
    turns: selectTurns(turns, maxTurns),
  };
  if (endedAt) session.endedAt = endedAt;
  if (sess.parent_session_id) session.resumedFrom = sess.parent_session_id;
  if (referencedCommits.size > 0) session.referencedCommits = [...referencedCommits];
  if (observedCwds.size > 0) session.additionalCwds = [...observedCwds];
  return session;
}

function msgTimestamp(epochSec: number | null | undefined): Date | null {
  if (typeof epochSec !== 'number' || !isFinite(epochSec)) return null;
  // state.db stores REAL epoch seconds (with sub-second fraction).
  return new Date(epochSec * 1000);
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
