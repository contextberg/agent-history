import path from 'node:path';
import type { AgentSession, AgentTurn, AssistantItem, ToolCall } from '../readers/types.js';

interface BuildTranscriptOptions {
  /** Hard cap on user message size per turn. */
  maxUserChars: number;
  /** Hard cap on assistant text size per turn. */
  maxAssistantChars: number;
  /** Hard cap on captured tool I/O per turn (across all tools in that turn). */
  maxToolIOChars: number;
  /** Hard cap on total chars per session block. */
  maxSessionChars: number;
  /** Render at most this many turns per session. */
  maxTurnsPerSession: number;
  /** When set, turns whose touchedFiles overlap this set get the highest score. */
  commitFiles?: Set<string>;
}

const DEFAULTS: BuildTranscriptOptions = {
  maxUserChars: 600,
  maxAssistantChars: 1500,
  maxToolIOChars: 600,
  maxSessionChars: 6000,
  maxTurnsPerSession: 12,
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/**
 * Tools whose output materially helps the LLM understand the session
 * (errors, test failures, file contents the assistant read). Other tools'
 * outputs are usually voluminous noise.
 */
const TOOL_OUTPUT_WORTH_KEEPING = new Set([
  'Bash', 'bash', 'shell', 'exec',
  'Read', 'read', 'read_file', 'view',
  'Grep', 'grep', 'search',
]);

function renderToolCall(call: ToolCall, budgetLeft: number): { text: string; consumed: number } {
  const keyArg = pickKeyArg(call);
  const detail = pickContentExcerpt(call);
  const head = `TOOL ${call.name}${keyArg ? ' ' + keyArg : ''}${detail ? `\n  ⋮ ${detail}` : ''}`;

  if (!call.output || !TOOL_OUTPUT_WORTH_KEEPING.has(call.name) || budgetLeft <= 0) {
    return { text: head, consumed: head.length };
  }

  // For Bash/exec output, prefer lines that look like errors/diagnostics.
  const trimmed = highlightErrors(call.output, Math.min(budgetLeft, 400));
  if (!trimmed) return { text: head, consumed: head.length };
  const text = `${head}\n  → ${trimmed}`;
  return { text, consumed: text.length };
}

function pickKeyArg(call: ToolCall): string {
  const input = call.input;
  const candidates = ['file_path', 'path', 'filePath', 'command', 'cmd', 'pattern', 'query', 'url'];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v === 'string' && v) {
      if (k === 'command' || k === 'cmd') return clip(stripBoilerplate(v), 250);
      return path.basename(v);
    }
  }
  return '';
}

/**
 * For Edit / Write / MultiEdit tools, surface the actual content being written
 * (truncated). Without this we know "Edit src/foo.ts" but not what changed —
 * which is exactly the question the LLM is trying to answer.
 */
function pickContentExcerpt(call: ToolCall): string {
  const input = call.input;
  const candidates = ['new_string', 'content', 'text', 'patch'];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) {
      const oneLine = v.replace(/\s+/g, ' ').trim();
      return clip(oneLine, 200);
    }
  }
  return '';
}

function stripBoilerplate(cmd: string): string {
  // `cd /repo/path && actual-command` — keep just the actual-command part.
  const m = cmd.match(/^cd\s+\S+\s*&&\s*(.+)$/s);
  return m && m[1] ? m[1] : cmd;
}

const ERROR_LINE_RE = /^(error|err|fail|fatal|panic|✗|×|TypeError|ReferenceError|SyntaxError|❌|.*\bError\b)/i;

function highlightErrors(output: string, budget: number): string {
  const lines = output.split('\n').filter((l) => l.trim());
  const errorLines = lines.filter((l) => ERROR_LINE_RE.test(l));
  const picked = errorLines.length > 0 ? errorLines.slice(0, 6) : lines.slice(0, 6);
  const joined = picked.join(' / ');
  return clip(joined, budget);
}

function renderTurn(turn: AgentTurn, opts: BuildTranscriptOptions): string {
  const parts: string[] = [];

  const user = clip(turn.userMessage.trim(), opts.maxUserChars);
  if (user) parts.push(`USER: ${user}`);

  // Render items in order, with text and tool calls interleaved as they occurred.
  let assistantBudget = opts.maxAssistantChars;
  let toolBudget = opts.maxToolIOChars;
  for (const item of turn.items) {
    if (assistantBudget <= 0 && toolBudget <= 0) break;
    if (isText(item)) {
      const t = item.text.trim();
      if (!t) continue;
      const slice = clip(t, Math.min(assistantBudget, opts.maxAssistantChars));
      parts.push(`ASSISTANT: ${slice}`);
      assistantBudget -= slice.length;
    } else if (isTool(item)) {
      const { text, consumed } = renderToolCall(item.tool, toolBudget);
      parts.push(text);
      toolBudget -= consumed;
    }
  }

  if (turn.touchedFiles && turn.touchedFiles.length > 0) {
    const files = turn.touchedFiles.slice(0, 8).map((f) => path.basename(f)).join(', ');
    parts.push(`EDITED: ${files}`);
  }

  return parts.join('\n');
}

function isText(item: AssistantItem): item is { kind: 'text'; text: string } {
  return item.kind === 'text';
}

function isTool(item: AssistantItem): item is { kind: 'tool'; tool: ToolCall } {
  return item.kind === 'tool';
}

