import React, { useState } from 'react';
import type { AgentSession, AssistantItem, ToolCall } from '../types';
import type { TranscriptStyle, ToolStyle, Density } from '../hooks/useViewSettings';
import { sourceLabel, sourceHex } from '../utils/source';
import { CopyButton } from './CopyButton';
import { SourceIcon } from './SourceIcon';
import { buildMarkdown } from '../utils/copy';

interface Props {
  session: AgentSession;
  showToolCalls?: boolean;
  showToolOutputs?: boolean;
  transcriptStyle?: TranscriptStyle;
  toolStyle?: ToolStyle;
  density?: Density;
}

const ShowToolOutputsContext = React.createContext(false);

/* ── Helpers ── */

function getPreview(call: ToolCall): string | null {
  const i = call.input;
  const path = (i['file_path'] ?? i['path']) as string | undefined;
  if (path) return shorten(path);
  if (typeof i['command'] === 'string') return shorten(i['command']);
  if (typeof i['pattern'] === 'string') return i['pattern'];
  if (typeof i['url'] === 'string') return i['url'];
  if (typeof i['prompt'] === 'string') return shorten(i['prompt']);
  const first = Object.values(i)[0];
  return typeof first === 'string' ? shorten(first) : null;
}

function shorten(s: string, max = 80): string {
  return s.length <= max ? s : '…' + s.slice(-max);
}

const TOOL_ICONS: Record<string, string> = {
  read_file: '◧',
  write_file: '✎',
  str_replace: '⇄',
  grep: '⌕',
  run_terminal: '$',
  questions_v2: '?',
};

const TOOL_VERBS: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  str_replace: 'Edit',
  grep: 'Search',
  run_terminal: 'Run',
  questions_v2: 'Ask',
};

/* ── Tool call variants ── */

function ToolOutput({ output }: { output: string }) {
  return (
    <div style={{ marginTop: 8, borderTop: '1px dashed var(--border-subtle)', paddingTop: 8 }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 4 }}>
        Output
      </div>
      <pre className="font-mono" style={{ margin: 0, fontSize: 10.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 280, overflow: 'auto' }}>
        {output}
      </pre>
    </div>
  );
}

function ToolCallCollapse({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const preview = getPreview(call);
  const showOutput = React.useContext(ShowToolOutputsContext);
  return (
    <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-main)', background: 'var(--bg-card)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 500, width: 18, height: 18, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-inset)', color: 'var(--text-secondary)', flexShrink: 0 }}>
          {TOOL_ICONS[call.name] || '·'}
        </span>
        <span className="font-mono" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>
          {call.name}
        </span>
        {preview && (
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview}
          </span>
        )}
        <svg
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          style={{ color: 'var(--text-tertiary)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="fade-in" style={{ padding: '10px 14px', background: 'var(--bg-inset)', borderTop: '1px solid var(--border-subtle)' }}>
          <pre className="font-mono" style={{ margin: 0, fontSize: 10.5, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(call.input, null, 2)}
          </pre>
          {showOutput && call.output && <ToolOutput output={call.output} />}
        </div>
      )}
    </div>
  );
}

function ToolCallInline({ call }: { call: ToolCall }) {
  const preview = getPreview(call);
  return (
    <div className="font-mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 0' }}>
      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>›</span>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{call.name}</span>
      {preview && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>
          ({preview})
        </span>
      )}
    </div>
  );
}

function ToolCallGutter({ call }: { call: ToolCall }) {
  const preview = getPreview(call);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '4px 0' }}>
      <div style={{ flexShrink: 0, width: 72, textAlign: 'right', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
        {TOOL_VERBS[call.name] || 'Tool'}
      </div>
      <div style={{ flexShrink: 0, width: 1, alignSelf: 'stretch', background: 'var(--border-subtle)' }} />
      <div className="font-mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{call.name}</span>
        {preview && <span style={{ color: 'var(--text-tertiary)', marginLeft: 8 }}>{preview}</span>}
      </div>
    </div>
  );
}

import { Card, CardContent } from './ui/card';

function ToolCallCard({ call }: { call: ToolCall }) {
  const preview = getPreview(call);
  const path = (call.input['file_path'] ?? call.input['path']) as string | undefined;
  const showOutput = React.useContext(ShowToolOutputsContext);
  return (
    <Card className="overflow-hidden shadow-sm" style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-main)' }}>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}>
        <span className="text-[9.5px] font-bold tracking-[0.08em] uppercase px-1.5 py-0.5 rounded"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}
        >
          {TOOL_VERBS[call.name] || 'Tool'}
        </span>
        <span className="font-mono text-[11.5px] truncate" style={{ color: 'var(--text-secondary)' }}>
          {call.name}
        </span>
        {path && (
          <span className="font-mono text-[11px] ml-auto truncate" style={{ color: 'var(--text-tertiary)' }}>
            {path}
          </span>
        )}
      </div>
      <CardContent className="p-2" style={{ background: 'var(--bg-inset)' }}>
        <pre className="font-mono m-0 text-[11px] whitespace-pre-wrap break-all" style={{ color: 'var(--text-secondary)' }}>
          {preview || JSON.stringify(call.input)}
        </pre>
        {showOutput && call.output && <ToolOutput output={call.output} />}
      </CardContent>
    </Card>
  );
}

