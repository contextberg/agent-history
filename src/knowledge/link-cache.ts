import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_DIR } from '../config.js';
import type { CommitWithLinks } from '../server/commits.js';

export interface LinkCacheEntry {
  repo: string;
  computedAt: string;
  commits: CommitWithLinks[];
}

const CACHE_DIR = path.join(CONFIG_DIR, 'link-cache');

function cacheId(repoPath: string): string {
  return createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 12);
}

function cachePath(repoPath: string): string {
  return path.join(CACHE_DIR, `${cacheId(repoPath)}.json`);
}

export async function writeLinkCache(repoPath: string, commits: CommitWithLinks[]): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const entry: LinkCacheEntry = {
    repo: path.resolve(repoPath),
    computedAt: new Date().toISOString(),
    commits,
  };
  await fs.writeFile(cachePath(repoPath), JSON.stringify(entry), 'utf-8');
}

export async function readLinkCache(repoPath: string): Promise<LinkCacheEntry | null> {
  try {
    const raw = await fs.readFile(cachePath(repoPath), 'utf-8');
    return JSON.parse(raw) as LinkCacheEntry;
  } catch {
    return null;
  }
}

/** Read all available cache entries (across all repos). */
export async function readAllLinkCaches(): Promise<LinkCacheEntry[]> {
  let files: string[];
  try {
    files = await fs.readdir(CACHE_DIR);
  } catch {
    return [];
  }

  const results: LinkCacheEntry[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(CACHE_DIR, file), 'utf-8');
      results.push(JSON.parse(raw) as LinkCacheEntry);
    } catch {
      // corrupt file — skip
    }
  }
  return results;
}