/**
 * Score a turn for inclusion. Higher = more relevant to this commit.
 *   - Touches a file in commit.files → 1.0
 *   - Touches some file (any) → 0.5
 *   - Otherwise → 0.1 (still kept if budget allows; provides discussion context)
 */
function scoreTurn(turn: AgentTurn, commitFiles: Set<string> | undefined): number {
  if (!turn.touchedFiles || turn.touchedFiles.length === 0) return 0.1;
  if (commitFiles && commitFiles.size > 0) {
    for (const f of turn.touchedFiles) {
      if (commitFiles.has(f) || commitFiles.has(path.basename(f))) return 1.0;
    }
  }
  return 0.5;
}

/**
 * Render a session as compact text. Turn selection:
 *   1. Always include turn[0] (the first user message) — it captures session intent.
 *   2. Score remaining turns by relevance to commit.files.
 *   3. Pick top (maxTurnsPerSession - 1) by score.
 *   4. Re-emit picked turns in *chronological* order so the LLM sees the flow.
 */
export function renderSession(
  session: AgentSession,
  opts: Partial<BuildTranscriptOptions> = {},
): string {
  const o = { ...DEFAULTS, ...opts };

  const intentTurn = session.turns[0];
  const intent = intentTurn ? clip(intentTurn.userMessage.trim(), 400) : '';

  const indexed = session.turns
    .map((turn, i) => ({ turn, i, score: scoreTurn(turn, o.commitFiles) }))
    .filter((x) => x.i !== 0); // index 0 always included as the intent header

  const remainingBudget = Math.max(0, o.maxTurnsPerSession - 1);
  const picked = [...indexed].sort((a, b) => b.score - a.score).slice(0, remainingBudget);
  picked.sort((a, b) => a.i - b.i);

  const headerLines = [
    `=== Session ${session.id.slice(0, 8)} (${session.source}) ===`,
    `Project: ${session.project}`,
    session.gitBranch ? `Branch: ${session.gitBranch}` : null,
    session.entrypoint ? `Entrypoint: ${session.entrypoint}` : null,
    session.ide?.name ? `IDE: ${session.ide.name}` : null,
    `Started: ${session.startedAt.toISOString()}`,
    `Turns: ${session.turns.length} (rendering intent + ${picked.length} most relevant)`,
    intent ? `\nINTENT (first user message):\n  ${intent}` : null,
  ].filter(Boolean) as string[];

  const lines: string[] = [headerLines.join('\n'), ''];
  let used = lines.join('\n').length;

  for (const { turn } of picked) {
    const block = renderTurn(turn, o);
    if (!block) continue;
    if (used + block.length + 2 > o.maxSessionChars) {
      lines.push('[…remaining turns truncated]');
      break;
    }
    lines.push(block);
    lines.push('');
    used += block.length + 2;
  }

  return lines.join('\n').trimEnd();
}

interface BuildPromptInput {
  sha: string;
  subject: string;
  repo: string;
  /** Full commit message body (after the subject line). Often contains the WHY. */
  body?: string;
  authorName?: string;
  /** ISO timestamp. */
  authoredAt?: string;
  branch?: string;
  /** "X files changed, Y insertions(+), Z deletions(-)" line from `git show --stat`. */
  stats?: string;
  diffSummary: string;
  /** Files changed by the commit (absolute paths). Drives turn relevance scoring. */
  commitFiles: string[];
  sessions: Array<{ session: AgentSession; score: number; reason: string }>;
  /** Whole-prompt char cap (sessions split this evenly). */
  maxTotalChars?: number;
}

/** Build the user message that will be sent to the LLM. */
export function buildPrompt(input: BuildPromptInput): string {
  const totalCap = input.maxTotalChars ?? 18000;
  const headerSize = 800;
  const perSession = Math.max(2000, Math.floor((totalCap - headerSize) / Math.max(1, input.sessions.length)));

  const commitFileSet = new Set<string>();
  for (const f of input.commitFiles) {
    commitFileSet.add(f);
    commitFileSet.add(path.basename(f));
  }

  const headerLines: Array<string | null> = [
    `## Commit`,
    `SHA: ${input.sha}`,
    `Subject: ${input.subject}`,
    input.authorName ? `Author: ${input.authorName}` : null,
    input.authoredAt ? `Time: ${input.authoredAt}` : null,
    input.branch ? `Branch: ${input.branch}` : null,
    `Repo: ${input.repo}`,
    input.stats ? `Stats: ${input.stats}` : null,
    `Files changed: ${input.commitFiles.map((f) => path.basename(f)).slice(0, 20).join(', ')}`,
  ];

  const body = input.body ? clip(input.body.trim(), 1200) : '';
  if (body) {
    headerLines.push('', '### Commit message body', body);
  }

  const lines: string[] = [
    ...(headerLines.filter(Boolean) as string[]),
    ``,
    `## Diff (truncated)`,
    clip(input.diffSummary.trim(), 4000),
    ``,
    `## Linked agent sessions`,
    `(${input.sessions.length} session(s) above link threshold, sorted by score)`,
    ``,
  ];

  for (const { session, score, reason } of input.sessions) {
    lines.push(`### Score ${score.toFixed(2)} — ${reason}`);
    lines.push(renderSession(session, { maxSessionChars: perSession, commitFiles: commitFileSet }));
    lines.push('');
  }

  return clip(lines.join('\n'), totalCap);
}