function ToolCallItem({ call, mode = 'collapse' }: { call: ToolCall; mode?: ToolStyle }) {
  if (mode === 'inline') return <ToolCallInline call={call} />;
  if (mode === 'gutter') return <ToolCallGutter call={call} />;
  if (mode === 'card') return <ToolCallCard call={call} />;
  return <ToolCallCollapse call={call} />;
}

function ToolCallGroup({ calls, mode }: { calls: ToolCall[]; mode: ToolStyle }) {
  const [open, setOpen] = useState(false);
  const count = calls.length;
  return (
    <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-main)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-card-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-card)')}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', textAlign: 'left', background: 'var(--bg-card)', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
      >
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 500, width: 18, height: 18, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-inset)', color: 'var(--text-secondary)', flexShrink: 0 }}>
          ⚙
        </span>
        <span className="font-mono" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>
          {count} tool call{count !== 1 ? 's' : ''}
        </span>
        <svg
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
          style={{ color: 'var(--text-tertiary)', marginLeft: 'auto', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="fade-in" style={{ padding: '8px', background: 'var(--bg-inset)', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {calls.map((call, i) => <ToolCallItem key={i} call={call} mode={mode} />)}
        </div>
      )}
    </div>
  );
}

/* ── Assistant content ── */

type ItemGroup =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; calls: ToolCall[] };

function groupItems(items: AssistantItem[]): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      groups.push({ kind: 'text', text: item.text });
    } else {
      const last = groups[groups.length - 1];
      if (last?.kind === 'tools') {
        last.calls.push(item.tool);
      } else {
        groups.push({ kind: 'tools', calls: [item.tool] });
      }
    }
  }
  return groups;
}

function AssistantItems({
  items, toolStyle, showToolCalls, prose, compact,
}: {
  items: AssistantItem[];
  toolStyle: ToolStyle;
  showToolCalls: boolean;
  prose?: boolean;
  compact?: boolean;
}) {
  const groups = groupItems(items);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 6 : 10 }}>
      {groups.map((g, i) =>
        g.kind === 'text' ? (
          <p key={i} style={{ margin: 0, fontSize: prose ? 14.5 : 13.5, lineHeight: prose ? 1.7 : 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {g.text}
          </p>
        ) : showToolCalls ? (
          <ToolCallGroup key={i} calls={g.calls} mode={toolStyle} />
        ) : null,
      )}
    </div>
  );
}

/* ── Header ── */

