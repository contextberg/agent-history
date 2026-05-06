import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentTurn, AssistantItem, IReader, ReaderOptions, ToolCall } from './types.js';
import { truncate, extractProjectName, isWithinDate, selectTurns } from './utils.js';

const DEFAULTS = { maxSessions: 50, maxTurns: 20, maxChars: 2000 };

export class ClaudeCodeReader implements IReader {
  readonly source = 'claude-code' as const;

  async isInstalled(): Promise<boolean> {
    return exists(path.join(os.homedir(), '.claude', 'projects'));
  }

  async read(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    const maxTurns = options.maxTurnsPerSession ?? DEFAULTS.maxTurns;
    const maxChars = options.maxCharsPerField ?? DEFAULTS.maxChars;

    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    if (!await exists(claudeDir)) return [];

    const sessions: AgentSession[] = [];

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
          const session = await parseSession(fp, projectName, options.date, maxTurns, maxChars);
          if (session) sessions.push(session);
          if (sessions.length >= maxSessions) break;
        }

        if (sessions.length >= maxSessions) break;
      }
    } catch {
      // ディレクトリが読めない環境では空を返す
    }

    return sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, maxSessions);
  }
}

async function parseSession(
  filePath: string,
  projectName: string,
  targetDate: Date | undefined,
  maxTurns: number,
  maxChars: number,
): Promise<AgentSession | null> {
  const turns: AgentTurn[] = [];
  let startedAt: Date | null = null;
  let endedAt: Date | null = null;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let pendingUserMessage: string | null = null;
  let pendingTurnStart: Date | null = null;
  let pendingTurnEnd: Date | null = null;
  let pendingTouchedFiles: Set<string> = new Set();
  // Ordered sequence of items within the current turn (text blocks and tool calls).
  const pendingItems: AssistantItem[] = [];
  const pendingTools = new Map<string, number>();
  const pendingUseIndex = new Map<string, number>(); // tool_use_id -> pendingItems index

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
    id: randomUUID(),
    source: 'claude-code',
    project: projectName,
    startedAt: startedAt ?? new Date(),
    turns: selectTurns(turns, maxTurns),
  };
  if (cwd) session.cwd = cwd;
  if (gitBranch) session.gitBranch = gitBranch;
  if (endedAt) session.endedAt = endedAt;
  return session;
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
  const combinedText = textParts.map((i) => i.text).join(' ');
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
