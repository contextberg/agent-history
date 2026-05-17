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
import { readRecentRuns } from '../knowledge/run-log.js';
import { findCommitKnowledge } from '../knowledge/store.js';
import { CommitWatcher, type WatcherEvent } from './commit-watcher.js';
import { findGitRoot, getRepoStatus } from '../setup/repos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, 'web');
const COMMIT_SESSION_SCAN_LIMIT = 1000;

const service = new AgentHistoryService();

interface WebServerOptions {
  port?: number;
  isDev?: boolean;
}

export async function startWebServer({ port = readApiPortEnv() ?? 3847, isDev = false }: WebServerOptions = {}): Promise<void> {
  if (!isDev && !fs.existsSync(WEB_DIST)) {
    throw new Error(`Web UI not found at ${WEB_DIST}. Run "npm run build" first, or use "npm run dev" for development.`);
  }

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
  });

  // Construct the watcher up front so route handlers can close over it. We
  // start it once (after the routes are registered) and re-seed it from the
  // /api/settings path when the watched-repo list changes.
  const watcher = new CommitWatcher();
  let commitsCache: { at: number; value: { commits: Awaited<ReturnType<typeof aggregateCommits>> } } | null = null;
  let commitsInFlight: Promise<{ commits: Awaited<ReturnType<typeof aggregateCommits>> }> | null = null;

  const loadCommits = async (): Promise<{ commits: Awaited<ReturnType<typeof aggregateCommits>> }> => {
    if (commitsCache && Date.now() - commitsCache.at < 10_000) return commitsCache.value;
    if (commitsInFlight) return commitsInFlight;
    commitsInFlight = (async () => {
      // Prefer pre-computed link cache (populated by `contextberg learn` on commit).
      // For repos not yet in the cache, fall back to live computation.
      const caches = await readAllLinkCaches();

      if (caches.length > 0) {
        const cachedRepos = new Set(caches.map((c) => c.repo));
        const sessions = await getCommitScanSessions();
        const liveCommits = await aggregateCommits(
          sessions.filter((s) => !sessionTouchesAnyRepo(s, cachedRepos)),
        );
        const cachedCommits = rehydrateCachedLinks(caches.flatMap((c) => c.commits), sessions);
        const all = [...cachedCommits, ...liveCommits];
        all.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
        return { commits: all };
      }

      const sessions = await getCommitScanSessions();
      return { commits: await aggregateCommits(sessions) };
    })();
    try {
      const value = await commitsInFlight;
      commitsCache = { at: Date.now(), value };
      return value;
    } finally {
      commitsInFlight = null;
    }
  };

  watcher.on('commit-detected', () => {
    commitsCache = null;
  });
  watcher.on('learn-completed', () => {
    commitsCache = null;
    setTimeout(() => {
      void loadCommits().catch(() => undefined);
    }, 250);
  });

  app.get('/api/sessions', async (req) => {
    const query = req.query as Record<string, string>;
    const date = parseDateQuery(query['date']);
    const maxSessions = parsePositiveInt(query['maxSessions']);
    const maxTurnsPerSession = parsePositiveInt(query['maxTurnsPerSession']);
    const maxCharsPerField = parsePositiveInt(query['maxCharsPerField']);
    const options: ReaderOptions = {
      ...(date ? { date } : {}),
      ...(maxSessions ? { maxSessions } : {}),
      ...(maxTurnsPerSession ? { maxTurnsPerSession } : {}),
      ...(maxCharsPerField ? { maxCharsPerField } : {}),
    };
    const source = query['source'] as AgentSource | undefined;
    return source ? service.getSessionsBySource(source, options) : service.getSessions(options);
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const all = await getCommitScanSessions();
    const session = all.find((s) => s.id === id);
    if (!session) return reply.status(404).send({ error: 'Not found' });
    return session;
  });

  app.get('/api/status', async () => {
    return service.getStatus();
  });

  app.get('/api/commits', async () => {
    return loadCommits();
  });

  app.get('/api/settings', async () => {
    await ensureCurrentRepoTargeted();
    return loadConfig();
  });

  app.get('/api/repo-status', async () => {
    return getRepoStatus();
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
    // Re-seed the watcher when the watched-repo set changes — adding a fresh
    // repo via the wizard while the viewer is already running should "just
    // work" without needing a restart.
    const before = current.knowledge.watchedRepos ?? [];
    const after = updated.knowledge.watchedRepos ?? [];
    if (!sameStringList(before, after)) {
      watcher.stop();
      await watcher.start();
    }
    return updated;
  });

  // Recent runs endpoint — powers the "auto-learn activity" pane in the UI
  // and answers "did the watcher actually fire?" without grepping the log file.
  app.get('/api/learn-runs', async (req) => {
    const query = req.query as Record<string, string>;
    const n = Math.min(parsePositiveInt(query['limit']) ?? 20, 100);
    const runs = await readRecentRuns(n);
    return { runs };
  });

  // Per-commit knowledge note (the LLM-produced summary). The CommitView
  // pulls this when the user opens a commit, and a 404 here is the normal
  // pre-learn state — the UI just shows an empty hint in that case.
  app.get('/api/commit-knowledge', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const sha = (query['sha'] ?? '').trim();
    const repoAbs = (query['repo'] ?? '').trim();
    if (!sha || !repoAbs) {
      return reply.status(400).send({ error: 'sha and repo query params are required' });
    }
    const found = await findCommitKnowledge(repoAbs, sha);
    if (!found) return reply.status(404).send({ error: 'No knowledge note for this commit yet.' });
    return {
      sha: found.entry.sha,
      subject: found.entry.subject,
      repoName: found.entry.repoName,
      branch: found.entry.branch,
      authoredAt: found.entry.authoredAt,
      extractedAt: found.entry.extractedAt,
      provider: found.entry.provider,
      model: found.entry.model,
      body: found.entry.body,
      sessions: found.entry.sessions,
      filesChanged: found.entry.filesChanged,
      mdPath: found.mdPath,
    };
  });

  // SSE feed of commit-watcher events. Clients use EventSource('/api/events').
  // Keep-alive every 25s to defeat proxy idle timeouts; the disconnect path
  // unsubscribes the listener so we don't leak emitter handlers.
  app.get('/api/events', async (_req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (ev: WatcherEvent): void => {
      reply.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    const unsubscribe = watcher.onAny(send);
    const keepalive = setInterval(() => reply.raw.write(`: keepalive\n\n`), 25_000);
    reply.raw.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  await ensureCurrentRepoTargeted();

  // Boot the watcher AFTER the routes are registered so the very first
  // /api/events client can attach before any commit fires.
  await watcher.start();

  // Warm the by-commit view while the user is reading the default session
  // list. This moves the expensive first aggregation off the interaction path
  // without blocking server startup.
  setTimeout(() => {
    void loadCommits().catch(() => undefined);
  }, 250);

  const shutdown = async (signal: NodeJS.Signals) => {
    process.stdout.write(`\n[agent-history] ${signal} received, releasing port...\n`);
    watcher.stop();
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
      const portFile = process.env['AGENT_HISTORY_PORT_FILE'] ??
        path.join(__dirname, '..', '..', 'node_modules', '.cache', 'agent-history-port');
      await fs.promises.mkdir(path.dirname(portFile), { recursive: true });
      await fs.promises.writeFile(portFile, String(actualPort), 'utf-8');
    } catch { /* non-fatal */ }
    const webPort = process.env['AGENT_HISTORY_WEB_PORT'] || '5173';
    console.log(`[api] http://localhost:${actualPort} (proxied via Vite -> http://localhost:${webPort})`);
  } else {
    const url = `http://localhost:${actualPort}`;
    console.log(`agent-history running at ${url}`);
    await open(url);
  }
}

function readApiPortEnv(): number | undefined {
  const raw = process.env['AGENT_HISTORY_API_PORT'];
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function getCommitScanSessions(): Promise<Awaited<ReturnType<AgentHistoryService['getSessions']>>> {
  return service.getSessions({
    maxSessions: COMMIT_SESSION_SCAN_LIMIT,
    maxTurnsPerSession: 100,
    maxCharsPerField: 100_000,
  });
}

async function ensureCurrentRepoTargeted(): Promise<void> {
  try {
    const repoRoot = await findGitRoot(process.cwd());
    if (!repoRoot) return;
    const config = await loadConfig();
    const watched = config.knowledge.watchedRepos ?? [];
    const ignored = config.knowledge.ignoredRepos ?? [];
    if (ignored.some((repo) => samePath(repo, repoRoot))) return;
    if (watched.some((repo) => samePath(repo, repoRoot))) return;
    config.knowledge.watchedRepos = [...watched, repoRoot];
    await saveConfig(config);
  } catch {
    // The viewer can be opened outside a git repo; in that case there is no
    // current repo to add as a default memory target.
  }
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function parseDateQuery(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function sessionTouchesAnyRepo(
  session: Awaited<ReturnType<AgentHistoryService['getSessions']>>[number],
  repos: Set<string>,
): boolean {
  const candidatePaths: string[] = [];
  if (session.cwd) candidatePaths.push(session.cwd);
  candidatePaths.push(...(session.additionalCwds ?? []));
  const bases = expandedBases([session.cwd, ...(session.additionalCwds ?? [])]);
  for (const turn of session.turns) {
    for (const file of turn.touchedFiles ?? []) {
      if (path.isAbsolute(file)) {
        candidatePaths.push(file);
      } else {
        for (const base of bases) candidatePaths.push(path.resolve(base, file));
      }
    }
  }
  return candidatePaths.some((candidate) =>
    [...repos].some((repo) => isInside(path.resolve(candidate), repo)),
  );
}

function expandedBases(paths: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    let current = path.resolve(p);
    for (let i = 0; i < 8; i++) {
      out.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...out];
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function rehydrateCachedLinks(
  commits: Awaited<ReturnType<typeof aggregateCommits>>,
  sessions: Awaited<ReturnType<AgentHistoryService['getSessions']>>,
): Awaited<ReturnType<typeof aggregateCommits>> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const byFingerprint = new Map(
    sessions.map((s) => [`${s.source}\u0000${s.project}\u0000${s.startedAt.toISOString()}`, s]),
  );
  return commits.map((commit) => ({
    ...commit,
    links: commit.links.map((link) => {
      const exact = byId.get(link.session.id);
      const fallback = byFingerprint.get(
        `${link.session.source}\u0000${link.session.project}\u0000${link.session.startedAt}`,
      );
      const session = exact ?? fallback;
      if (!session) return link;
      return {
        ...link,
        session: {
          id: session.id,
          project: session.project,
          source: session.source,
          startedAt: session.startedAt.toISOString(),
          ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        },
      };
    }),
  }));
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
