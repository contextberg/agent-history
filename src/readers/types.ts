export type AgentSource = 'claude-code' | 'cursor' | 'openclaw';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
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
}

export interface AgentSession {
  id: string;
  source: AgentSource;
  project: string;
  startedAt: Date;
  turns: AgentTurn[];
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
  read(options?: ReaderOptions): Promise<AgentSession[]>;
}
