import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentHistoryService } from '../readers/index.js';
import type { AgentSource, ReaderOptions } from '../readers/index.js';

const service = new AgentHistoryService();

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'agent-history', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_agent_history',
        description:
          'Get coding agent conversation history from Claude Code, Cursor, and OpenClaw. Returns sessions with user messages and assistant summaries.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: ['claude-code', 'cursor', 'openclaw'],
              description: 'Filter by tool. Omit to get all.',
            },
            date: {
              type: 'string',
              description: 'ISO date string (e.g. "2026-05-05"). Omit for all history.',
            },
            maxSessions: {
              type: 'number',
              description: 'Max sessions to return (default 10, max 50)',
            },
            maxTurnsPerSession: {
              type: 'number',
              description: 'Max turns per session (default 5)',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'get_agent_history') {
      return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };
    }

    const input = (req.params.arguments ?? {}) as Record<string, unknown>;
    const options: ReaderOptions = {
      ...(input['date'] ? { date: new Date(input['date'] as string) } : {}),
      maxSessions: Math.min(Number(input['maxSessions'] ?? 10), 50),
      maxTurnsPerSession: Math.min(Number(input['maxTurnsPerSession'] ?? 5), 20),
      maxCharsPerField: 500,
    };

    try {
      const source = input['source'] as AgentSource | undefined;
      const sessions = source
        ? await service.getSessionsBySource(source, options)
        : await service.getSessions(options);

      if (sessions.length === 0) {
        return { content: [{ type: 'text', text: 'No agent history found.' }] };
      }

      const lines: string[] = [];
      for (const session of sessions) {
        lines.push(`### [${session.source}] ${session.project} — ${session.startedAt.toISOString()}`);
        for (const turn of session.turns) {
          lines.push(`Q: ${turn.userMessage}`);
          if (turn.assistantSummary) lines.push(`A: ${turn.assistantSummary}`);
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
