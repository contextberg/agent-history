import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { AgentHistoryService } from '../readers/index.js';
import type { AgentSource, ReaderOptions } from '../readers/index.js';
import { loadConfig, saveConfig } from '../config.js';
import type { AgentHistoryConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, 'web');

const service = new AgentHistoryService();

export async function startWebServer(port = 3847): Promise<void> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
  });

  app.get('/api/sessions', async (req) => {
    const query = req.query as Record<string, string>;
    const options: ReaderOptions = {
      ...(query['date'] ? { date: new Date(query['date']) } : {}),
      ...(query['maxSessions'] ? { maxSessions: Number(query['maxSessions']) } : {}),
    };
    const source = query['source'] as AgentSource | undefined;
    return source ? service.getSessionsBySource(source, options) : service.getSessions(options);
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const all = await service.getSessions();
    const session = all.find((s) => s.id === id);
    if (!session) return reply.status(404).send({ error: 'Not found' });
    return session;
  });

  app.get('/api/status', async () => {
    return service.getStatus();
  });

  app.get('/api/settings', async () => {
    return loadConfig();
  });

  app.post('/api/settings', async (req, reply) => {
    const body = req.body as Partial<AgentHistoryConfig>;
    const current = await loadConfig();
    const updated: AgentHistoryConfig = {
      display: { ...current.display, ...body.display },
      mcp: { ...current.mcp, ...body.mcp },
    };
    await saveConfig(updated);
    return updated;
  });

  await app.register(staticPlugin, { root: WEB_DIST, prefix: '/' });

  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile('index.html');
  });

  const actualPort = await listenWithFallback(app, port);
  const url = `http://localhost:${actualPort}`;
  console.log(`agent-history running at ${url}`);
  await open(url);
}

async function listenWithFallback(
  app: ReturnType<typeof Fastify>,
  startPort: number,
  maxRetries = 5,
): Promise<number> {
  for (let i = 0; i < maxRetries; i++) {
    const port = startPort + i;
    try {
      await app.listen({ port, host: '127.0.0.1' });
      return port;
    } catch (err: unknown) {
      if (i === maxRetries - 1) throw err;
    }
  }
  throw new Error('No available port found');
}
