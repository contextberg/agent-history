import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions, ToolCall } from './types.js';
import { truncate, extractProjectName, isWithinDate, selectTurns } from './utils.js';
import { wslHomePaths } from './wsl.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

interface ParsedSession {
  session: AgentSession;
  /** All uuids appearing in this JSONL — used to resolve `resumedFrom`. */
  allUuids: string[];
  /** parentUuid of the very first `user` text message, if any. */
  firstParentUuid: string | null;
}

interface TerminalInfo { pid: number; kind?: string }
interface IdeInfo { name: string; workspaceFolders: string[] }

export class ClaudeCodeReader implements IReader {
  readonly source = 'claude-code' as const;

  async isInstalled(): Promise<boolean> {
    return (await claudeSubdirs('projects')).length > 0;
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const projectRoots = await claudeSubdirs('projects');
    if (projectRoots.length === 0) return [];

    const parsed: ParsedSession[] = [];

    for (const claudeDir of projectRoots) {
      try {
        const projectDirs = await fs.readdir(claudeDir);

        for (const dirName of projectDirs) {
          const projectDir = path.join(claudeDir, dirName);
          const stat = await fs.stat(projectDir).catch(() => null);
          if (!stat?.isDirectory()) continue;

          const projectName = extractProjectName(dirName);
          const files = await fs.readdir(projectDir);
          const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

          const withMtime = await Promise.all(
            jsonlFiles.map(async (f) => {
              const fp = path.join(projectDir, f);
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
            const result = await parseSession(fp, projectName, options.date, maxTurns, maxChars);
            if (result) parsed.push(result);
            if (parsed.length >= maxSessions) break;
          }

          if (parsed.length >= maxSessions) break;
        }
      } catch {
        // ディレクトリが読めない環境ではスキップして次のルートへ
      }

      if (parsed.length >= maxSessions) break;
    }

    // Side-channel metadata: PID registry + IDE bridge locks. Both are runtime
    // state that only exists while a terminal/IDE is connected, so we attach
    // when present and silently skip otherwise.
    const [pidMap, ideMap] = await Promise.all([loadPidRegistry(), loadIdeLocks()]);

    // Resume resolution: build uuid → sessionId across everything we parsed,
    // then look up each session's first parentUuid.
    const uuidIndex = new Map<string, string>();
    for (const p of parsed) for (const u of p.allUuids) uuidIndex.set(u, p.session.id);

    const sessions: AgentSession[] = [];
    for (const p of parsed) {
      const s = p.session;
      const term = pidMap.get(s.id);
      if (term) s.terminal = term;
      if (s.cwd) {
        const ide = ideMap.get(normalizePath(s.cwd));
        if (ide) s.ide = ide;
      }
      if (p.firstParentUuid) {
        const parent = uuidIndex.get(p.firstParentUuid);
        if (parent && parent !== s.id) s.resumedFrom = parent;
      }
      sessions.push(s);
    }

    return sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, maxSessions);
  }
}

/**
 * Load Claude Code's PID registry at ~/.claude/sessions/<pid>.json. Each file
 * holds the *current* sessionId for that terminal process, so old sessions
 * won't have a terminal entry — that's fine, attach when present.
 */
async function loadPidRegistry(): Promise<Map<string, TerminalInfo>> {
  const out = new Map<string, TerminalInfo>();
  for (const dir of await claudeSubdirs('sessions')) {
    const files = await fs.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        const j = JSON.parse(raw) as { pid?: number; sessionId?: string; kind?: string };
        if (typeof j.sessionId !== 'string' || typeof j.pid !== 'number') continue;
        const entry: TerminalInfo = { pid: j.pid };
        if (typeof j.kind === 'string') entry.kind = j.kind;
        out.set(j.sessionId, entry);
      } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * Load IDE bridge lock files at ~/.claude/ide/<port>.lock. These are written
 * while a Claude Code instance is connected to a VSCode/Cursor IDE; we key the
 * map by normalized workspace folder so a session's cwd can find its IDE.
 */
async function loadIdeLocks(): Promise<Map<string, IdeInfo>> {
  const out = new Map<string, IdeInfo>();
  for (const dir of await claudeSubdirs('ide')) {
    const files = await fs.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.lock')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        const j = JSON.parse(raw) as { ideName?: string; workspaceFolders?: unknown };
        const folders = Array.isArray(j.workspaceFolders)
          ? j.workspaceFolders.filter((x): x is string => typeof x === 'string')
          : [];
        if (typeof j.ideName !== 'string' || folders.length === 0) continue;
        const info: IdeInfo = { name: j.ideName, workspaceFolders: folders };
        for (const folder of folders) out.set(normalizePath(folder), info);
      } catch { /* skip */ }
    }
  }
  return out;
}

