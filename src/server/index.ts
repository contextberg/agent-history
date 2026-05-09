import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { AgentHistoryService } from '../readers/index.js';
import type { AgentSource, ReaderOptions } from '../readers/index.js';
import { loadConfig, saveConfig } from '../config.js';
import type { AgentHistoryConfig } from '../config.js';
import { aggregateCommits } from './commits.js';
import { readAllLinkCaches } from '../knowledge/link-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, 'web');

const service = new AgentHistoryService();

interface WebServerOptions {
  port?: number;
  isDev?: boolean;
}

export async function startWebServer({ port = 3847, isDev = false }: WebServerOptions = {}): Promise<void> {
  if (!isDev && !fs.existsSync(WEB_DIST)) {
    throw new Error(`Web UI not found at ${WEB_DIST}. Run "npm run build" first, or use "npm run dev" for development.`);
  }

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

  app.get('/api/commits', async () => {
    // Prefer pre-computed link cache (populated by `contextberg learn` on commit).
    // For repos not yet in the cache, fall back to live computation.
    const caches = await readAllLinkCaches();

    if (caches.length > 0) {
      const cachedRepos = new Set(caches.map((c) => c.repo));
      const sessions = await service.getSessions({ maxSessions: 200 });
      const liveCommits = await aggregateCommits(
        sessions.filter((s) => !s.cwd || !cachedRepos.has(s.cwd)),
      );
      const cachedCommits = caches.flatMap((c) => c.commits);
      const all = [...cachedCommits, ...liveCommits];
      all.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      return { commits: all };
    }

    const sessions = await service.getSessions({ maxSessions: 200 });
    return { commits: await aggregateCommits(sessions) };
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
      knowledge: { ...current.knowledge, ...body.knowledge },
    };
    await saveConfig(updated);
    return updated;
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    process.stdout.write(`\n[agent-history] ${signal} received, releasing port...\n`);
    try { await app.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (!isDev) {
    await app.register(staticPlugin, { root: WEB_DIST, prefix: '/' });
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  const actualPort = await listenWithFallback(app, port);
  if (isDev) {
    // Publish the resolved port so vite.config.ts can proxy correctly even
    // when the default 3847 is taken and we fall back to 3848/3849/...
    try {
      const portFile = path.join(__dirname, '..', '..', 'node_modules', '.cache', 'agent-history-port');
      await fs.promises.mkdir(path.dirname(portFile), { recursive: true });
      await fs.promises.writeFile(portFile, String(actualPort), 'utf-8');
    } catch { /* non-fatal */ }
    console.log(`[api] http://localhost:${actualPort} (proxied via Vite → http://localhost:5173)`);
  } else {
    const url = `http://localhost:${actualPort}`;
    console.log(`agent-history running at ${url}`);
    await open(url);
  }
}

async function listenWithFallback(
  app: ReturnType<typeof Fastify>,
  startPort: number,
  maxRetries = 20,
): Promise<number> {
  for (let i = 0; i < maxRetries; i++) {
    const port = startPort + i;
    try {
      await app.listen({ port, host: '127.0.0.1' });
      return port;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
      if (i === maxRetries - 1) throw err;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxRetries - 1}`);
}
