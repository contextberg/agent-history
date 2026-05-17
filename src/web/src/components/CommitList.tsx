import React, { memo } from 'react';
import type { CommitWithLinks } from '../types';

interface Props {
  commits: CommitWithLinks[];
  /** Total session count loaded — used to disambiguate the empty state. */
  sessionCount: number;
  selectedSha: string | undefined;
  onSelect: (commit: CommitWithLinks) => void;
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function repoName(repo: string): string {
  const parts = repo.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || repo;
}

/** Strong link threshold for the confidence dot. Mirrors DEFAULT_LINK_THRESHOLD on the server side, just stricter. */
const STRONG_THRESHOLD = 0.7;

export const CommitList = memo(function CommitList({ commits, sessionCount, selectedSha, onSelect }: Props) {
  // Group by repo (preserve commit order: time descending across the whole list).
  const byRepo = new Map<string, CommitWithLinks[]>();
  for (const c of commits) {
    let arr = byRepo.get(c.repo);
    if (!arr) { arr = []; byRepo.set(c.repo, arr); }
    arr.push(c);
  }
  // Sort repos by their most-recent commit.
  const repos = [...byRepo.entries()].sort(
    (a, b) => Date.parse(b[1][0]!.time) - Date.parse(a[1][0]!.time),
  );

  if (commits.length === 0) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12, lineHeight: 1.6 }}>
        {sessionCount === 0 ? (
          <>No sessions loaded yet — switch back to "By time" to confirm sources are connected.</>
        ) : (
          <>
            No commits resolved from these {sessionCount} sessions.
            <br />
            <span style={{ fontSize: 11, color: 'var(--text-quaternary)' }}>
              The dev server may have bound to a non-default port —
              restart <code>npm run dev:web</code> after the API is up so the proxy picks up the new port.
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '0 0 8px' }}>
      {repos.map(([repo, list], i) => (
        <RepoSection
          key={repo}
          repo={repo}
          commits={list}
          firstSection={i === 0}
          selectedSha={selectedSha}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
});

function RepoSection({
  repo,
  commits,
  firstSection,
  selectedSha,
  onSelect,
}: {
  repo: string;
  commits: CommitWithLinks[];
  firstSection: boolean;
  selectedSha: string | undefined;
  onSelect: (commit: CommitWithLinks) => void;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <section>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="sticky top-0 z-[5] w-full flex items-center gap-2 bg-[var(--bg-panel)] shrink-0 cursor-pointer text-left border-none"
        style={{
          padding: firstSection ? '12px 14px 8px' : '14px 14px 8px',
          marginTop: firstSection ? 0 : 4,
          borderTop: firstSection ? 'none' : '1px solid var(--border-main)',
        }}
        title={repo}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 transition-transform duration-100 text-[var(--text-tertiary)]"
          style={{ transform: collapsed ? 'none' : 'rotate(90deg)' }}
          aria-hidden
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-[var(--text-tertiary)]"
          aria-hidden
        >
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="text-[12.5px] font-bold tracking-tight truncate flex-1 min-w-0" style={{ color: 'var(--text-primary)' }}>
          {repoName(repo)}
        </span>
        <span className="text-[10.5px] font-medium shrink-0 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
          {commits.length} {commits.length === 1 ? 'commit' : 'commits'}
        </span>
      </button>
      {!collapsed && (
        <ul className="flex flex-col gap-px px-2 pb-2">
          {commits.map((c) => (
            <CommitRow
              key={c.sha}
              c={c}
              active={selectedSha === c.sha}
              onSelect={() => onSelect(c)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommitRow({ c, active, onSelect }: { c: CommitWithLinks; active: boolean; onSelect: () => void }) {
  const strongCount = c.links.filter((l) => l.score >= STRONG_THRESHOLD).length;
  const totalLinks = c.links.length;

  return (
    <li>
      <button
        onClick={onSelect}
        className="focus-ring w-full text-left flex gap-2.5 items-start py-2.5 px-2.5 rounded-lg cursor-pointer"
        style={{
          fontFamily: 'inherit',
          color: 'inherit',
          backgroundColor: active ? 'var(--bg-card-selected)' : 'transparent',
          border: `1px solid ${active ? 'var(--border-card-selected)' : 'transparent'}`,
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-1.5">
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {c.subject || '(no subject)'}
            </span>
            <span className="text-[10.5px] shrink-0 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {relTime(c.time)}
            </span>
          </div>
          <div className="flex items-center gap-[7px] mt-1">
            <span className="font-mono text-[10.5px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {c.sha.slice(0, 7)}
            </span>
            <span className="w-0.5 h-0.5 rounded-full" style={{ backgroundColor: 'var(--text-quaternary)' }} />
            <LinkBadge strong={strongCount} total={totalLinks} />
          </div>
        </div>
      </button>
    </li>
  );
}

function LinkBadge({ strong, total }: { strong: number; total: number }) {
  if (total === 0) {
    return (
      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>no linked sessions</span>
    );
  }
  // Strong matches: highlight in accent. Weaker links shown in muted form.
  const label = strong > 0
    ? `${strong} strong${total > strong ? ` · ${total - strong} weak` : ''}`
    : `${total} weak`;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10.5,
        color: strong > 0 ? 'var(--accent)' : 'var(--text-tertiary)',
        fontWeight: strong > 0 ? 600 : 500,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          backgroundColor: strong > 0 ? 'var(--accent)' : 'var(--text-quaternary)',
        }}
      />
      {label}
    </span>
  );
}
