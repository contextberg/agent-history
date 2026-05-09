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

interface DateParts {
  month: string;   // "2026-05"
  day: string;     // "10"
}

/** Use the commit's authored time when available — it's what the user thinks
 *  in terms of ("the bug I fixed yesterday"). Falls back to extraction time. */
function dateParts(authoredAt: string, extractedAt: string): DateParts {
  const date = new Date(authoredAt || extractedAt);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return { month: `${yyyy}-${mm}`, day: dd };
}

/**
 * Short, scannable slug from a commit subject.
 *
 * Strategy:
 *   1. Slugify (lowercase, dashes for non-word chars).
 *   2. Greedy-take whole tokens until the total would exceed MAX chars.
 *   3. Drop trailing single-char / two-char "fluff" tokens (a, to, of, an, in)
 *      so we end on a real word.
 *
 * Without step 3, "fix(setup): allow replacing a stored API key" truncates
 * to "fix-setup-allow-replacing-a", which reads worse than dropping the "a".
 */
function slugFromSubject(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'commit';
  const MAX = 32;
  if (slug.length <= MAX) return slug;

  const tokens = slug.split('-');
  let acc = '';
  for (const tok of tokens) {
    const next = acc ? `${acc}-${tok}` : tok;
    if (next.length > MAX) break;
    acc = next;
  }
  if (!acc) acc = tokens[0]!.slice(0, MAX);  // first token alone exceeds MAX

  // Trim trailing low-info short tokens.
  while (acc.includes('-')) {
    const lastDash = acc.lastIndexOf('-');
    const tail = acc.slice(lastDash + 1);
    if (tail.length < 3) acc = acc.slice(0, lastDash);
    else break;
  }
  return acc || 'commit';
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
 * Resolve the basename for this commit's md/json, disambiguating against
 * existing files in the same day-folder.
 *
 *   - No file at `{slug}.md` exists → use `{slug}`
 *   - File exists AND its frontmatter sha matches this entry → reuse `{slug}`
 *     (re-running learn for the same commit overwrites idempotently)
 *   - File exists for a DIFFERENT sha → append a 4-char sha suffix so the
 *     new commit doesn't clobber the old note
 */
async function resolveBaseName(dayDir: string, slug: string, sha: string): Promise<string> {
  const candidate = path.join(dayDir, `${slug}.md`);
  try {
    const existing = await fs.readFile(candidate, 'utf-8');
    if (existing.includes(`sha: ${sha}`)) return slug;
    return `${slug}-${sha.slice(0, 4)}`;
  } catch {
    return slug;
  }
}

/**
 * Persist a per-commit knowledge entry. Layout (both local and global mirror):
 *
 *   <root>/
 *     CHANGELOG.md                               ← timeline, one line per commit
 *     YYYY-MM/
 *       DD/
 *         {slug}.md                              ← human-readable
 *         .data/
 *           {slug}.json                          ← machine-readable sidecar
 *
 * The day folder already provides the time scope, so the filename is just
 * the slug — no HH-MM noise. Same-day collisions for a *different* commit
 * get a 4-char sha suffix; same-commit re-runs overwrite (idempotent).
 * The .data/ subdir hides the JSON from default `ls` output.
 */
export async function storeKnowledge(
  entry: KnowledgeEntry,
  options: { localDir: string | null },
): Promise<StoreResult> {
  const { month, day } = dateParts(entry.authoredAt, entry.extractedAt);
  const slug = slugFromSubject(entry.subject);

  const md = renderMarkdown(entry);
  const json = JSON.stringify(entry, null, 2) + '\n';

  const writeBundle = async (root: string): Promise<{ md: string; json: string; changelog: string }> => {
    const dayDir = path.join(root, month, day);
    const baseName = await resolveBaseName(dayDir, slug, entry.sha);
    const mdPath = path.join(dayDir, `${baseName}.md`);
    const jsonPath = path.join(dayDir, '.data', `${baseName}.json`);
    await writeFileFresh(mdPath, md);
    await writeFileFresh(jsonPath, json);
    const changelogPath = path.join(root, 'CHANGELOG.md');
    const rel = path.posix.join(month, day, `${baseName}.md`);
    await appendIfNew(
      changelogPath,
      `\`${entry.sha.slice(0, 7)}\``,
      renderChangelogEntry(entry, rel),
    );
    return { md: mdPath, json: jsonPath, changelog: changelogPath };
  };

  // Global mirror (cross-repo MCP source).
  const globalRoot = path.join(CONFIG_DIR, 'knowledge', entry.repoName);
  const globalBundle = await writeBundle(globalRoot);

  // Local mirror (lives next to the repo, gets committed by the user).
  let localMdPath: string | null = null;
  let localJsonPath: string | null = null;
  let changelogPath: string | null = null;
  if (options.localDir) {
    const localBundle = await writeBundle(options.localDir);
    localMdPath = localBundle.md;
    localJsonPath = localBundle.json;
    changelogPath = localBundle.changelog;
  }

  return {
    localMdPath,
    localJsonPath,
    globalMdPath: globalBundle.md,
    globalJsonPath: globalBundle.json,
    changelogPath,
  };
}

export function globalKnowledgeDir(): string {
  return path.join(CONFIG_DIR, 'knowledge');
}
