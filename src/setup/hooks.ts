import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOOK_MARKER = '# contextberg-managed';
const HOOK_LINE = 'contextberg learn --commit HEAD 2>/dev/null || true';

export interface HookStatus {
  repoRoot: string | null;
  hookPath: string | null;
  installed: boolean;
}

async function findGitRoot(from: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: from });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function getHookStatus(cwd: string = process.cwd()): Promise<HookStatus> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) return { repoRoot: null, hookPath: null, installed: false };

  const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
  try {
    const content = await fs.readFile(hookPath, 'utf-8');
    return { repoRoot, hookPath, installed: content.includes(HOOK_MARKER) };
  } catch {
    return { repoRoot, hookPath, installed: false };
  }
}

export async function installHook(cwd: string = process.cwd()): Promise<{ repoRoot: string }> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) throw new Error('Not inside a git repository.');

  const hooksDir = path.join(repoRoot, '.git', 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'post-commit');

  let existing = '';
  try {
    existing = await fs.readFile(hookPath, 'utf-8');
  } catch {
    // no hook yet
  }

  if (existing.includes(HOOK_MARKER)) {
    return { repoRoot };
  }

  const shebang = existing.startsWith('#!') ? '' : '#!/bin/sh\n';
  const block = `\n${HOOK_MARKER}\n${HOOK_LINE}\n`;
  const content = shebang + existing + block;

  await fs.writeFile(hookPath, content, { mode: 0o755 });
  return { repoRoot };
}

export async function uninstallHook(cwd: string = process.cwd()): Promise<void> {
  const repoRoot = await findGitRoot(cwd);
  if (!repoRoot) throw new Error('Not inside a git repository.');

  const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
  let content: string;
  try {
    content = await fs.readFile(hookPath, 'utf-8');
  } catch {
    return;
  }

  if (!content.includes(HOOK_MARKER)) return;

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
}
