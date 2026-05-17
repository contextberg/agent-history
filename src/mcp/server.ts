import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentHistoryService } from '../readers/index.js';
import type { AgentSource } from '../readers/index.js';
import { loadConfig, CONFIG_DEFAULTS } from '../config.js';
import {
  GetCommitKnowledgeSchema,
  readCommitKnowledge,
  formatEntriesAsMarkdown,
  type GetCommitKnowledgeInput,
} from './knowledge-tool.js';

const service = new AgentHistoryService();

const GetAgentHistorySchema = z.object({
  source: z.enum(['claude-code', 'cursor', 'openclaw', 'codex', 'hermes', 'copilot'])
    .optional()
    .describe('Filter by agent tool. Omit to get sessions from all sources.'),
  date: z.string()
    .optional()
    .describe('ISO date string (e.g. "2026-05-06"). Omit to search all history.'),
  maxSessions: z.number().int().min(1)
    .optional()
    .describe(`Max sessions to return. Default: ${CONFIG_DEFAULTS.mcp.maxSessions}.`),
  maxTurnsPerSession: z.number().int().min(1)
    .optional()
    .describe(`Max turns per session. Default: ${CONFIG_DEFAULTS.mcp.maxTurnsPerSession}.`),
  maxCharsPerField: z.number().int().min(1)
    .optional()
    .describe(`Max characters per text field. Default: ${CONFIG_DEFAULTS.mcp.maxCharsPerField}.`),
  includeToolCalls: z.boolean()
    .optional()
    .describe('List tool call names used in each turn. Default: true.'),
  includeToolOutputs: z.boolean()
    .optional()
    .describe('Include tool result output wrapped in code fences. Off by default; enabling increases payload size significantly.'),
  response_format: z.enum(['markdown', 'json'])
    .optional()
    .describe('Output format. "markdown" (default): human-readable with code blocks preserved. "json": structured data for programmatic processing.'),
});

