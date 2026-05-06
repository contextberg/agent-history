export type AgentSource = 'claude-code' | 'cursor' | 'openclaw' | 'codex' | 'hermes' | 'copilot';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
}

/** One unit in an assistant response: either a text block or a tool call. */
export type AssistantItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCall };

export interface AgentTurn {
  userMessage: string;
  /** Plain-text summary for MCP/copy output. */
  assistantSummary: string;
  /** Ordered sequence of text blocks and tool calls as they occurred. */
  items: AssistantItem[];
  /** Time of the user message that opened this turn, if known. */
  startedAt?: Date;
  /** Time of the last assistant/tool entry attributed to this turn, if known. */
  endedAt?: Date;
  /**
   * Absolute file paths touched by this turn's tool calls (Edit/Write/Read/MultiEdit/NotebookEdit).
   * Used by commit-linkage scoring; not displayed in the UI directly.
   */
  touchedFiles?: string[];
}

export interface AgentSession {
  id: string;
  source: AgentSource;
  project: string;
  startedAt: Date;
  turns: AgentTurn[];
  /** Absolute working directory the session ran in, when the source records it. */
  cwd?: string;
  /** Time of the last entry in the session, when known. */
  endedAt?: Date;
  /** Git branch active during the session, when the source records it. */
  gitBranch?: string;
}

export interface ReaderOptions {
  /** UTC date filter. Omit to read all history. */
  date?: Date;
  maxSessions?: number;
  maxTurnsPerSession?: number;
  maxCharsPerField?: number;
}

export interface IReader {
  readonly source: AgentSource;
  isInstalled(): Promise<boolean>;
  read(options?: ReaderOptions): Promise<AgentSession[]>;
}