/**
 * Resolve `~/.claude/<sub>` across native home and (on Windows) every WSL
 * distro user home. Used so a Windows host can also pick up Claude Code data
 * generated by sessions running inside WSL.
 */
async function claudeSubdirs(sub: string): Promise<string[]> {
  const out: string[] = [];
  const native = path.join(os.homedir(), '.claude', sub);
  if (await exists(native)) out.push(native);
  for (const d of await wslHomePaths(path.join('.claude', sub))) out.push(d);
  return [...new Set(out)];
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

async function parseSession(
  filePath: string,
  projectName: string,
  targetDate: Date | undefined,
  maxTurns: number,
  maxChars: number,
): Promise<ParsedSession | null> {
  const turns: AgentTurn[] = [];
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let entrypoint: string | undefined;
  let firstParentUuid: string | null = null;
  let sawFirstUser = false;
  const allUuids: string[] = [];
  let pendingUserMessage: string | null = null;
  let pendingTurnStart: Date | null = null;
  let pendingTurnEnd: Date | null = null;
  let pendingTouchedFiles: Set<string> = new Set();
  // Ordered sequence of items within the current turn (text blocks and tool calls).
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const pendingUseIndex = new Map<string, number>(); // tool_use_id -> pendingItems index

  // The JSONL filename is the canonical sessionId Claude Code itself uses;
  // we adopt it as the session id so resume references resolve cleanly.
  const sessionId = path.basename(filePath, '.jsonl');

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      let root: Record<string, unknown>;
      try { root = JSON.parse(line); } catch { continue; }

      // ルートに type があればそれを使う。アシスタントは message.role で判定（新形式）
      const rootType = root['type'] as string | undefined;
      const msg = root['message'] as Record<string, unknown> | undefined;
      const msgRole = msg?.['role'] as string | undefined;
      const type = rootType ?? msgRole;
      const timestamp = parseTimestamp(root['timestamp'] ?? msg?.['created_at']);

      if (targetDate && timestamp && !isWithinDate(timestamp, targetDate)) continue;

      if (!cwd && typeof root['cwd'] === 'string') cwd = root['cwd'] as string;
      if (!gitBranch && typeof root['gitBranch'] === 'string') gitBranch = root['gitBranch'] as string;
      if (!entrypoint && typeof root['entrypoint'] === 'string') entrypoint = root['entrypoint'] as string;
      if (typeof root['uuid'] === 'string') allUuids.push(root['uuid'] as string);
      if (timestamp) endedAt = endedAt && endedAt.getTime() > timestamp.getTime() ? endedAt : timestamp;

      if (type === 'user') {
        const contentVal = msg?.['content'];

        // 配列形式の user は tool_result を含む。
        // pendingUserMessage がある（=ツール実行後の結果メッセージ）なら結果を吸収。
        // pendingUserMessage が無い場合は、テキスト混在パターンに対応してスキップ。
        if (Array.isArray(contentVal)) {
          if (pendingUserMessage !== null) {
            absorbToolResults(contentVal, pendingItems, pendingUseIndex, maxChars);
            if (timestamp) pendingTurnEnd = timestamp;
          }
          continue;
        }
        if (typeof contentVal !== 'string') continue;

        if (!sawFirstUser) {
          sawFirstUser = true;
          const pu = root['parentUuid'];
          if (typeof pu === 'string') firstParentUuid = pu;
        }

        flushTurn(turns, pendingUserMessage, pendingItems, pendingTools, maxChars, pendingTurnStart, pendingTurnEnd, pendingTouchedFiles);
        pendingUserMessage = truncate(contentVal, maxChars);
        pendingItems.length = 0;
        pendingTools.clear();
        pendingUseIndex.clear();
        pendingTurnStart = timestamp;
        pendingTurnEnd = timestamp;
        pendingTouchedFiles = new Set();
        if (!startedAt) startedAt = timestamp ?? new Date();
      } else if ((type === 'assistant' || msgRole === 'assistant') && pendingUserMessage !== null) {
        const contentVal = msg?.['content'];
        if (!Array.isArray(contentVal)) continue;

        const { items, toolUses, idIndex, files } = extractAssistantParts(contentVal, pendingItems.length, cwd);
        pendingItems.push(...items);
        for (const [name, count] of toolUses) {
          pendingTools.set(name, (pendingTools.get(name) ?? 0) + count);
        }
        for (const [id, idx] of idIndex) pendingUseIndex.set(id, idx);
        for (const f of files) pendingTouchedFiles.add(f);
        if (timestamp) pendingTurnEnd = timestamp;
      }
    }

    flushTurn(turns, pendingUserMessage, pendingItems, pendingTools, maxChars, pendingTurnStart, pendingTurnEnd, pendingTouchedFiles);
  } catch {
    return null;
  }

  if (turns.length === 0) return null;

  const session: AgentSession = {
    id: sessionId,
    source: 'claude-code',
    project: projectName,
    startedAt: startedAt ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
  if (cwd) session.cwd = cwd;
  if (gitBranch) session.gitBranch = gitBranch;
  if (endedAt) session.endedAt = endedAt;
  if (entrypoint) session.entrypoint = entrypoint;
  return { session, allUuids, firstParentUuid };
}

