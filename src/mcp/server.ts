import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentHistoryService } from '../readers/index.js';
import type { AgentSource } from '../readers/index.js';
import { loadConfig, CONFIG_DEFAULTS } from '../config.js';

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
          'Get coding agent conversation history from Claude Code, Cursor, and OpenClaw. ' +
          'Returns sessions with user messages and assistant summaries. ' +
          `Defaults: maxSessions=${CONFIG_DEFAULTS.mcp.maxSessions}, ` +
          `maxTurnsPerSession=${CONFIG_DEFAULTS.mcp.maxTurnsPerSession}, ` +
          `maxCharsPerField=${CONFIG_DEFAULTS.mcp.maxCharsPerField}.`,
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: ['claude-code', 'cursor', 'openclaw'],
              description: 'Filter by tool. Omit to get all sources.',
            },
            date: {
              type: 'string',
              description: 'ISO date string (e.g. "2026-05-06"). Omit for all history.',
            },
            maxSessions: {
              type: 'number',
              description: 'Max sessions to return. Overrides user default.',
            },
            maxTurnsPerSession: {
              type: 'number',
              description: 'Max turns per session. Overrides user default.',
            },
            maxCharsPerField: {
              type: 'number',
              description: 'Max characters per text field. Overrides user default.',
            },
            includeToolCalls: {
              type: 'boolean',
              description: 'Include tool call names in assistant summaries. Overrides user default.',
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

    // Load user defaults from ~/.agent-history/config.json, then apply argument overrides.
    const config = await loadConfig();
    const d = config.mcp;

    const maxSessions = Math.min(Number(input['maxSessions'] ?? d.maxSessions), 50);
    const maxTurnsPerSession = Math.min(Number(input['maxTurnsPerSession'] ?? d.maxTurnsPerSession), 20);
    const maxCharsPerField = Math.min(Number(input['maxCharsPerField'] ?? d.maxCharsPerField), 2000);
    const includeToolCalls = (input['includeToolCalls'] as boolean | undefined) ?? d.includeToolCalls;

    try {
      const source = input['source'] as AgentSource | undefined;
      const options = {
        ...(input['date'] ? { date: new Date(input['date'] as string) } : {}),
        maxSessions,
        maxTurnsPerSession,
        maxCharsPerField,
      };

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

          // Build assistant summary: text only, or with tool names appended.
          const textItems = (turn.items ?? [])
            .filter((i): i is { kind: 'text'; text: string } => i.kind === 'text')
            .map((i) => i.text)
            .join(' ');

          if (textItems) {
            const toolSuffix = includeToolCalls && turn.assistantSummary.includes('[')
              ? ' ' + turn.assistantSummary.match(/\[[^\]]+\]$/)?.[0]
              : '';
            lines.push(`A: ${textItems.slice(0, maxCharsPerField)}${toolSuffix ?? ''}`);
          } else if (turn.assistantSummary) {
            lines.push(`A: ${turn.assistantSummary}`);
          }
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
