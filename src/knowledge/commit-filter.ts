import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const NOISE_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|uv\.lock|go\.sum)$/,
  /(^|\/)(dist|build|out|target|coverage|\.next|\.nuxt|node_modules)\//,
  /\.min\.(js|css|map)$/,
  /\.lock$/,
  /(^|\/)CHANGELOG\.md$/i,
];

const BOT_AUTHOR_RE = /\b(dependabot|renovate|github-actions|snyk-bot|imgbot|allcontributors|pre-commit-ci)\b/i;

export type SkipReason =
  | 'merge'
  | 'bot'
  | 'noise-only'
  | 'no-files'
  | null;

export interface CommitFilterResult {
  skip: boolean;
  reason: SkipReason;
  files: string[];
  parents: string[];
  authorEmail: string;
}

function isNoise(file: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(file));
}

async function gitOut(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function inspectCommit(repo: string, sha: string): Promise<CommitFilterResult> {
  const filesRaw = await gitOut(['-C', repo, 'show', '--no-renames', '--name-only', '--pretty=format:', sha]);
  const files = filesRaw.split('\n').map((s) => s.trim()).filter(Boolean);

  const parentsRaw = await gitOut(['-C', repo, 'rev-list', '--parents', '-n', '1', sha]);
  const parents = parentsRaw.trim().split(/\s+/).slice(1);

  const authorEmail = (await gitOut(['-C', repo, 'log', '-1', '--pretty=%ae', sha])).trim();

  if (parents.length > 1) {
    return { skip: true, reason: 'merge', files, parents, authorEmail };
  }
  if (BOT_AUTHOR_RE.test(authorEmail)) {
    return { skip: true, reason: 'bot', files, parents, authorEmail };
  }
  if (files.length === 0) {
    return { skip: true, reason: 'no-files', files, parents, authorEmail };
  }
  if (files.every(isNoise)) {
    return { skip: true, reason: 'noise-only', files, parents, authorEmail };
  }

  return { skip: false, reason: null, files, parents, authorEmail };
}

/**
 * Filter the patch portion of `git show --stat --patch` output:
 * keep the --stat block (gives the LLM a file overview) and the file
 * headers, but drop the diff hunks for noise files.
 */
export function filterDiff(rawDiff: string): string {
  // git show output structure:
  //   <commit header>
  //   <stat block>
  //   <patch sections, each starting with "diff --git a/X b/Y">
  const sections = rawDiff.split(/\n(?=diff --git )/);
  if (sections.length <= 1) return rawDiff;

  const head = sections[0];
  const filtered = sections.slice(1).map((section) => {
    const firstLine = section.split('\n', 1)[0] ?? '';
    const match = firstLine.match(/diff --git a\/(\S+) b\/(\S+)/);
    if (match) {
      const file = match[2] ?? match[1] ?? '';
      if (file && isNoise(file)) {
        return `diff --git a/${file} b/${file}\n[diff omitted: noise file]`;
      }
    }
    return section;
  });

  return [head, ...filtered].join('\n');
}
