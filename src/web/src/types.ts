export type AgentSource = 'claude-code' | 'cursor' | 'openclaw';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type AssistantItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCall };

export interface AgentTurn {
  userMessage: string;
  assistantSummary: string;
  items: AssistantItem[];
}

export interface AgentSession {
  id: string;
  source: AgentSource;
  project: string;
  startedAt: string;
  turns: AgentTurn[];
}
