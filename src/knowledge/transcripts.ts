import path from 'node:path';
import type { AgentSession, AgentTurn, AssistantItem } from '../readers/types.js';

interface BuildTranscriptOptions {
  /** Hard cap on user message size per turn. */
  maxUserChars: number;
  /** Hard cap on assistant text size per turn. */
  maxAssistantChars: number;
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
  maxSessionChars: 6000,
  maxTurnsPerSession: 12,
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function renderTurn(turn: AgentTurn, opts: BuildTranscriptOptions): string {
  const parts: string[] = [];

  const user = clip(turn.userMessage.trim(), opts.maxUserChars);
  if (user) parts.push(`USER: ${user}`);

  // Tool execution traces are intentionally OMITTED from the prompt — what
  // the assistant *said* (intent, decisions, gotchas it called out) is
  // signal; tool call I/O is mostly noise that crowds the context. The same
  // policy applies in src/mcp/server.ts via includeToolCalls=false defaults.
  // We still surface the list of edited files below since that's a one-line
  // summary, not an execution trace.
  let assistantBudget = opts.maxAssistantChars;
  for (const item of turn.items) {
    if (assistantBudget <= 0) break;
    if (isText(item)) {
      const t = item.text.trim();
      if (!t) continue;
      const slice = clip(t, Math.min(assistantBudget, opts.maxAssistantChars));
      parts.push(`ASSISTANT: ${slice}`);
      assistantBudget -= slice.length;
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
