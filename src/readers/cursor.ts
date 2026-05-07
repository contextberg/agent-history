import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
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

type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync;

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

    // node:sqlite is stable in Node 23.7+ / 24+. On older Node it either
    // throws (no module) or is gated behind --experimental-sqlite — degrade
    // silently in either case. The specifier is built indirectly so esbuild
    // does not rewrite the `node:` prefix during bundling.
    let Database: DatabaseSyncCtor;
    try {
      const mod = (await import(nodeSqliteSpecifier())) as typeof import('node:sqlite');
      Database = mod.DatabaseSync;
    } catch {
      return [];
    }

    let db: DatabaseSync;
    try {
      db = new Database(dbp, { readOnly: true });
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

      const composerToCwd = await loadComposerToCwd(Database);

      const sessions: AgentSession[] = [];
      for (const c of filtered) {
        const session = parseComposer(c, db, maxTurns, maxChars, composerToCwd.get(c.id));
        if (session) sessions.push(session);
      }
      return sessions;
    } finally {
      db.close();
    }
  }
}

/**
 * Walk Cursor's per-workspace storage to build composerId → cwd. Each workspace
 * dir holds a `workspace.json` with `{folder: "file:///..."}` and a
 * `state.vscdb` whose ItemTable row `composer.composerData` lists the
 * composers attached to that workspace. Failures fail soft (returns whatever
 * we managed to read).
 */
async function loadComposerToCwd(
  Database: DatabaseSyncCtor,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wsRoot = workspaceStorageRoot();
  if (!await exists(wsRoot)) return out;

  let dirs: string[];
  try { dirs = await fs.readdir(wsRoot); } catch { return out; }

  for (const d of dirs) {
    const wsJsonPath = path.join(wsRoot, d, 'workspace.json');
    let folder: string | null = null;
    try {
      const raw = await fs.readFile(wsJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { folder?: string };
      folder = parsed.folder ?? null;
    } catch { continue; }
    if (!folder) continue;

    const cwd = fileUriToPath(folder);
    if (!cwd) continue;

    const dbPath = path.join(wsRoot, d, 'state.vscdb');
    if (!await exists(dbPath)) continue;
    let wdb: DatabaseSync;
    try { wdb = new Database(dbPath, { readOnly: true }); } catch { continue; }
    try {
      const row = wdb
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value: string | null } | undefined;
      if (!row?.value) continue;
      let parsed: { allComposers?: Array<{ composerId?: string }> };
      try { parsed = JSON.parse(row.value); } catch { continue; }
      const list = parsed?.allComposers ?? [];
      for (const c of list) {
        if (typeof c.composerId === 'string') out.set(c.composerId, cwd);
      }
    } finally { wdb.close(); }
  }
  return out;
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  let p = decodeURIComponent(uri.slice('file://'.length));
  // file:///c:/... → starts with '/c:/' on Windows; strip leading '/'
  if (process.platform === 'win32' && /^\/[a-z]:/i.test(p)) p = p.slice(1);
  return path.normalize(p);
}

function workspaceStorageRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'workspaceStorage');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'workspaceStorage');
}

