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
          <KnowledgeEmptyState commit={commit} />
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

function KnowledgeEmptyState({ commit }: { commit: CommitWithLinks }) {
  const run = commit.learnRun;
  if (run?.status === 'no-auth') {
    const provider = run.provider ? ` for ${run.provider}` : '';
    return (
      <div style={noticeStyle}>
        <p style={noticeTitleStyle}>Knowledge extraction needs credentials{provider}.</p>
        <p style={emptyHintStyle}>
          Run <code style={inlineCodeStyle}>contextberg setup</code> to save credentials, then run{' '}
          <code style={inlineCodeStyle}>contextberg learn --commit {commit.sha.slice(0, 7)}</code> to backfill this commit.
        </p>
      </div>
    );
  }

  if (run?.status === 'error') {
    return (
      <div style={noticeStyle}>
        <p style={noticeTitleStyle}>Knowledge extraction failed.</p>
        <p style={emptyHintStyle}>
          {run.reason ?? 'Check contextberg status for details.'} Run{' '}
          <code style={inlineCodeStyle}>contextberg learn --commit {commit.sha.slice(0, 7)} --verbose</code> to retry.
        </p>
      </div>
    );
  }

  if (run?.status === 'no-sessions') {
    return (
      <p style={emptyHintStyle}>
        No knowledge note was created because no linked session transcript could be used for extraction.
      </p>
    );
  }

  if (run?.status === 'skip' || run?.status === 'empty') {
    return (
      <p style={emptyHintStyle}>
        No knowledge note was created for this commit{run.reason ? `: ${run.reason}` : '.'}
      </p>
    );
  }

  return (
    <p style={emptyHintStyle}>
      No knowledge note yet. Background extraction will run on the next commit
      in this repo, or run <code style={inlineCodeStyle}>contextberg learn --commit {commit.sha.slice(0, 7)}</code> to backfill.
    </p>
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

const noticeStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: 8,
  border: '1px solid var(--border-main)',
  backgroundColor: 'var(--bg-card)',
};

const noticeTitleStyle: React.CSSProperties = {
  margin: '0 0 6px',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--text-primary)',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2
        style={{
          margin: '0 0 10px',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
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
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.05em',
          color: accent ? 'var(--accent)' : 'var(--text-tertiary)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {links.map((l) => {
          // Try to hydrate to a full session for click-through; if the session
          // isn't in the loaded list, the row is still informative — it just
          // can't navigate to a transcript.
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
        className="focus-ring"
        style={{
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          padding: '10px 12px',
          borderRadius: 8,
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-main)',
          cursor: onSelect ? 'pointer' : 'default',
          fontFamily: 'inherit',
          color: 'inherit',
          opacity: onSelect ? 1 : 0.85,
        }}
        title={onSelect ? undefined : 'Session not loaded — increase maxSessions to view transcript'}
      >
        <span style={{ marginTop: 2, flexShrink: 0 }}>
          <SourceIcon source={s.source} size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
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
              {s.project}
            </span>
            <span
              style={{
                flexShrink: 0,
                fontSize: 11,
                fontWeight: 600,
                color: accent ? 'var(--accent)' : 'var(--text-tertiary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {score.toFixed(2)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                color: sourceHex(s.source),
              }}
            >
              {sourceLabel(s.source)}
            </span>
            <span style={{ width: 2, height: 2, borderRadius: 999, backgroundColor: 'var(--text-quaternary)' }} />
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{link.reason}</span>
          </div>
        </div>
      </button>
    </li>
  );
}
