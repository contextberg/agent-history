import React from 'react';
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

export function CommitList({ commits, sessionCount, selectedSha, onSelect }: Props) {
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
}

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
      {/* Sticky repo header — stays anchored at the top of the scroll viewport
          while you read through this repo's commits, so you always know which
          repo you're in even after scrolling several screens. */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          width: '100%',
          backgroundColor: 'var(--bg-panel)',
          padding: firstSection ? '12px 14px 8px' : '14px 14px 8px',
          marginTop: firstSection ? 0 : 4,
          borderTop: firstSection ? 'none' : '1px solid var(--border-main)',
          borderRight: 'none',
          borderBottom: 'none',
          borderLeft: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
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
          style={{
            color: 'var(--text-tertiary)',
            flexShrink: 0,
            transform: collapsed ? 'none' : 'rotate(90deg)',
            transition: 'transform 120ms',
          }}
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
          style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}
          aria-hidden
        >
          {/* git-branch glyph: communicates "repo" without needing a label */}
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {repoName(repo)}
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--text-tertiary)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {commits.length} {commits.length === 1 ? 'commit' : 'commits'}
        </span>
      </button>
      {!collapsed && (
        <ul
          style={{
            listStyle: 'none',
            padding: '0 8px 8px',
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
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
        className="focus-ring"
        style={{
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          padding: '10px 10px',
          borderRadius: 8,
          backgroundColor: active ? 'var(--bg-card-selected)' : 'transparent',
          border: `1px solid ${active ? 'var(--border-card-selected)' : 'transparent'}`,
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: 'inherit',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c.subject || '(no subject)'}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {relTime(c.time)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
            <span
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: 10.5,
                color: 'var(--text-tertiary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {c.sha.slice(0, 7)}
            </span>
            <span style={{ width: 2, height: 2, borderRadius: 999, backgroundColor: 'var(--text-quaternary)' }} />
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