function parseComposer(
  c: ComposerSummary,
  db: DatabaseSync,
  maxTurns: number,
  maxChars: number,
  cwd: string | undefined,
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
  let pendingTurnStart: Date | null = null;
  let pendingTurnEnd: Date | null = null;
  let pendingTouchedFiles: Set<string> = new Set();
  const turns: AgentTurn[] = [];
  let lastBubbleEnd: Date | null = null;

  function flushTurn(): void {
    if (!pendingUser || pendingItems.length === 0) {
      pendingUser = null;
      pendingItems.length = 0;
      pendingTools.clear();
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
    pendingTurnStart = null;
    pendingTurnEnd = null;
    pendingTouchedFiles = new Set();
  }

  for (const h of c.headers) {
    const b = bubblesById.get(h.bubbleId);
    if (!b) continue;

    const type = (typeof h.type === 'number' ? h.type : (b['type'] as number | undefined)) ?? 0;
    const { startedAt: bStart, endedAt: bEnd } = extractBubbleTimings(b);
    if (bEnd) lastBubbleEnd = bEnd;

    if (type === 1) {
      flushTurn();
      const text = typeof b['text'] === 'string' ? (b['text'] as string).trim() : '';
      if (text) pendingUser = truncate(text, maxChars);
      pendingTurnStart = bStart ?? bEnd ?? null;
      pendingTurnEnd = bEnd ?? bStart ?? null;
      // Cursor attaches diffsSinceLastApply (the prior turn's applied edits) to
      // the *next* user bubble. We attribute those edits back to the just-closed
      // turn, since they describe what the assistant produced.
      const lastTurn = turns[turns.length - 1];
      if (lastTurn) {
        const existing = new Set(lastTurn.touchedFiles ?? []);
        for (const f of extractEditedFilesFromBubble(b, cwd)) existing.add(f);
        if (existing.size > 0) lastTurn.touchedFiles = [...existing];
      }
      continue;
    }

    if (type !== 2 || pendingUser === null) continue;

    if (bEnd) pendingTurnEnd = bEnd;

    for (const f of extractEditedFilesFromBubble(b, cwd)) pendingTouchedFiles.add(f);

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

  const session: AgentSession = {
    id: c.id,
    source: 'cursor',
    project: (c.name ?? 'cursor').slice(0, 60) || 'cursor',
    startedAt,
    turns: selectTurns(turns, maxTurns),
  };
  if (cwd) session.cwd = cwd;
  const endedAt = lastBubbleEnd ?? (c.lastUpdatedAt > 0 ? new Date(c.lastUpdatedAt) : null);
  if (endedAt) session.endedAt = endedAt;
  return session;
}

/**
 * Per-bubble timings live under `timingInfo` (epoch ms). `clientRpcSendTime` is
 * roughly when the user submitted; `clientEndTime` is when the response settled.
 */
function extractBubbleTimings(b: Record<string, unknown>): { startedAt: Date | null; endedAt: Date | null } {
  const ti = b['timingInfo'] as Record<string, unknown> | undefined;
  if (!ti) return { startedAt: null, endedAt: null };
  const send = numberOr(ti['clientRpcSendTime'], 0);
  const end = numberOr(ti['clientEndTime'], 0);
  return {
    startedAt: send > 0 ? new Date(send) : null,
    endedAt: end > 0 ? new Date(end) : null,
  };
}

/**
 * Edit-only file extraction from a Cursor bubble. Cursor records many file
 * references (relevantFiles, attachedCodeChunks, codeBlocks) — most are
 * exploration noise. The closest analogue to "the agent edited this file" is
 * `diffsSinceLastApply[].relativeWorkspacePath` (committed-to-disk diffs) and
 * `deletedFiles[].relativeWorkspacePath`.
 */
function extractEditedFilesFromBubble(b: Record<string, unknown>, cwd: string | undefined): string[] {
  const out: string[] = [];
  const diffs = b['diffsSinceLastApply'];
  if (Array.isArray(diffs)) {
    for (const d of diffs) {
      if (!d || typeof d !== 'object') continue;
      const rel = (d as Record<string, unknown>)['relativeWorkspacePath'];
      const abs = resolveCursorPath(rel, cwd);
      if (abs) out.push(abs);
    }
  }
  const deleted = b['deletedFiles'];
  if (Array.isArray(deleted)) {
    for (const d of deleted) {
      if (!d || typeof d !== 'object') continue;
      const rel = (d as Record<string, unknown>)['relativeWorkspacePath'];
      const abs = resolveCursorPath(rel, cwd);
      if (abs) out.push(abs);
    }
  }
  return out;
}

function resolveCursorPath(rel: unknown, cwd: string | undefined): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  if (path.isAbsolute(rel)) return rel;
  if (cwd) return path.resolve(cwd, rel);
  return rel;
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

function nodeSqliteSpecifier(): string {
  return 'node:sqlite';
}
