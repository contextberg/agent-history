import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';

export const EXTRACTION_VERSION = 1;

export interface SessionLink {
  id: string;
  score: number;
  reason: string;
}

export interface KnowledgeEntry {
  sha: string;
  subject: string;
  repo: string;
  /** Repo basename — used as the global cache subdirectory. */
  repoName: string;
  branch: string;
  authorName: string;
  authoredAt: string;
  extractedAt: string;
  model: string;
  provider: string;
  /** Free-form markdown body produced by the LLM. */
  body: string;
  /** Sessions that were fed to the LLM, ordered by score desc. */
  sessions: SessionLink[];
  filesChanged: string[];
  inputChars: number;
  outputChars: number;
  durationMs: number;
}

export interface StoreResult {
  localMdPath: string | null;
  localJsonPath: string | null;
  globalMdPath: string;
  globalJsonPath: string;
  changelogPath: string | null;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Repo-friendly slug from a commit subject. */
function slugFromSubject(subject: string): string {
  const cleaned = subject
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 50) || 'commit';
}

function quoteYaml(value: string): string {
  // Force JSON encoding for safety — guarantees no YAML special-char hazards.
  return JSON.stringify(value);
}

function renderFrontmatter(entry: KnowledgeEntry): string {
  const lines: string[] = ['---'];
  lines.push(`sha: ${entry.sha}`);
  lines.push(`subject: ${quoteYaml(entry.subject)}`);
  lines.push(`repo: ${quoteYaml(entry.repoName)}`);
  if (entry.branch) lines.push(`branch: ${quoteYaml(entry.branch)}`);
  if (entry.authorName) lines.push(`author: ${quoteYaml(entry.authorName)}`);
  if (entry.authoredAt) lines.push(`authored_at: ${entry.authoredAt}`);
  lines.push(`extracted_at: ${entry.extractedAt}`);
  lines.push(`provider: ${entry.provider}`);
  lines.push(`model: ${quoteYaml(entry.model)}`);
  lines.push(`duration_ms: ${entry.durationMs}`);
  lines.push(`input_chars: ${entry.inputChars}`);
  lines.push(`output_chars: ${entry.outputChars}`);
  lines.push(`extraction_version: ${EXTRACTION_VERSION}`);
  if (entry.filesChanged.length > 0) {
    lines.push('files_changed:');
    for (const f of entry.filesChanged) lines.push(`  - ${quoteYaml(f)}`);
  }
  if (entry.sessions.length > 0) {
    lines.push('sessions:');
    for (const s of entry.sessions) {
      lines.push(`  - id: ${quoteYaml(s.id)}`);
      lines.push(`    score: ${s.score.toFixed(2)}`);
      lines.push(`    reason: ${quoteYaml(s.reason)}`);
    }
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function renderHeader(entry: KnowledgeEntry): string {
  const shortSha = entry.sha.slice(0, 7);
  const dateOnly = (entry.authoredAt || entry.extractedAt).slice(0, 10);
  const branchPart = entry.branch ? `${entry.repoName}/${entry.branch}` : entry.repoName;
  return [
    `# ${entry.subject}`,
    '',
    `\`${shortSha}\` · ${dateOnly} · ${branchPart} · ${entry.provider}/${entry.model} · ${entry.sessions.length} session${entry.sessions.length === 1 ? '' : 's'}`,
    '',
  ].join('\n');
}

function renderMarkdown(entry: KnowledgeEntry): string {
  return [
    renderFrontmatter(entry),
    renderHeader(entry),
    entry.body.trim(),
    '',
  ].join('\n');
}

function renderChangelogEntry(entry: KnowledgeEntry, mdRelPath: string): string {
  const dateOnly = entry.extractedAt.slice(0, 10);
  const subj = entry.subject.replace(/\n/g, ' ').slice(0, 100);
  return `- ${dateOnly} \`${entry.sha.slice(0, 7)}\` ${subj}  ([detail](${mdRelPath}))\n`;
}

async function writeFileFresh(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function appendIfNew(
  filePath: string,
  marker: string,
  blockToAppend: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf-8');
  } catch { /* new file */ }
  if (existing.includes(marker)) return;
  await fs.writeFile(filePath, existing + blockToAppend, 'utf-8');
}

/**
 * Persist a per-commit knowledge entry. Writes the MD + JSON pair under
 * `<localDir>/commits/YYYY-MM/{sha7}-{slug}.{md,json}` for the local repo
 * and the same shape under `~/.agent-history/knowledge/<repoName>/commits/`
 * for cross-repo MCP queries. Also appends one line to CHANGELOG.md
 * (deduplicated by sha marker).
 *
 * Files are written FRESH (overwritten) per run — re-running learn for the
 * same commit replaces both the MD and JSON. CHANGELOG is append-only.
 */
export async function storeKnowledge(
  entry: KnowledgeEntry,
  options: { localDir: string | null },
): Promise<StoreResult> {
  const month = monthKey(new Date(entry.extractedAt));
  const slug = slugFromSubject(entry.subject);
  const sha7 = entry.sha.slice(0, 7);
  const baseName = `${sha7}-${slug}`;

  const md = renderMarkdown(entry);
  const json = JSON.stringify(entry, null, 2) + '\n';

  // Global mirror (cross-repo MCP source).
  const globalRoot = path.join(CONFIG_DIR, 'knowledge', entry.repoName);
  const globalMdPath = path.join(globalRoot, 'commits', month, `${baseName}.md`);
  const globalJsonPath = path.join(globalRoot, 'commits', month, `${baseName}.json`);
  await writeFileFresh(globalMdPath, md);
  await writeFileFresh(globalJsonPath, json);
  const globalChangelogPath = path.join(globalRoot, 'CHANGELOG.md');
  const globalRel = path.posix.join('commits', month, `${baseName}.md`);
  await appendIfNew(
    globalChangelogPath,
    `\`${entry.sha.slice(0, 7)}\``,
    renderChangelogEntry(entry, globalRel),
  );

  // Local mirror (lives next to the repo, gets committed by the user).
  let localMdPath: string | null = null;
  let localJsonPath: string | null = null;
  let changelogPath: string | null = null;

  if (options.localDir) {
    localMdPath = path.join(options.localDir, 'commits', month, `${baseName}.md`);
    localJsonPath = path.join(options.localDir, 'commits', month, `${baseName}.json`);
    await writeFileFresh(localMdPath, md);
    await writeFileFresh(localJsonPath, json);
    changelogPath = path.join(options.localDir, 'CHANGELOG.md');
    const localRel = path.posix.join('commits', month, `${baseName}.md`);
    await appendIfNew(
      changelogPath,
      `\`${entry.sha.slice(0, 7)}\``,
      renderChangelogEntry(entry, localRel),
    );
  }

  return { localMdPath, localJsonPath, globalMdPath, globalJsonPath, changelogPath };
}

export function globalKnowledgeDir(): string {
  return path.join(CONFIG_DIR, 'knowledge');
}
