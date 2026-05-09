import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { AgentHistoryService } from '../readers/index.js';
import { aggregateCommits } from '../server/commits.js';
import type { AgentSession } from '../readers/types.js';
import { DEFAULT_SYSTEM_PROMPT } from './extractor.js';
import { storeKnowledge } from './store.js';
import { writeLinkCache } from './link-cache.js';
import { buildPrompt } from './transcripts.js';
import { callProvider, getOverlay, resolveAuth } from './providers/index.js';

const execFileAsync = promisify(execFile);

export interface LearnOptions {
  /** Commit SHA or ref (e.g. HEAD). Defaults to HEAD. */
  commit?: string;
  /** Absolute path to the repo. Defaults to process.cwd(). */
  repo?: string;
  verbose?: boolean;
}

function log(msg: string, verbose: boolean): void {
  if (verbose) console.error(`[contextberg] ${msg}`);
}

async function resolveCommitSha(repo: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', ref]);
  return stdout.trim();
}

async function getCommitSubject(repo: string, sha: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'log', '-1', '--pretty=%s', sha]);
  return stdout.trim();
}

/**
 * Compact diff: file headers + first ~80 lines per hunk. Full diffs blow up
 * the prompt budget without adding much signal beyond what the touched-files
 * list already conveys.
 */
async function getCommitDiff(repo: string, sha: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repo, 'show', '--stat', '--patch', '--no-color', '-M', sha],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return '';
  }
}

export async function runLearn(opts: LearnOptions = {}): Promise<void> {
  const verbose = opts.verbose ?? false;
  const repo = path.resolve(opts.repo ?? process.cwd());
  const ref = opts.commit ?? 'HEAD';

  const config = await loadConfig();
  const k = config.knowledge;

  if (!k.enabled) {
    log('knowledge extraction is disabled in config.', verbose);
    return;
  }

  const overlay = getOverlay(k.provider);
  const auth = await resolveAuth(overlay, k.apiKey);
  if (!auth) {
    console.error(
      `[contextberg] No credentials for ${overlay.displayName}. Set ${overlay.apiKeyEnv}` +
        (overlay.resolveTokenFromDisk ? ' or run `codex login`' : '') +
        ', or run `contextberg setup`.',
    );
    process.exit(1);
  }

  let sha: string;
  try {
    sha = await resolveCommitSha(repo, ref);
  } catch {
    console.error(`[contextberg] Could not resolve ${ref} in ${repo}`);
    process.exit(1);
  }

  log(`Processing commit ${sha.slice(0, 8)} in ${repo}`, verbose);
  const subject = await getCommitSubject(repo, sha).catch(() => sha.slice(0, 8));

  const service = new AgentHistoryService();
  const sessions = await service.getSessions();
  log(`Loaded ${sessions.length} sessions`, verbose);

  const commitLinks = await aggregateCommits(sessions);
  const repoLinks = commitLinks.filter((c) => c.repo === repo);
  await writeLinkCache(repo, repoLinks).catch(() => undefined);

  const match = commitLinks.find((c) => c.sha === sha && c.repo === repo);
  if (!match || match.links.length === 0) {
    log(`No sessions linked to commit ${sha.slice(0, 8)} — nothing to extract.`, verbose);
    return;
  }

  const sessionById = new Map<string, AgentSession>();
  for (const s of sessions) sessionById.set(s.id, s);

  const topLinks = match.links.slice(0, k.maxSessionsPerCommit);
  const fullSessions = topLinks
    .map((link) => {
      const full = sessionById.get(link.session.id);
      return full ? { session: full, score: link.score, reason: link.reason } : null;
    })
    .filter((x): x is { session: AgentSession; score: number; reason: string } => x !== null);

  if (fullSessions.length === 0) {
    log('Linked sessions could not be hydrated to full transcripts — skipping.', verbose);
    return;
  }

  log(`Found ${fullSessions.length} linked session(s); fetching diff…`, verbose);
  const diff = await getCommitDiff(repo, sha);

  const userContent = buildPrompt({
    sha,
    subject,
    repo: path.basename(repo),
    diffSummary: diff,
    sessions: fullSessions,
    maxTotalChars: k.maxPromptChars ?? 18000,
  });

  log(`Calling ${overlay.displayName} (${k.model})…`, verbose);
  const result = await callProvider({
    overlay,
    model: k.model,
    systemPrompt: k.prompt ?? DEFAULT_SYSTEM_PROMPT,
    userContent,
    apiKey: auth.apiKey,
    baseURL: auth.baseURL,
    maxTokens: k.maxOutputTokens ?? 2048,
  });

  if (!result.text.trim()) {
    log('Provider returned empty text — skipping store.', verbose);
    return;
  }

  const localDir = path.isAbsolute(k.outputDir) ? k.outputDir : path.join(repo, k.outputDir);

  const { localPath, globalPath } = await storeKnowledge(
    {
      sha,
      subject,
      repo,
      extractedAt: new Date().toISOString(),
      model: result.model,
      provider: result.provider,
      body: result.text,
    },
    { localDir },
  );

  if (verbose) {
    if (localPath) console.error(`[contextberg] Saved → ${localPath}`);
    console.error(`[contextberg] Saved → ${globalPath}`);
  } else {
    console.log(`[contextberg] Knowledge extracted: ${subject.slice(0, 60)}`);
  }
}
