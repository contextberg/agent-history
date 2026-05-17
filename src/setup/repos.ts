import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, saveConfig } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Manage the list of repos the in-process commit watcher tails. Replaces the
 * old per-repo `.git/hooks/post-commit` mechanism (kept around as a legacy
 * artifact only — see `findLegacyHook` / `removeLegacyHook` for cleanup).
 *
 * Source of truth: `~/.agent-history/config.json` → `knowledge.watchedRepos`.
 *
 * All paths are stored as absolute, normalised, with the host's separator. A
 * fresh `git rev-parse --show-toplevel` resolves the repo root for whatever
 * subdirectory the user happened to invoke `contextberg setup` from.
 */

export interface RepoStatus {
  /** Resolved git repo root, or null if cwd isn't inside a git repo. */
  repoRoot: string | null;
  /** True when repoRoot is in config.knowledge.watchedRepos. */
  watched: boolean;
  /** Path to the legacy post-commit hook if one is still around — not deleted automatically. */
  legacyHookPath: string | null;
  /** True when the legacy hook contains the contextberg marker line. */
  legacyHookInstalled: boolean;
}

const HOOK_MARKER = '# contextberg-managed';
const HOOK_LINE = 'contextberg learn --commit HEAD 2>/dev/null || true';

export async function findGitRoot(from: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: from });
    return path.normalize(stdout.trim());
  } catch {
    return null;
  }
}

export async function getRepoStatus(cwd: string = process.cwd()): Promise<RepoStatus> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) {
    return { repoRoot: null, watched: false, legacyHookPath: null, legacyHookInstalled: false };
  }

  const config = await loadConfig();
  const list = config.knowledge.watchedRepos ?? [];
  const watched = list.some((r) => path.normalize(r) === repoRoot);

  const legacy = await inspectLegacyHook(repoRoot);
  return { repoRoot, watched, ...legacy };
}

interface LegacyHookInfo {
  legacyHookPath: string | null;
  legacyHookInstalled: boolean;
}

async function inspectLegacyHook(repoRoot: string): Promise<LegacyHookInfo> {
  const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
  try {
    const content = await fs.readFile(hookPath, 'utf-8');
    return { legacyHookPath: hookPath, legacyHookInstalled: content.includes(HOOK_MARKER) };
  } catch {
    return { legacyHookPath: hookPath, legacyHookInstalled: false };
  }
}

/** Add the repo to the watch list. Idempotent. Returns the repo root used. */
export async function registerRepo(cwd: string = process.cwd()): Promise<{ repoRoot: string }> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) throw new Error('Not inside a git repository.');

  const config = await loadConfig();
  const current = config.knowledge.watchedRepos ?? [];
  const normalized = path.normalize(repoRoot);
  if (current.some((r) => path.normalize(r) === normalized)) {
    return { repoRoot: normalized };
  }
  config.knowledge.watchedRepos = [...current, normalized];
  await saveConfig(config);
  return { repoRoot: normalized };
}

/**
 * Remove the repo from the watch list AND scrub any legacy post-commit hook
 * that the previous setup mechanism left behind. The hook removal is the
 * one-time bridge for users upgrading past the watcher cutover — once the
 * hooks are gone they stay gone.
 */
export async function unregisterRepo(cwd: string = process.cwd()): Promise<{ repoRoot: string; removedLegacyHook: boolean }> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) throw new Error('Not inside a git repository.');
  const normalized = path.normalize(repoRoot);

  const config = await loadConfig();
  const current = config.knowledge.watchedRepos ?? [];
  const filtered = current.filter((r) => path.normalize(r) !== normalized);
  if (filtered.length !== current.length) {
    config.knowledge.watchedRepos = filtered;
    await saveConfig(config);
  }

  const removedLegacyHook = await removeLegacyHook(normalized);
  return { repoRoot: normalized, removedLegacyHook };
}

/**
 * Strip the contextberg-managed lines out of a repo's post-commit hook. If
 * the hook contained nothing else, it's deleted; otherwise the surviving
 * lines are written back.
 */
export async function removeLegacyHook(repoRoot: string): Promise<boolean> {
  const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
  let content: string;
  try {
    content = await fs.readFile(hookPath, 'utf-8');
  } catch {
    return false;
  }
  if (!content.includes(HOOK_MARKER)) return false;

  const cleaned = content
    .split('\n')
    .filter((line) => line !== HOOK_MARKER && line !== HOOK_LINE)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  if (cleaned === '#!/bin/sh' || cleaned === '') {
    await fs.unlink(hookPath).catch(() => undefined);
  } else {
    await fs.writeFile(hookPath, cleaned + '\n', { mode: 0o755 });
  }
  return true;
}