function SessionHeader({ session }: { session: AgentSession }) {
  const hex = sourceHex(session.source);
  const toolCount = session.turns.reduce(
    (n, t) => n + t.items.filter((i) => i.kind === 'tool').length,
    0,
  );

  return (
    <header className="flex items-center justify-between px-7 py-3 shrink-0 border-b" style={{ borderColor: 'var(--border-main)', backgroundColor: 'var(--bg-panel)' }}>
      <div className="flex flex-col gap-[3px] min-w-0">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide border"
            style={{ backgroundColor: hex + '18', color: hex, borderColor: hex + '30' }}
          >
            <SourceIcon source={session.source} size={12} />
            {sourceLabel(session.source)}
          </span>
          <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>/</span>
          <h2 className="m-0 text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {session.project}
          </h2>
        </div>
        <div className="font-mono text-[10.5px]" style={{ color: 'var(--text-tertiary)' }}>
          {new Date(session.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          <span className="mx-2">·</span>
          {session.turns.length} turns
          {toolCount > 0 && (
            <>
              <span className="mx-2">·</span>
              {toolCount} tool calls
            </>
          )}
        </div>
      </div>
      <div className="flex gap-1.5 shrink-0">
        <CopyButton label="Copy" getValue={() => buildMarkdown(session)} />
      </div>
    </header>
  );
}

/* ── Transcript: default log style ── */

function TranscriptDefault({ session, toolStyle, showToolCalls }: { session: AgentSession; toolStyle: ToolStyle; showToolCalls: boolean }) {
  const hex = sourceHex(session.source);
  return (
    <div className="conversation-shell mx-auto py-7 px-7 pb-[60px]">
      {session.turns.map((turn, i) => (
        <div key={i}>
          {i > 0 && <div className="h-px my-7" style={{ backgroundColor: 'var(--border-subtle)' }} />}

          {/* User */}
          <div className="mb-4">
            <div className="flex items-center gap-2.5 mb-2">
              <span className="text-[10px] font-bold tracking-[0.12em] uppercase shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                You
              </span>
              <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />
            </div>
            <div className="px-4 py-3 rounded-[10px] border" style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}>
              <p className="font-mono m-0 text-[13px] leading-relaxed" style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {turn.userMessage}
              </p>
            </div>
          </div>

          {/* Assistant */}
          {turn.assistantSummary && (
            <div>
              <div className="flex items-center gap-2.5 mb-2.5">
                <span className="text-[10px] font-bold tracking-[0.12em] uppercase shrink-0" style={{ color: hex }}>
                  {sourceLabel(session.source)}
                </span>
                <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-subtle)' }} />
              </div>
              <AssistantItems items={turn.items ?? []} toolStyle={toolStyle} showToolCalls={showToolCalls} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Transcript: chat bubbles ── */

function TranscriptChat({ session, toolStyle, showToolCalls, density }: { session: AgentSession; toolStyle: ToolStyle; showToolCalls: boolean; density: Density }) {
  const hex = sourceHex(session.source);
  const gap = density === 'compact' ? 16 : density === 'comfortable' ? 32 : 24;

  return (
    <div className="conversation-shell mx-auto py-7 px-7 pb-[60px]">
      {session.turns.map((turn, i) => (
        <div key={i} style={{ marginBottom: gap }}>
          {/* User bubble */}
          <div className="flex justify-end mb-3.5">
            <div className="max-w-[82%] px-4 py-3 text-[13.5px] leading-relaxed border whitespace-pre-wrap break-words"
              style={{
                borderRadius: '14px 14px 5px 14px',
                backgroundColor: 'var(--accent-tint)',
                color: 'var(--text-primary)',
                borderColor: 'var(--accent-soft)',
              }}
            >
              {turn.userMessage}
            </div>
          </div>

          {/* Assistant */}
          {turn.assistantSummary && (
            <div className="flex gap-2.5">
              <div className="w-[26px] h-[26px] rounded-md shrink-0 flex items-center justify-center border"
                style={{
                  backgroundColor: hex + '18',
                  borderColor: hex + '30',
                }}
              >
                <SourceIcon source={session.source} size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5 mb-2">
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {sourceLabel(session.source)}
                  </span>
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-tertiary)' }}>
                    turn {i + 1}
                  </span>
                </div>
                <div className="px-4 py-3.5 border"
                  style={{
                    borderRadius: '5px 14px 14px 14px',
                    backgroundColor: 'var(--bg-panel)',
                    borderColor: 'var(--border-subtle)',
                    boxShadow: 'var(--shadow-message)',
                  }}
                >
                  <AssistantItems items={turn.items ?? []} toolStyle={toolStyle} showToolCalls={showToolCalls} />
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Transcript: document prose ── */

function TranscriptDocument({ session, toolStyle, showToolCalls }: { session: AgentSession; toolStyle: ToolStyle; showToolCalls: boolean }) {
  return (
    <div className="conversation-shell mx-auto py-9 px-7 pb-20">
      <div className="mb-8">
        <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em] leading-tight" style={{ color: 'var(--text-primary)' }}>
          {session.project}
        </h1>
        <p className="mt-1.5 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
          {session.turns.length} {session.turns.length === 1 ? 'exchange' : 'exchanges'} with {sourceLabel(session.source)}.
        </p>
      </div>
      {session.turns.map((turn, i) => (
        <section key={i} className="mb-9">
          <h2 className="flex items-center gap-2.5 m-0 mb-2.5 text-[11px] font-bold tracking-[0.12em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
            <span className="tabular-nums">§ {String(i + 1).padStart(2, '0')}</span>
            <span className="flex-1 h-px" style={{ background: 'var(--border-subtle)' }} />
          </h2>
          <blockquote className="m-0 pl-3.5 py-0 border-l-2 italic text-sm leading-relaxed whitespace-pre-wrap"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            {turn.userMessage}
          </blockquote>
          <div className="mt-3.5">
            <AssistantItems items={turn.items ?? []} toolStyle={toolStyle} showToolCalls={showToolCalls} prose />
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── Main export ── */

export function SessionView({
  session,
  showToolCalls = true,
  showToolOutputs = false,
  transcriptStyle = 'transcript',
  toolStyle = 'collapse',
  density = 'cozy',
}: Props) {
  return (
    <ShowToolOutputsContext.Provider value={showToolOutputs}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <SessionHeader session={session} />
        <div className="transcript-scroll" style={{ flex: 1, overflowY: 'auto' }}>
          {transcriptStyle === 'chat' && (
            <TranscriptChat session={session} toolStyle={toolStyle} showToolCalls={showToolCalls} density={density} />
          )}
          {transcriptStyle === 'document' && (
            <TranscriptDocument session={session} toolStyle={toolStyle} showToolCalls={showToolCalls} />
          )}
          {transcriptStyle === 'transcript' && (
            <TranscriptDefault session={session} toolStyle={toolStyle} showToolCalls={showToolCalls} />
          )}
        </div>
      </div>
    </ShowToolOutputsContext.Provider>
  );
}
