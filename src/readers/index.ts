import type { AgentSession, AgentSource, IReader, ReaderOptions } from './types.js';
import { ClaudeCodeReader } from './claude-code.js';
import { CursorReader } from './cursor.js';
import { OpenClawReader } from './openclaw.js';
import { CodexReader } from './codex.js';
import { HermesReader } from './hermes.js';

export type { AgentSession, AgentTurn, AgentSource, IReader, ReaderOptions } from './types.js';

export class AgentHistoryService {
  private readonly readers: IReader[];

  constructor(readers?: IReader[]) {
    this.readers = readers ?? [
      new ClaudeCodeReader(),
      new CursorReader(),
      new OpenClawReader(),
      new CodexReader(),
      new HermesReader(),
    ];
  }

  async getSessions(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const results = await Promise.allSettled(
      this.readers.map((r) => r.read(options)),
    );

    const allSessions = results.flatMap((r) =>
      r.status === 'fulfilled' ? r.value : [],
    );

    return allSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async getSessionsBySource(source: AgentSource, options: ReaderOptions = {}): Promise<AgentSession[]> {
    const reader = this.readers.find((r) => r.source === source);
    if (!reader) return [];
    return reader.read(options);
  }

  async getStatus(): Promise<Record<AgentSource, boolean>> {
    const entries = await Promise.all(
      this.readers.map(async (r) => [r.source, await r.isInstalled()] as const),
    );
    return Object.fromEntries(entries) as Record<AgentSource, boolean>;
  }
}
