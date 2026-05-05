import { useState } from 'react';
import type { AgentSession, AssistantItem, ToolCall } from '../types';
import { sourceLabel } from '../utils/source';
import { CopyButton } from './CopyButton';
import { buildMarkdown, buildContext, buildRaw } from '../utils/copy';

interface Props {
  session: AgentSession;
  showToolCalls?: boolean;
}

/** Renders assistant items in the order they occurred (text blocks interleaved with tool calls). */
function AssistantContent({ items, showToolCalls }: { items: AssistantItem[]; showToolCalls: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) =>
        item.kind === 'text' ? (
          <p key={i} className="text-[13px] leading-relaxed font-mono whitespace-pre-wrap break-words">
            {item.text}
          </p>
        ) : showToolCalls ? (
          <ToolCallItem key={i} call={item.tool} />
        ) : null,
      )}
    </div>
  );
}

function ToolCallItem({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const preview = getPreview(call);

  return (
    <div className="rounded-lg border border-emerald-400/40 bg-emerald-500/15 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-emerald-400/20 transition-colors"
      >
        <svg className="w-3.5 h-3.5 text-emerald-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
        <span className="text-[12px] font-bold text-emerald-200 tracking-wide">{call.name}</span>
        {preview && (
          <span className="text-[11px] text-emerald-400 truncate flex-1 font-mono">{preview}</span>
        )}
        <svg
          className={`w-3.5 h-3.5 text-emerald-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-emerald-400/20 px-3 py-2 bg-emerald-950/40">
          <pre className="text-[11px] font-mono text-emerald-200 whitespace-pre-wrap break-all">
            {JSON.stringify(call.input, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/** ツール種別ごとに最も重要な入力値を1行プレビューする */
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

function shorten(s: string, max = 60): string {
  return s.length <= max ? s : '…' + s.slice(-max);
}

const SOURCE_BADGE = {
  'claude-code': { bg: 'rgba(234, 88, 12, 0.12)', color: '#C2410C', dot: '#EA580C', glow: '0 0 8px #ea580c' },
  cursor:        { bg: 'rgba(37, 99, 235, 0.12)', color: '#1D4ED8', dot: '#2563EB', glow: '0 0 8px #2563eb' },
  openclaw:      { bg: 'rgba(5, 150, 105, 0.12)', color: '#047857', dot: '#059669', glow: '0 0 8px #059669' },
} as const;

export function SessionView({ session, showToolCalls = true }: Props) {
  const badge = SOURCE_BADGE[session.source];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header
        className="flex items-center justify-between px-8 py-5 shrink-0 relative z-20"
        style={{
          borderBottom: '1px solid var(--border-main)',
          backgroundColor: 'var(--bg-panel)',
          boxShadow: 'var(--shadow-panel)',
        }}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <span
              className="text-[11px] font-bold tracking-wider uppercase px-2 py-0.5 rounded flex items-center gap-1.5"
              style={{
                backgroundColor: badge.bg,
                color: badge.color,
                border: `1px solid ${badge.color}20`,
              }}
            >
              <div
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: badge.dot, boxShadow: badge.glow }}
              />
              {sourceLabel(session.source)}
            </span>
            <span style={{ color: 'var(--text-tertiary)' }} className="text-sm font-medium">/</span>
            <span className="text-sm font-semibold tracking-wide" style={{ color: 'var(--text-primary)' }}>
              {session.project}
            </span>
          </div>
          <span className="text-xs font-mono" style={{ color: 'var(--text-tertiary)' }}>
            {new Date(session.startedAt).toLocaleString(undefined, {
              dateStyle: 'full',
              timeStyle: 'medium',
            })}
          </span>
        </div>
        <div className="flex gap-2.5">
          <CopyButton label="Markdown" getValue={() => buildMarkdown(session)} />
          <CopyButton label="Context" getValue={() => buildContext(session)} />
          <CopyButton label="Raw JSON" getValue={() => buildRaw(session)} />
        </div>
      </header>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto px-8 py-8 space-y-8 scroll-smooth relative z-10">
        <div className="max-w-4xl mx-auto space-y-8 pb-10">
          {session.turns.map((turn, i) => (
            <div key={i} className="flex flex-col gap-6">

              {/* User Message */}
              <div className="flex justify-end w-full">
                <div
                  className="px-5 py-4 rounded-2xl rounded-tr-sm max-w-[85%] transition-all duration-300"
                  style={{
                    backgroundColor: 'var(--bg-user-bubble)',
                    border: '1px solid var(--border-subtle)',
                    boxShadow: 'var(--shadow-card)',
                    color: 'var(--text-user)',
                  }}
                >
                  <p className="text-[13px] leading-relaxed font-mono whitespace-pre-wrap break-words">
                    {turn.userMessage}
                  </p>
                </div>
              </div>

              {/* Assistant Message */}
              {turn.assistantSummary && (
                <div className="flex justify-start w-full">
                  <div
                    className="px-5 py-4 rounded-2xl rounded-tl-sm max-w-[85%] transition-all duration-300"
                    style={{
                      backgroundColor: 'var(--bg-assistant-bubble)',
                      border: '1px solid var(--border-subtle)',
                      boxShadow: 'var(--shadow-card)',
                      color: 'var(--text-assistant)',
                    }}
                  >
                    <AssistantContent
                      items={turn.items ?? []}
                      showToolCalls={showToolCalls}
                    />
                  </div>
                </div>
              )}

            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
