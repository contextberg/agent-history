import type { AgentSession } from '../types';

export function buildMarkdown(session: AgentSession): string {
  const lines: string[] = [
    `# ${session.project} — ${new Date(session.startedAt).toLocaleString()}`,
    `Source: ${session.source}`,
    '',
  ];
  for (const turn of session.turns) {
    lines.push(`## User\n${turn.userMessage}`);
    if (turn.assistantSummary) lines.push(`## Assistant\n${turn.assistantSummary}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildContext(session: AgentSession): string {
  const lines: string[] = [
    `The following is a past coding agent session (${session.source}, project: ${session.project}).`,
    `Please use it as context to continue the work.`,
    '',
  ];
  for (const turn of session.turns) {
    lines.push(`User: ${turn.userMessage}`);
    if (turn.assistantSummary) lines.push(`Assistant: ${turn.assistantSummary}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildRaw(session: AgentSession): string {
  return JSON.stringify(session, null, 2);
}
