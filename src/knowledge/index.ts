import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { AgentHistoryService } from '../readers/index.js';
import { aggregateCommits } from '../server/commits.js';
import { extractKnowledge, DEFAULT_SYSTEM_PROMPT } from './extractor.js';
import { storeKnowledge } from './store.js';
import { writeLinkCache } from './link-cache.js';

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

function resolveApiKey(provider: string, configKey?: string): string | undefined {
  const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  return process.env[envVar] ?? configKey;
}

async function resolveCommitSha(repo: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', ref]);
  return stdout.trim();
}

async function getCommitSubject(repo: string, sha: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'log', '-1', '--pretty=%s', sha]);
  return stdout.trim();
}

function buildUserContent(
  sha: string,
  subject: string,
  repo: string,
  sessions: Awaited<ReturnType<typeof aggregateCommits>>[number]['links'],
): string {
  const MAX_CHARS = 3000;
  const parts: string[] = [
    `## Commit`,
    `SHA: ${sha}`,
    `Subject: ${subject}`,
    `Repo: ${path.basename(repo)}`,
    ``,
    `## Agent sessions`,
  ];

  for (const link of sessions) {
    parts.push(`### Session ${link.session.id.slice(0, 8)} (${link.session.source}, score ${link.score.toFixed(2)})`);
    // session snippet only — full transcripts not available via CommitWithLinks
    parts.push(`Project: ${link.session.project}`);
    if (link.session.gitBranch) parts.push(`Branch: ${link.session.gitBranch}`);
    parts.push('');
  }

  const joined = parts.join('\n');
  return joined.length > MAX_CHARS ? joined.slice(0, MAX_CHARS) + '\n[truncated]' : joined;
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

  const apiKey = resolveApiKey(k.provider, k.apiKey);
  if (!apiKey) {
    const envVar = k.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    console.error(`[contextberg] No API key found. Set ${envVar} or run \`contextberg setup\`.`);
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

  // Persist the computed links for this repo so the web UI can serve them
  // from cache instead of recomputing on every page load.
  const repoLinks = commitLinks.filter((c) => c.repo === repo);
  await writeLinkCache(repo, repoLinks).catch(() => undefined);

  const match = commitLinks.find((c) => c.sha === sha && c.repo === repo);

  if (!match || match.links.length === 0) {
    log(`No sessions linked to commit ${sha.slice(0, 8)} — nothing to extract.`, verbose);
    return;
  }

  const topLinks = match.links.slice(0, k.maxSessionsPerCommit);
  log(`Found ${topLinks.length} linked session(s)`, verbose);

  const userContent = buildUserContent(sha, subject, repo, topLinks);
  const systemPrompt = k.prompt ?? DEFAULT_SYSTEM_PROMPT;

  log(`Calling ${k.provider}/${k.model}…`, verbose);
  const result = await extractKnowledge({ provider: k.provider, model: k.model, apiKey, systemPrompt, userContent });

  const localDir = path.isAbsolute(k.outputDir)
    ? k.outputDir
    : path.join(repo, k.outputDir);

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
