import type { AgentSession, AgentTurn } from '../readers/types.js';

interface BuildTranscriptOptions {
  /** Hard cap on user message size per turn. */
  maxUserChars: number;
  /** Hard cap on assistant summary size per turn. */
  maxAssistantChars: number;
  /** Hard cap on total chars per session block. */
  maxSessionChars: number;
  /** Include tool call names in the rendered transcript. */
  includeToolCalls: boolean;
}

const DEFAULTS: BuildTranscriptOptions = {
  maxUserChars: 600,
  maxAssistantChars: 1200,
  maxSessionChars: 6000,
  includeToolCalls: true,
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function renderTurn(turn: AgentTurn, opts: BuildTranscriptOptions): string {
  const parts: string[] = [];

  const user = clip(turn.userMessage.trim(), opts.maxUserChars);
  if (user) parts.push(`USER: ${user}`);

  const assistant = clip(turn.assistantSummary.trim(), opts.maxAssistantChars);
  if (assistant) parts.push(`ASSISTANT: ${assistant}`);

  if (opts.includeToolCalls) {
    const tools = turn.items
      .filter((it): it is { kind: 'tool'; tool: { name: string } } & typeof it => it.kind === 'tool')
      .map((it) => it.tool.name);
    if (tools.length > 0) parts.push(`TOOLS: ${tools.join(', ')}`);
  }

  if (turn.touchedFiles && turn.touchedFiles.length > 0) {
    const files = turn.touchedFiles.slice(0, 8).join(', ');
    parts.push(`EDITED: ${files}`);
  }

  return parts.join('\n');
}

/**
 * Render a session's turns as compact plain text for the LLM. Prioritizes
 * turns that touched files (those are most likely to have produced the
 * commit), then fills remaining budget with the rest.
 */
export function renderSession(session: AgentSession, opts: Partial<BuildTranscriptOptions> = {}): string {
  const o = { ...DEFAULTS, ...opts };

  const editTurns = session.turns.filter((t) => t.touchedFiles && t.touchedFiles.length > 0);
  const otherTurns = session.turns.filter((t) => !t.touchedFiles || t.touchedFiles.length === 0);
  const ordered = [...editTurns, ...otherTurns];

  const header = [
    `=== Session ${session.id.slice(0, 8)} (${session.source}) ===`,
    `Project: ${session.project}`,
    session.gitBranch ? `Branch: ${session.gitBranch}` : null,
    `Started: ${session.startedAt.toISOString()}`,
    `Turns: ${session.turns.length}`,
  ].filter(Boolean).join('\n');

  const lines: string[] = [header, ''];
  let used = lines.join('\n').length;

  for (const turn of ordered) {
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
  diffSummary: string;
  sessions: Array<{ session: AgentSession; score: number; reason: string }>;
  /** Whole-prompt char cap (sessions split this evenly). */
  maxTotalChars?: number;
}

/** Build the user message that will be sent to the LLM. */
export function buildPrompt(input: BuildPromptInput): string {
  const totalCap = input.maxTotalChars ?? 18000;
  const headerSize = 800;
  const perSession = Math.max(2000, Math.floor((totalCap - headerSize) / Math.max(1, input.sessions.length)));

  const lines: string[] = [
    `## Commit`,
    `SHA: ${input.sha}`,
    `Subject: ${input.subject}`,
    `Repo: ${input.repo}`,
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
    lines.push(renderSession(session, { maxSessionChars: perSession }));
    lines.push('');
  }

  return clip(lines.join('\n'), totalCap);
}
