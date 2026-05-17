import React from 'react';
import type { AgentSession, CommitKnowledge, CommitLink, CommitWithLinks } from '../types';
import { sourceLabel, sourceHex } from '../utils/source';
import { SourceIcon } from './SourceIcon';
import { fetchCommitKnowledge, fetchSession } from '../api';
import { renderKnowledgeMarkdown } from '../utils/markdown';

interface Props {
  commit: CommitWithLinks;
  /** All currently-loaded sessions. Used to hydrate a clicked link into a
   *  full AgentSession when possible (so SessionView can show the transcript).
   *  Sessions outside this array are still shown — clicking them is a no-op. */
  sessions: AgentSession[];
  onSelectSession: (s: AgentSession) => void;
}

const STRONG_THRESHOLD = 0.7;
const WEAK_THRESHOLD = 0.45;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fileTail(absPath: string, repo: string): string {
  // Show the path relative to the repo when possible — matches how a developer
  // mentally locates the file. Comparison is case-insensitive on Windows.
  const a = absPath.replace(/\\/g, '/').toLowerCase();
  const r = repo.replace(/\\/g, '/').toLowerCase();
  if (a.startsWith(r + '/')) return absPath.replace(/\\/g, '/').slice(r.length + 1);
  return absPath.replace(/\\/g, '/');
}

function tier(score: number): 'strong' | 'weak' | 'noise' {
  if (score >= STRONG_THRESHOLD) return 'strong';
  if (score >= WEAK_THRESHOLD) return 'weak';
  return 'noise';
}

export function CommitView({ commit, sessions, onSelectSession }: Props) {
  const sessionById = React.useMemo(() => {
    const m = new Map<string, AgentSession>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const grouped = React.useMemo(() => {
    const strong: CommitLink[] = [];
    const weak: CommitLink[] = [];
    for (const l of commit.links) {
      const t = tier(l.score);
      if (t === 'strong') strong.push(l);
      else if (t === 'weak') weak.push(l);
    }
    return { strong, weak };
  }, [commit.links]);

  // Knowledge note for this commit (the markdown body produced by `runLearn`).
  // We refetch on commit change AND when the SSE feed reports a learn-completed
  // event for this exact sha — that's how the in-process watcher finishing a
  // background extraction propagates to the UI without a manual reload.
  const [knowledge, setKnowledge] = React.useState<CommitKnowledge | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = React.useState(false);
  const [refetchTick, setRefetchTick] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    setKnowledgeLoading(true);
    fetchCommitKnowledge(commit.repo, commit.sha)
      .then((data) => { if (!cancelled) setKnowledge(data); })
      .catch(() => { if (!cancelled) setKnowledge(null); })
      .finally(() => { if (!cancelled) setKnowledgeLoading(false); });
    return () => { cancelled = true; };
  }, [commit.repo, commit.sha, refetchTick]);

  React.useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('learn-completed', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as { repo?: string; result?: { sha?: string; status?: string } };
        if (payload.result?.sha === commit.sha && payload.result?.status === 'ok') {
          setRefetchTick((t) => t + 1);
        }
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [commit.sha]);

  return (
    <div
      className="overflow-y-auto"
      style={{ height: '100%', padding: '24px 28px 64px', maxWidth: 880, margin: '0 auto' }}
    >
      {/* Header */}
      <header style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}
          >
            commit
          </span>
          <span
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: 11.5,
              color: 'var(--text-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {commit.sha.slice(0, 12)}
          </span>
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.015em',
            color: 'var(--text-primary)',
            wordBreak: 'break-word',
          }}
        >
          {commit.subject || '(no subject)'}
        </h1>
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span>{commit.authorName}</span>
          <span style={{ color: 'var(--text-quaternary)' }}>·</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTime(commit.time)}</span>
          <span style={{ color: 'var(--text-quaternary)' }}>·</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={commit.repo}>
            {commit.repo}
          </span>
        </div>
      </header>

      {/* Knowledge note (the LLM-produced summary) */}
      <Section title="Knowledge">
        {knowledgeLoading && !knowledge ? (
          <p style={emptyHintStyle}>Loading…</p>
        ) : knowledge ? (
          <div>
            <div style={knowledgeMetaStyle}>
              <span>{knowledge.provider} / {knowledge.model}</span>
              <span style={{ color: 'var(--text-quaternary)' }}>·</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                extracted {fmtTime(knowledge.extractedAt)}
              </span>
              <span style={{ color: 'var(--text-quaternary)' }}>·</span>
              <span>{knowledge.sessions.length} session{knowledge.sessions.length === 1 ? '' : 's'}</span>
            </div>
            <div style={knowledgeBodyStyle}>
              {renderKnowledgeMarkdown(knowledge.body)}
            </div>
          </div>
        ) : (
          <p style={emptyHintStyle}>
            No knowledge note yet. Background extraction will run on the next commit
            in this repo, or run <code style={inlineCodeStyle}>contextberg learn --commit {commit.sha.slice(0, 7)}</code> to backfill.
          </p>
        )}
      </Section>

      {/* Linked sessions */}
      <Section title={`Linked sessions (${commit.links.length})`}>
        {grouped.strong.length === 0 && grouped.weak.length === 0 && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>
            No sessions match this commit's time window or files.
          </p>
        )}
        {grouped.strong.length > 0 && (
          <LinkGroup
            label="Strong matches"
            links={grouped.strong}
            sessionById={sessionById}
            onSelect={onSelectSession}
            accent
          />
        )}
        {grouped.weak.length > 0 && (
          <LinkGroup
            label="Weaker candidates"
            links={grouped.weak}
            sessionById={sessionById}
            onSelect={onSelectSession}
          />
        )}
      </Section>

      {/* Files */}
      <Section title={`Files (${commit.files.length})`}>
        {commit.files.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>No files recorded.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {commit.files.slice(0, 50).map((f) => (
              <li
                key={f}
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  fontSize: 11.5,
                  color: 'var(--text-secondary)',
                  padding: '3px 0',
                  wordBreak: 'break-all',
                }}
              >
                {fileTail(f, commit.repo)}
              </li>
            ))}
            {commit.files.length > 50 && (
              <li style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                + {commit.files.length - 50} more
              </li>
            )}
          </ul>
        )}
      </Section>
    </div>
  );
}

const emptyHintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--text-tertiary)',
  lineHeight: 1.55,
};

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: 11.5,
  padding: '1px 5px',
  borderRadius: 4,
  backgroundColor: 'var(--bg-inset)',
  color: 'var(--text-primary)',
};

const knowledgeMetaStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
  marginBottom: 12,
  fontSize: 11,
  color: 'var(--text-tertiary)',
};

const knowledgeBodyStyle: React.CSSProperties = {
  padding: '14px 18px',
  borderRadius: 10,
  border: '1px solid var(--border-main)',
  backgroundColor: 'var(--bg-card)',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.08em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function LinkGroup({
  label,
  links,
  sessionById,
  onSelect,
  accent,
}: {
  label: string;
  links: CommitLink[];
  sessionById: Map<string, AgentSession>;
  onSelect: (s: AgentSession) => void;
  accent?: boolean;
}) {
  return (
    <div className="mb-3.5">
      <div className="text-[10px] font-semibold tracking-wide mb-1.5" style={{ color: accent ? 'var(--accent)' : 'var(--text-tertiary)' }}>
        {label}
      </div>
      <ul className="flex flex-col gap-1.5">
        {links.map((l) => {
          const full = sessionById.get(l.session.id);
          return (
            <LinkRow
              key={l.session.id}
              link={l}
              onSelect={async () => {
                if (full) {
                  onSelect(full);
                  return;
                }
                try {
                  onSelect(await fetchSession(l.session.id));
                } catch (err) {
                  console.error('Failed to fetch linked session:', err);
                }
              }}
            />
          );
        })}
      </ul>
    </div>
  );
}

function LinkRow({
  link,
  onSelect,
}: {
  link: CommitLink;
  onSelect: () => void | Promise<void>;
}) {
  const score = link.score;
  const accent = score >= STRONG_THRESHOLD;
  const s = link.session;
  return (
    <li>
      <button
        onClick={onSelect}
        className="focus-ring w-full text-left flex gap-2.5 items-start py-2.5 px-3 rounded-lg cursor-pointer"
        style={{
          fontFamily: 'inherit',
          color: 'inherit',
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-main)',
          cursor: onSelect ? 'pointer' : 'default',
          opacity: onSelect ? 1 : 0.85,
        }}
        title={onSelect ? undefined : 'Session not loaded — increase maxSessions to view transcript'}
      >
        <span className="mt-0.5 shrink-0">
          <SourceIcon source={s.source} size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {s.project}
            </span>
            <span className="shrink-0 text-[11px] font-semibold tabular-nums" style={{ color: accent ? 'var(--accent)' : 'var(--text-tertiary)' }}>
              {score.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-[7px] mt-[3px]">
            <span className="text-[9.5px] font-bold tracking-[0.07em] uppercase" style={{ color: sourceHex(s.source) }}>
              {sourceLabel(s.source)}
            </span>
            <span className="w-0.5 h-0.5 rounded-full" style={{ backgroundColor: 'var(--text-quaternary)' }} />
            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{link.reason}</span>
          </div>
        </div>
      </button>
    </li>
  );
}