type GetAgentHistoryInput = z.infer<typeof GetAgentHistorySchema>;

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'agent-history', version: '0.1.0' },
  );

  server.registerTool(
    'get_agent_history',
    {
      title: 'Get Agent History',
      description:
        'Retrieve prior coding-agent session history to continue work or hand off context to another agent or application. ' +
        'Returns full conversation turns — user requests, assistant replies with code blocks preserved, ' +
        'and optional tool-call traces — from Claude Code, Cursor, Codex, and other local sources. ' +
        'Use this to resume an interrupted task, understand what was already built, ' +
        "or load a previous session's context into a new agent so work can continue seamlessly. " +
        `Defaults: maxSessions=${CONFIG_DEFAULTS.mcp.maxSessions}, ` +
        `maxTurnsPerSession=${CONFIG_DEFAULTS.mcp.maxTurnsPerSession}, ` +
        `maxCharsPerField=${CONFIG_DEFAULTS.mcp.maxCharsPerField}.`,
      inputSchema: GetAgentHistorySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GetAgentHistoryInput) => {
      const config = await loadConfig();
      const d = config.mcp;

      const maxSessions = params.maxSessions ?? d.maxSessions;
      const maxTurnsPerSession = params.maxTurnsPerSession ?? d.maxTurnsPerSession;
      const maxCharsPerField = params.maxCharsPerField ?? d.maxCharsPerField;
      const includeToolCalls = params.includeToolCalls ?? d.includeToolCalls;
      const includeToolOutputs = params.includeToolOutputs ?? d.includeToolOutputs;
      const responseFormat = params.response_format ?? 'markdown';

      try {
        const source = params.source as AgentSource | undefined;
        const options = {
          ...(params.date ? { date: new Date(params.date) } : {}),
          maxSessions,
          maxTurnsPerSession,
          maxCharsPerField,
        };

        const sessions = source
          ? await service.getSessionsBySource(source, options)
          : await service.getSessions(options);

        if (sessions.length === 0) {
          const hint = params.date
            ? 'Try omitting the date filter or using a different date.'
            : 'Check that the agent tool has been used and its history directory exists (e.g. ~/.claude/projects for claude-code).';
          return { content: [{ type: 'text', text: `No agent history found. ${hint}` }] };
        }

        if (responseFormat === 'json') {
          const data = sessions.map((session) => ({
            source: session.source,
            project: session.project,
            startedAt: session.startedAt.toISOString(),
            ...(session.endedAt ? { endedAt: session.endedAt.toISOString() } : {}),
            ...(session.cwd ? { cwd: session.cwd } : {}),
            ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
            turns: session.turns.map((turn) => {
              const assistantText = (turn.items ?? [])
                .filter((i): i is { kind: 'text'; text: string } => i.kind === 'text')
                .map((i) => i.text)
                .join('\n\n') || turn.assistantSummary;
              const tools = includeToolCalls
                ? (turn.items ?? [])
                    .filter((i) => i.kind === 'tool')
                    .map((i) => {
                      if (i.kind !== 'tool') return null;
                      return {
                        name: i.tool.name,
                        ...(includeToolOutputs && i.tool.output
                          ? { output: i.tool.output.slice(0, maxCharsPerField) }
                          : {}),
                      };
                    })
                    .filter(Boolean)
                : undefined;
              return {
                userMessage: turn.userMessage,
                assistantText: assistantText.slice(0, maxCharsPerField),
                ...(tools && tools.length > 0 ? { tools } : {}),
              };
            }),
          }));
          const text = JSON.stringify(data, null, 2);
          return {
            content: [{ type: 'text', text }],
            structuredContent: { sessions: data },
          };
        }

        const lines: string[] = [];
        for (const session of sessions) {
          const headerParts = [`[${session.source}]`, session.project, session.startedAt.toISOString()];
          if (session.cwd) headerParts.push(`cwd:${session.cwd}`);
          if (session.gitBranch) headerParts.push(`branch:${session.gitBranch}`);
          lines.push(`### ${headerParts.join(' | ')}`);
          lines.push('');

          for (const [idx, turn] of session.turns.entries()) {
            lines.push(`**[Turn ${idx + 1}] User:**`);
            lines.push('');
            lines.push(turn.userMessage);
            lines.push('');

            const textContent = (turn.items ?? [])
              .filter((i): i is { kind: 'text'; text: string } => i.kind === 'text')
              .map((i) => i.text)
              .join('\n\n');

            const body = textContent || turn.assistantSummary;
            if (body) {
              lines.push('**Assistant:**');
              lines.push('');
              lines.push(body.slice(0, maxCharsPerField));
              lines.push('');
            }

            if (includeToolCalls) {
              const toolItems = (turn.items ?? []).filter((i) => i.kind === 'tool');
              if (toolItems.length > 0) {
                const names = toolItems.map((i) => i.kind === 'tool' ? `\`${i.tool.name}\`` : '').filter(Boolean);
                lines.push(`*Tools used: ${names.join(', ')}*`);
                lines.push('');
              }
            }

            if (includeToolOutputs) {
              for (const item of turn.items ?? []) {
                if (item.kind !== 'tool' || !item.tool.output) continue;
                lines.push(`**\`${item.tool.name}\` output:**`);
                lines.push('```');
                lines.push(item.tool.output.slice(0, maxCharsPerField));
                lines.push('```');
                lines.push('');
              }
            }
          }
          lines.push('---');
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error reading agent history: ${String(err)}. Try reducing maxSessions or maxTurnsPerSession, or check that the history directory is readable.` }],
        };
      }
    },
  );

  server.registerTool(
    'get_commit_knowledge',
    {
      title: 'Get Commit Knowledge',
      description:
        'Retrieve per-commit knowledge notes accumulated by contextberg. ' +
        'Each entry summarises what was done in a commit and — most usefully — where the work got stuck ' +
        '(bugs hit, dead ends ruled out, surprising behavior, judgement-call decisions). ' +
        'Use this to recall how a similar problem was tackled before, what gotchas were uncovered, ' +
        'or to brief a fresh agent on a repo it has not seen. ' +
        'Reads from ~/.agent-history/knowledge/<repo>/commits/ written by `contextberg learn`. ' +
        'Defaults: limit=10 (cap 20), maxCharsPerEntry=1500 (cap 2000).',
      inputSchema: GetCommitKnowledgeSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GetCommitKnowledgeInput) => {
      try {
        const entries = await readCommitKnowledge(params);
        return { content: [{ type: 'text', text: formatEntriesAsMarkdown(entries) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error reading commit knowledge: ${String(err)}` }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('agent-history MCP server running via stdio');
}
