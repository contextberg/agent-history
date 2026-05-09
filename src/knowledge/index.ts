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
import { callProvider, findModel, getProfile, resolveAuth } from './providers/index.js';
import { inspectCommit, filterDiff } from './commit-filter.js';
import { appendRunLog, type RunStatus } from './run-log.js';

const execFileAsync = promisify(execFile);

export interface LearnOptions {
  /** Commit SHA or ref (e.g. HEAD). Defaults to HEAD. */
  commit?: string;
  /** Absolute path to the repo. Defaults to process.cwd(). */
  repo?: string;
  verbose?: boolean;
  /** Skip the commit filter (for manual re-runs). */
  force?: boolean;
}

function log(msg: string, verbose: boolean): void {
  if (verbose) console.error(`[contextberg] ${msg}`);
}

async function resolveCommitSha(repo: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', ref]);
  return stdout.trim();
}

interface CommitMeta {
  subject: string;
  body: string;
  authorName: string;
  authoredAt: string;
  branch: string;
}

async function getCommitMeta(repo: string, sha: string): Promise<CommitMeta> {
  // Use a custom delimiter to safely capture multiline body without subprocess churn.
  const FMT = ['%s', '%b', '%an', '%aI'].join('%x1f');
  const { stdout: log } = await execFileAsync('git', ['-C', repo, 'log', '-1', `--pretty=format:${FMT}`, sha]);
  const [subject = '', body = '', authorName = '', authoredAt = ''] = log.split('\x1f');

  let branch = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD']);
    branch = stdout.trim();
  } catch { /* detached HEAD */ }

  return { subject: subject.trim(), body: body.trim(), authorName: authorName.trim(), authoredAt: authoredAt.trim(), branch };
}

function extractStatsLine(diff: string): string {
  // git show --stat ends with a line like:
  //   "5 files changed, 120 insertions(+), 8 deletions(-)"
  const m = diff.match(/^\s*\d+ files? changed.*$/m);
  return m ? m[0].trim() : '';
}

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

/**
 * Walk the resumedFrom chain so a session that picked up where another left
 * off carries its parent's context too. Bounded to 4 hops to avoid pathological
 * loops in malformed metadata.
 */
function expandLineage(
  seeds: AgentSession[],
  byId: Map<string, AgentSession>,
): AgentSession[] {
  const out: AgentSession[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    let current: AgentSession | undefined = s;
    let hops = 0;
    while (current && !seen.has(current.id) && hops < 4) {
      seen.add(current.id);
      out.push(current);
      current = current.resumedFrom ? byId.get(current.resumedFrom) : undefined;
      hops += 1;
    }
  }
  return out;
}

