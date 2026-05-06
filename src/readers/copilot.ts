import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions } from './types.js';
import { truncate, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

interface CopilotRequest {
  requestId?: string;
  timestamp?: number;
  message?: { text?: string };
  response?: unknown[];
  result?: { kind?: string };
}

interface CopilotState {
  sessionId?: string;
  creationDate?: number;
  customTitle?: string;
  requests?: CopilotRequest[];
}

export class CopilotReader implements IReader {
  readonly source = 'copilot' as const;

  async isInstalled(): Promise<boolean> {
    for (const root of vscodeUserDirs()) {
      if (await exists(path.join(root, 'workspaceStorage'))) return true;
      if (await exists(path.join(root, 'globalStorage', 'emptyWindowChatSessions'))) return true;
    }
    return false;
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const candidates: { fp: string; mtime: Date; project: string; format: 'jsonl' | 'json' }[] = [];

    for (const userDir of vscodeUserDirs()) {
      // Workspace sessions: workspaceStorage/<hash>/chatSessions/*.jsonl
      const wsRoot = path.join(userDir, 'workspaceStorage');
      const wsEntries = await fs.readdir(wsRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of wsEntries) {
        if (!entry.isDirectory()) continue;
        const wsDir = path.join(wsRoot, entry.name);
        const sessionsDir = path.join(wsDir, 'chatSessions');
        if (!(await exists(sessionsDir))) continue;
        const project = await readWorkspaceProject(wsDir);
        const files = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const fp = path.join(sessionsDir, f.name);
          const stat = await fs.stat(fp).catch(() => null);
          if (!stat) continue;
          candidates.push({ fp, mtime: stat.mtime, project, format: 'jsonl' });
        }
      }

      // Empty-window sessions: globalStorage/emptyWindowChatSessions/*.json
      const emptyDir = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
      const emptyFiles = await fs.readdir(emptyDir, { withFileTypes: true }).catch(() => []);
      for (const f of emptyFiles) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        const fp = path.join(emptyDir, f.name);
        const stat = await fs.stat(fp).catch(() => null);
        if (!stat) continue;
        candidates.push({ fp, mtime: stat.mtime, project: '(no workspace)', format: 'json' });
      }
    }

    const filtered = candidates
      .filter((x) => (options.date ? isWithinDate(x.mtime, options.date) : true))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const sessions: AgentSession[] = [];
    for (const c of filtered) {
      if (sessions.length >= maxSessions) break;
      const state = c.format === 'jsonl'
        ? await loadJsonlSession(c.fp)
        : await loadJsonSession(c.fp);
      if (!state) continue;
      const session = buildSession(state, c.project, c.mtime, maxTurns, maxChars);
      if (session) sessions.push(session);
    }

    return sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, maxSessions);
  }
}

function vscodeUserDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appdata, 'Code', 'User'));
    dirs.push(path.join(appdata, 'Code - Insiders', 'User'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
    dirs.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'));
  } else {
    dirs.push(path.join(home, '.config', 'Code', 'User'));
    dirs.push(path.join(home, '.config', 'Code - Insiders', 'User'));
  }
  return dirs;
}

async function readWorkspaceProject(wsDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(wsDir, 'workspace.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { folder?: string; configuration?: string };
    const uri = parsed.folder ?? parsed.configuration;
    if (typeof uri === 'string') {
      const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ''));
      const basename = path.basename(decoded.replace(/[/\\]+$/, ''));
      if (basename) return basename;
    }
  } catch { /* ignore */ }
  return path.basename(wsDir);
}

async function loadJsonlSession(filePath: string): Promise<CopilotState | null> {
  let raw: string;
  try { raw = await fs.readFile(filePath, 'utf-8'); } catch { return null; }
  const lines = raw.split('\n');
  let state: CopilotState = {};

  for (const line of lines) {
    if (!line.trim()) continue;
    let evt: { kind?: number; k?: unknown[]; v?: unknown };
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.kind === 0 && evt.v && typeof evt.v === 'object') {
      state = evt.v as CopilotState;
    } else if (Array.isArray(evt.k)) {
      setAtPath(state as Record<string, unknown>, evt.k, evt.v);
    }
  }
  return state;
}

