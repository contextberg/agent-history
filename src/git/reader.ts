import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitCommit {
  /** Repo path the commit belongs to (absolute, normalized via path.resolve). */
  repo: string;
  sha: string;
  /** Author time as a Date (we ignore committer time — author is closer to "when work happened"). */
  time: Date;
  authorName: string;
  authorEmail: string;
  subject: string;
  /** Branch ref the commit is reachable from at the time we read. Optional best-effort. */
  branch?: string;
  /** Absolute paths of files touched by this commit. */
  files: string[];
}

export interface ReadCommitsOptions {
  since?: Date;
  until?: Date;
  /** When set, restrict to commits authored by this email or name (case-insensitive substring). */
  author?: string;
  /** Hard cap; default 200. */
  limit?: number;
}

/**
 * Read recent commits from a single repo using git CLI.
 * Fail-soft: returns [] on any error (not a git repo, git not on PATH, etc).
 */
export async function readCommits(
  repoPath: string,
  options: ReadCommitsOptions = {},
): Promise<GitCommit[]> {
  const repo = path.resolve(repoPath);
  const limit = options.limit ?? 200;

  const args: string[] = [
    '-C', repo,
    'log',
    `-n${limit}`,
    '--no-merges',
    '--name-only',
    // Use NUL byte to terminate each commit so subjects can contain anything.
    // Format: sha\u0001authorIso\u0001authorName\u0001authorEmail\u0001subject
    '--pretty=format:%H%x01%aI%x01%an%x01%ae%x01%s',
    '-z',
  ];
  if (options.since) args.push(`--since=${options.since.toISOString()}`);
  if (options.until) args.push(`--until=${options.until.toISOString()}`);
  if (options.author) args.push(`--author=${options.author}`);

  let stdout = '';
  try {
    const result = await exec('git', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    stdout = result.stdout;
  } catch {
    return [];
  }

  return parseGitLogZ(stdout, repo);
}

/**
 * Parse `git log -z --name-only --pretty=format:...%x01...` output.
 * With -z, commits and file lists are separated by NUL. The format string
 * uses \x01 between commit fields. After the format line for a commit comes
 * a newline, then the file list (each path on its own line), then a NUL.
 */
function parseGitLogZ(stdout: string, repo: string): GitCommit[] {
  if (!stdout) return [];
  const commits: GitCommit[] = [];
  // -z separates *records*, but when --name-only is on, each commit's payload
  // is "<header>\n<file>\n<file>\n..." and records are separated by NUL.
  for (const block of stdout.split('\u0000')) {
    if (!block.trim()) continue;
    const newlineIdx = block.indexOf('\n');
    const header = newlineIdx === -1 ? block : block.slice(0, newlineIdx);
    const fileBlock = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1);
    const parts = header.split('\u0001');
    if (parts.length < 5) continue;
    const [sha, iso, authorName, authorEmail, subject] = parts as [string, string, string, string, string];
    const time = new Date(iso);
    if (isNaN(time.getTime())) continue;
    const files = fileBlock
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => path.resolve(repo, f));
    commits.push({ repo, sha, time, authorName, authorEmail, subject, files });
  }
  return commits;
}

/**
 * Walk up from a path to find the nearest ancestor that is a git repo root.
 * Returns the absolute repo root, or null if none found.
 */
export async function findRepoRoot(startPath: string): Promise<string | null> {
  try {
    const result = await exec('git', ['-C', startPath, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
    });
    const out = result.stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}
