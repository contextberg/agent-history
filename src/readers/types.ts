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
  /** OS-level identity of the agent process that ran the session. */
  terminal?: {
    pid: number;
    /** "interactive" for the usual TUI; differs for one-shot/print/sdk runs. */
    kind?: string;
  };
  /** When the session ran via an IDE bridge (Claude Code → VSCode/Cursor). */
  ide?: {
    name: string;
    workspaceFolders: string[];
  };
  /**
   * Source-specific entrypoint hint: e.g. "cli", "sdk", "ide" for claude-code,
   * "codex-tui" for codex. Use to filter out non-interactive automation runs.
   */
  entrypoint?: string;
  /**
   * Session ID that this session was resumed from. Sessions chained via
   * `--resume` form a logical-task lineage; the linkage layer treats them as
   * one unit when grouping under a commit.
   */
  resumedFrom?: string;
  /**
   * Commit SHAs the session explicitly referenced (e.g. via `git log`/`git diff`
   * output captured in tool results). Lets us link sessions whose source
   * doesn't record cwd — hermes especially — to the repo whose history they
   * touched.
   */
  referencedCommits?: string[];
  /**
   * Additional cwds observed during the session beyond the primary `cwd` —
   * notably from openclaw exec `details.cwd` when the agent shelled into a
   * different repo. The aggregator walks these the same way as `cwd` for repo
   * discovery; never includes the primary cwd itself.
   */
  additionalCwds?: string[];
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
