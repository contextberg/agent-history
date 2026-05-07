import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolve `<subPath>` relative to every reachable user home across all WSL
 * distros (Windows host only). Returns the candidates that actually exist on
 * disk. Lets readers running on Windows pick up data produced by tools that
 * actually ran inside WSL — same agent, different OS.
 *
 * `subPath` is joined under `\\wsl.localhost\<distro>\home\<user>\` so pass a
 * path **relative to a user home**, e.g. `.claude/projects` or
 * `.openclaw/agents`.
 */
export async function wslHomePaths(subPath: string): Promise<string[]> {
  if (process.platform !== 'win32') return [];

  const distros = await listWslDistros();
  if (distros.length === 0) return [];

  const out: string[] = [];
  for (const distro of distros) {
    const homeRoot = `\\\\wsl.localhost\\${distro}\\home`;
    const entries = await fs.readdir(homeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(homeRoot, entry.name, subPath);
      try {
        await fs.access(candidate);
        out.push(candidate);
      } catch { /* not present in this user's home */ }
    }
  }
  return out;
}

/**
 * Node cannot enumerate the UNC server root (`\\wsl.localhost\`), so we list
 * distros via `wsl.exe -l -q`. Output is UTF-16LE on Windows.
 */
async function listWslDistros(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
    return stdout
      .toString('utf16le')
      .split(/\r?\n/)
      .map((s) => s.replace(/\0/g, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
