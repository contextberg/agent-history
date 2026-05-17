import type { AgentSession, AgentSource, IReader, ReaderOptions } from './types.js';
import { ClaudeCodeReader } from './claude-code.js';
import { CursorReader } from './cursor.js';
import { OpenClawReader } from './openclaw.js';
import { CodexReader } from './codex.js';
import { HermesReader } from './hermes.js';
import { CopilotReader } from './copilot.js';

export type { AgentSession, AgentTurn, AgentSource, IReader, ReaderOptions } from './types.js';

export class AgentHistoryService {
  private readonly readers: IReader[];
  private readonly cache = new Map<string, { at: number; sessions: AgentSession[] }>();
  private readonly inFlight = new Map<string, Promise<AgentSession[]>>();
  private readonly cacheTtlMs = 10_000;

  constructor(readers?: IReader[]) {
    this.readers = readers ?? [
      new ClaudeCodeReader(),
      new CursorReader(),
      new OpenClawReader(),
      new CodexReader(),
      new HermesReader(),
      new CopilotReader(),
    ];
  }

  async getSessions(options: ReaderOptions = {}): Promise<AgentSession[]> {
    const key = optionsKey(options);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) return cached.sessions;
    const running = this.inFlight.get(key);
    if (running) return running;

    const task = (async () => {
      const results = await Promise.allSettled(
        this.readers.map((r) => r.read(options)),
      );

      const allSessions = results.flatMap((r) =>
        r.status === 'fulfilled' ? r.value : [],
      );

      const sorted = allSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      const sessions = options.maxSessions ? sorted.slice(0, options.maxSessions) : sorted;
      this.cache.set(key, { at: Date.now(), sessions });
      return sessions;
    })();
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async getSessionsBySource(source: AgentSource, options: ReaderOptions = {}): Promise<AgentSession[]> {
    const reader = this.readers.find((r) => r.source === source);
    if (!reader) return [];
    const sessions = await reader.read(options);
    return options.maxSessions ? sessions.slice(0, options.maxSessions) : sessions;
  }

  async getStatus(): Promise<Record<AgentSource, boolean>> {
    const entries = await Promise.all(
      this.readers.map(async (r) => [r.source, await r.isInstalled()] as const),
    );
    return Object.fromEntries(entries) as Record<AgentSource, boolean>;
  }
}

function optionsKey(options: ReaderOptions): string {
  return JSON.stringify({
    date: options.date?.toISOString() ?? null,
    maxSessions: options.maxSessions ?? null,
    maxTurnsPerSession: options.maxTurnsPerSession ?? null,
    maxCharsPerField: options.maxCharsPerField ?? null,
  });
}