function flushTurn(
  turns: AgentTurn[],
  userMessage: string | null,
  items: AssistantItem[],
  toolUses: Map<string, number>,
  maxChars: number,
  startedAt: Date | null,
  endedAt: Date | null,
  touchedFiles: Set<string>,
): void {
  if (!userMessage || items.length === 0) return;

  // Build plain-text summary for MCP/copy output.
  const textParts = items.filter((i): i is { kind: 'text'; text: string } => i.kind === 'text');
  const combinedText = textParts.map((i) => i.text).join('\n\n');
  let summary = '';
  if (combinedText) {
    if (toolUses.size > 0) {
      const suffix = ' [' + [...toolUses.entries()].map(([k, v]) => `${k}×${v}`).join(', ') + ']';
      summary = truncate(combinedText, Math.max(0, maxChars - suffix.length)) + suffix;
    } else {
      summary = truncate(combinedText, maxChars);
    }
  } else if (toolUses.size > 0) {
    summary = '→ ' + [...toolUses.entries()].map(([k, v]) => `${k}×${v}`).join(', ');
  }

  const turn: AgentTurn = { userMessage, assistantSummary: summary, items: [...items] };
  if (startedAt) turn.startedAt = startedAt;
  if (endedAt) turn.endedAt = endedAt;
  if (touchedFiles.size > 0) turn.touchedFiles = [...touchedFiles];
  turns.push(turn);
}

function extractAssistantParts(
  contentArray: unknown[],
  baseOffset: number,
  cwd: string | undefined,
): { items: AssistantItem[]; toolUses: Map<string, number>; idIndex: Map<string, number>; files: string[] } {
  const items: AssistantItem[] = [];
  const toolUses = new Map<string, number>();
  const idIndex = new Map<string, number>();
  const files: string[] = [];

  for (const item of contentArray) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it['type'] === 'text' && typeof it['text'] === 'string' && it['text'].trim()) {
      items.push({ kind: 'text', text: it['text'] });
    } else if (it['type'] === 'tool_use') {
      const name = typeof it['name'] === 'string' ? it['name'] : '?';
      const input = (it['input'] as Record<string, unknown>) ?? {};
      toolUses.set(name, (toolUses.get(name) ?? 0) + 1);
      const id = typeof it['id'] === 'string' ? it['id'] : undefined;
      const idx = baseOffset + items.length;
      items.push({ kind: 'tool', tool: { name, input } });
      if (id) idIndex.set(id, idx);
      const f = extractFilePathFromTool(name, input, cwd);
      if (f) files.push(f);
    }
  }

  return { items, toolUses, idIndex, files };
}

/**
 * Extract a file path from a tool_use input where the tool is known to operate
 * on a single file (Edit/Write/Read/MultiEdit/NotebookEdit). Returns an absolute
 * path when possible (resolving relative paths against the session cwd).
 */
function extractFilePathFromTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): string | null {
  // Only edit-class tools — reads are exploration noise that drowns out the
  // edit-vs-commit overlap signal used for linkage.
  const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  if (!fileTools.has(name)) return null;
  const raw = input['file_path'] ?? input['notebook_path'] ?? input['path'];
  if (typeof raw !== 'string' || !raw) return null;
  if (path.isAbsolute(raw)) return raw;
  if (cwd) return path.resolve(cwd, raw);
  return raw;
}

function absorbToolResults(
  contentArray: unknown[],
  pendingItems: AssistantItem[],
  useIndex: Map<string, number>,
  maxChars: number,
): void {
  for (const item of contentArray) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it['type'] !== 'tool_result') continue;
    const id = typeof it['tool_use_id'] === 'string' ? it['tool_use_id'] : undefined;
    if (!id) continue;
    const idx = useIndex.get(id);
    if (idx === undefined) continue;
    const target = pendingItems[idx];
    if (!target || target.kind !== 'tool') continue;
    target.tool.output = truncate(stringifyToolResult(it['content']), maxChars);
  }
}

function stringifyToolResult(content: unknown): string {
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
