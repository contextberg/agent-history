export type AgentSource = 'claude-code' | 'cursor' | 'openclaw' | 'codex' | 'hermes' | 'copilot';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
}

export type AssistantItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCall };

export interface AgentTurn {
  userMessage: string;
  assistantSummary: string;
  items: AssistantItem[];
  startedAt?: string;
  endedAt?: string;
  touchedFiles?: string[];
}

export interface AgentSession {
  id: string;
  source: AgentSource;
  project: string;
  startedAt: string;
  turns: AgentTurn[];
  cwd?: string;
  endedAt?: string;
  gitBranch?: string;
  terminal?: { pid: number; kind?: string };
  ide?: { name: string; workspaceFolders: string[] };
  entrypoint?: string;
  resumedFrom?: string;
  referencedCommits?: string[];
  additionalCwds?: string[];
}

export interface LinkedSessionSnippet {
  id: string;
  project: string;
  source: AgentSource;
  startedAt: string;
  gitBranch?: string;
}

export interface CommitLink {
  session: LinkedSessionSnippet;
  score: number;
  parts: { repo: number; time: number; files: number; branch: number };
  reason: string;
}

export interface CommitWithLinks {
  repo: string;
  sha: string;
  /** ISO 8601. */
  time: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  files: string[];
  links: CommitLink[];
}