export async function runLearn(opts: LearnOptions = {}): Promise<void> {
  const verbose = opts.verbose ?? false;
  const repo = path.resolve(opts.repo ?? process.cwd());
  const ref = opts.commit ?? 'HEAD';

  // Helper to log a terminal status to learn.log without losing the original
  // control-flow shape (early returns, process.exit on hard errors).
  const finish = async (
    sha: string | null,
    status: RunStatus,
    extras: Record<string, unknown> = {},
    reason?: string,
  ): Promise<void> => {
    await appendRunLog({
      ts: new Date().toISOString(),
      sha,
      repo,
      status,
      ...(reason ? { reason } : {}),
      ...extras,
    } as Parameters<typeof appendRunLog>[0]).catch(() => undefined);
  };

  const config = await loadConfig();
  const k = config.knowledge;

  if (!k.enabled) {
    log('knowledge extraction is disabled in config.', verbose);
    await finish(null, 'skip', {}, 'disabled in config');
    return;
  }

  let sha: string;
  try {
    sha = await resolveCommitSha(repo, ref);
  } catch {
    console.error(`[contextberg] Could not resolve ${ref} in ${repo}`);
    await finish(null, 'error', {}, `could not resolve ref ${ref}`);
    process.exit(1);
  }

  // Cheap commit-level checks before we touch sessions or call the LLM.
  if (!opts.force) {
    const inspection = await inspectCommit(repo, sha).catch(() => null);
    if (inspection?.skip) {
      log(`Skipping ${sha.slice(0, 8)}: ${inspection.reason}.`, verbose);
      await finish(sha, 'skip', {}, inspection.reason ?? undefined);
      return;
    }
  }

  // API auth comes after the cheap filter — no point validating creds for a
  // commit we'd skip anyway.
  const profile = getProfile(k.provider);
  const auth = await resolveAuth(profile, k.apiKey);
  if (!auth) {
    const lines: string[] = [`No credentials for ${profile.displayName}.`];
    if (profile.authType === 'oauth_disk') {
      if (profile.signupUrl) lines.push(`  Sign in at: ${profile.signupUrl}`);
      lines.push(`  Run \`contextberg setup\` to start the device-code sign-in flow.`);
    } else {
      if (profile.signupUrl) lines.push(`  Get a key at: ${profile.signupUrl}`);
      const envHint = profile.envVars[0];
      if (envHint) lines.push(`  Then set ${envHint} in your environment`);
      lines.push(`  …or run \`contextberg setup\` to save it interactively.`);
    }
    console.error(`[contextberg] ${lines.join('\n  ')}`);
    await finish(sha, 'no-auth', { provider: k.provider }, `missing credentials for ${profile.id}`);
    process.exit(1);
  }
  const model = findModel(profile, k.model);

  log(`Processing commit ${sha.slice(0, 8)} in ${repo}`, verbose);
  const meta = await getCommitMeta(repo, sha).catch(() => ({
    subject: sha.slice(0, 8),
    body: '',
    authorName: '',
    authoredAt: '',
    branch: '',
  }));
  const subject = meta.subject;

  const service = new AgentHistoryService();
  const sessions = await service.getSessions();
  log(`Loaded ${sessions.length} sessions`, verbose);

  const commitLinks = await aggregateCommits(sessions);
  const repoLinks = commitLinks.filter((c) => c.repo === repo);
  await writeLinkCache(repo, repoLinks).catch(() => undefined);

  const match = commitLinks.find((c) => c.sha === sha && c.repo === repo);
  if (!match || match.links.length === 0) {
    log(`No sessions linked to commit ${sha.slice(0, 8)} — nothing to extract.`, verbose);
    await finish(sha, 'no-sessions', { provider: k.provider, model: k.model });
    return;
  }

  const sessionById = new Map<string, AgentSession>();
  for (const s of sessions) sessionById.set(s.id, s);

  const topLinks = match.links.slice(0, k.maxSessionsPerCommit);
  const seeds = topLinks
    .map((link) => sessionById.get(link.session.id))
    .filter((s): s is AgentSession => s !== undefined);

  const linked = expandLineage(seeds, sessionById);

  // Re-pair lineage members with the score of their seed (parent inherits child's score).
  const scoreById = new Map<string, { score: number; reason: string }>();
  for (const link of topLinks) {
    scoreById.set(link.session.id, { score: link.score, reason: link.reason });
  }
  const fullSessions = linked.map((session) => {
    const meta = scoreById.get(session.id) ?? {
      score: 0.0,
      reason: 'lineage parent (resumedFrom)',
    };
    return { session, ...meta };
  });

  if (fullSessions.length === 0) {
    log('Linked sessions could not be hydrated to full transcripts — skipping.', verbose);
    await finish(sha, 'no-sessions', { provider: k.provider, model: k.model }, 'lineage hydration failed');
    return;
  }

  log(`Found ${fullSessions.length} session(s) (incl. lineage); fetching diff…`, verbose);
  const rawDiff = await getCommitDiff(repo, sha);
  const diff = filterDiff(rawDiff);
  const stats = extractStatsLine(rawDiff);

  const userContent = buildPrompt({
    sha,
    subject,
    body: meta.body,
    authorName: meta.authorName,
    authoredAt: meta.authoredAt,
    branch: meta.branch,
    stats,
    repo: path.basename(repo),
    diffSummary: diff,
    commitFiles: match.files,
    sessions: fullSessions,
    maxTotalChars: k.maxPromptChars ?? 18000,
  });

  log(`Calling ${profile.displayName} (${model.id})…`, verbose);
  const startedAt = Date.now();
  let result;
  try {
    result = await callProvider({
      profile,
      model,
      systemPrompt: k.prompt ?? DEFAULT_SYSTEM_PROMPT,
      userContent,
      auth,
      maxTokens: k.maxOutputTokens ?? 2048,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[contextberg] Provider call failed: ${msg}`);
    await finish(
      sha,
      'error',
      { provider: k.provider, model: k.model, durationMs: Date.now() - startedAt, inputChars: userContent.length },
      msg,
    );
    process.exit(1);
  }
  const durationMs = Date.now() - startedAt;

  if (!result.text.trim()) {
    log('Provider returned empty text — skipping store.', verbose);
    await finish(
      sha,
      'empty',
      { provider: k.provider, model: k.model, durationMs, inputChars: userContent.length },
    );
    return;
  }

  const localDir = path.isAbsolute(k.outputDir) ? k.outputDir : path.join(repo, k.outputDir);

  const stored = await storeKnowledge(
    {
      sha,
      subject,
      repo,
      repoName: path.basename(repo),
      branch: meta.branch,
      authorName: meta.authorName,
      authoredAt: meta.authoredAt,
      extractedAt: new Date().toISOString(),
      model: result.model,
      provider: result.provider,
      body: result.text,
      sessions: fullSessions.map((fs) => ({
        id: fs.session.id,
        score: fs.score,
        reason: fs.reason,
      })),
      filesChanged: match.files,
      inputChars: userContent.length,
      outputChars: result.text.length,
      durationMs,
    },
    { localDir },
  );

  if (verbose) {
    if (stored.localMdPath) console.error(`[contextberg] Saved → ${stored.localMdPath}`);
    console.error(`[contextberg] Saved → ${stored.globalMdPath}`);
    if (stored.changelogPath) console.error(`[contextberg] CHANGELOG → ${stored.changelogPath}`);
  } else {
    console.log(`[contextberg] Knowledge extracted: ${subject.slice(0, 60)}`);
    if (stored.localMdPath) console.log(`  ${stored.localMdPath}`);
  }

  await finish(sha, 'ok', {
    provider: result.provider,
    model: result.model,
    durationMs,
    inputChars: userContent.length,
    outputChars: result.text.length,
    sessions: fullSessions.map((fs) => fs.session.id),
  });
}