async function loadJsonSession(filePath: string): Promise<CopilotState | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as CopilotState;
  } catch {
    return null;
  }
}

function setAtPath(root: Record<string, unknown>, keys: unknown[], value: unknown): void {
  if (keys.length === 0) return;
  let cur: unknown = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const nextKey = keys[i + 1];
    if (typeof k === 'string' && typeof cur === 'object' && cur !== null && !Array.isArray(cur)) {
      const obj = cur as Record<string, unknown>;
      if (obj[k] === undefined || obj[k] === null) {
        obj[k] = typeof nextKey === 'number' ? [] : {};
      }
      cur = obj[k];
    } else if (typeof k === 'number' && Array.isArray(cur)) {
      if (cur[k] === undefined) cur[k] = typeof nextKey === 'number' ? [] : {};
      cur = cur[k];
    } else {
      return;
    }
  }
  const last = keys[keys.length - 1];
  if (typeof last === 'string' && typeof cur === 'object' && cur !== null && !Array.isArray(cur)) {
    (cur as Record<string, unknown>)[last] = value;
  } else if (typeof last === 'number' && Array.isArray(cur)) {
    cur[last] = value;
  }
}

function buildSession(
  state: CopilotState,
  project: string,
  fileMtime: Date,
  maxTurns: number,
  maxChars: number,
): AgentSession | null {
  const requests = Array.isArray(state.requests) ? state.requests : [];
  const turns: AgentTurn[] = [];

  for (const req of requests) {
    const userText = typeof req.message?.text === 'string' ? req.message.text.trim() : '';
    if (!userText) continue;

    const items: AssistantItem[] = [];
    const tools = new Map<string, number>();
    const responseArr = Array.isArray(req.response) ? req.response : [];

    for (const part of responseArr) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      const kind = p['kind'];

      if (kind === undefined) {
        // Markdown text content. The shape is { value: string, supportThemeIcons, ... }.
        const v = p['value'];
        if (typeof v === 'string' && v.trim()) {
          items.push({ kind: 'text', text: truncate(v, maxChars) });
        }
      } else if (kind === 'markdownContent') {
        const v = (p['content'] as { value?: unknown })?.value ?? p['value'];
        if (typeof v === 'string' && v.trim()) {
          items.push({ kind: 'text', text: truncate(v, maxChars) });
        }
      } else if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
        const name = typeof p['toolId'] === 'string' ? p['toolId'] : '?';
        const desc = extractMarkdown(p['invocationMessage']) ?? extractMarkdown(p['pastTenseMessage']);
        const input: Record<string, unknown> = desc ? { description: desc } : {};
        tools.set(name, (tools.get(name) ?? 0) + 1);
        items.push({ kind: 'tool', tool: { name, input } });
      }
      // 'thinking' and other internal kinds are skipped.
    }

    if (items.length === 0) continue;

    const textCombined = items
      .filter((i): i is { kind: 'text'; text: string } => i.kind === 'text')
      .map((i) => i.text)
      .join(' ');
    let summary = '';
    if (textCombined) {
      if (tools.size > 0) {
        const suffix = ' [' + [...tools.entries()].map(([k, v]) => `${k}×${v}`).join(', ') + ']';
        summary = truncate(textCombined, Math.max(0, maxChars - suffix.length)) + suffix;
      } else {
        summary = truncate(textCombined, maxChars);
      }
    } else if (tools.size > 0) {
      summary = '→ ' + [...tools.entries()].map(([k, v]) => `${k}×${v}`).join(', ');
    }

    turns.push({
      userMessage: truncate(userText, maxChars),
      assistantSummary: summary,
      items,
    });
  }

  if (turns.length === 0) return null;

  const startedAt =
    typeof state.creationDate === 'number' ? new Date(state.creationDate) : fileMtime;

  return {
    id: state.sessionId ?? randomUUID(),
    source: 'copilot',
    project,
    startedAt,
    turns: selectTurns(turns, maxTurns),
  };
}

function extractMarkdown(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  if (typeof obj['value'] === 'string') return obj['value'];
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}
