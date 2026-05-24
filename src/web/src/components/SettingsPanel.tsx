import React from 'react';
import type { AppSettings } from '../hooks/useSettings';
import type { ViewSettings } from '../hooks/useViewSettings';
import { fetchRepoStatus, type RepoStatus } from '../api';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
  viewSettings: ViewSettings;
  onUpdateView: <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => void;
  commitRepos: string[];
}

export function SettingsPanel({ settings, onUpdate, viewSettings, onUpdateView, commitRepos }: Props) {
  const [repoStatus, setRepoStatus] = React.useState<RepoStatus | null>(null);
  const [repoInput, setRepoInput] = React.useState('');
  const [defaultPrompt, setDefaultPrompt] = React.useState('');
  const [savedPrompt, setSavedPrompt] = React.useState('');
  const [promptDraft, setPromptDraft] = React.useState(settings.knowledge.prompt ?? '');
  const memoryTargets = settings.knowledge.watchedRepos ?? [];
  const ignoredTargets = settings.knowledge.ignoredRepos ?? [];
  const activePrompt = savedPrompt || defaultPrompt;
  const promptChanged = promptDraft !== activePrompt;
  const inputTarget = repoInput.trim();
  const inputAlreadyAdded = inputTarget
    ? memoryTargets.some((r) => samePath(r, inputTarget))
    : false;
  const canAddInput = inputTarget.length > 0 && !inputAlreadyAdded;

  React.useEffect(() => {
    let cancelled = false;
    fetchRepoStatus()
      .then((status) => {
        if (cancelled) return;
        setRepoStatus(status);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/knowledge-prompt')
      .then((r) => r.json())
      .then((data: { prompt: string; defaultPrompt: string; custom: boolean }) => {
        if (cancelled) return;
        setDefaultPrompt(data.defaultPrompt);
        setSavedPrompt(data.prompt);
        setPromptDraft(data.prompt);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    if (!settings.knowledge.prompt) return;
    setSavedPrompt(settings.knowledge.prompt);
    setPromptDraft(settings.knowledge.prompt);
  }, [settings.knowledge.prompt]);

  React.useEffect(() => {
    const autoTargets = uniquePaths([
      ...(repoStatus?.repoRoot ? [repoStatus.repoRoot] : []),
      ...commitRepos,
    ]);
    const missing = autoTargets.filter((repo) =>
      !memoryTargets.some((target) => samePath(target, repo)) &&
      !ignoredTargets.some((target) => samePath(target, repo)),
    );
    if (missing.length === 0) return;
    onUpdate({
      knowledge: {
        ...settings.knowledge,
        watchedRepos: [...memoryTargets, ...missing],
      },
    });
  }, [commitRepos, ignoredTargets, memoryTargets, onUpdate, repoStatus?.repoRoot, settings.knowledge]);

  function addMemoryTarget(raw: string) {
    const target = raw.trim();
    if (!target) return;
    const exists = memoryTargets.some((r) => samePath(r, target));
    if (exists) return;
    onUpdate({
      knowledge: {
        ...settings.knowledge,
        watchedRepos: [...memoryTargets, target],
        ignoredRepos: ignoredTargets.filter((repo) => !samePath(repo, target)),
      },
    });
    setRepoInput('');
  }

  function removeMemoryTarget(target: string) {
    onUpdate({
      knowledge: {
        ...settings.knowledge,
        watchedRepos: memoryTargets.filter((r) => !samePath(r, target)),
        ignoredRepos: uniquePaths([...ignoredTargets, target]),
      },
    });
  }

  function savePromptDraft() {
    const nextKnowledge = { ...settings.knowledge };
    const nextPrompt = promptDraft.trimEnd();
    if (nextPrompt.trim().length > 0 && nextPrompt !== defaultPrompt.trimEnd()) {
      nextKnowledge.prompt = nextPrompt;
      setSavedPrompt(nextPrompt);
    } else {
      nextKnowledge.prompt = defaultPrompt;
      setSavedPrompt(defaultPrompt);
    }
    onUpdate({ knowledge: nextKnowledge });
  }

  function resetPrompt() {
    const nextKnowledge = { ...settings.knowledge };
    nextKnowledge.prompt = defaultPrompt;
    setPromptDraft(defaultPrompt);
    setSavedPrompt(defaultPrompt);
    onUpdate({ knowledge: nextKnowledge });
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3.5">

      {/* View */}
      <section className="settings-card">
        <SectionTitle>View</SectionTitle>
        <SectionHint>Control how transcripts feel while you read them.</SectionHint>

        <Toggle
          label="Show tool calls"
          description="Display tool execution in conversation view"
          value={settings.display.showToolCalls}
          onChange={(v) => onUpdate({ display: { ...settings.display, showToolCalls: v } })}
        />

        <Toggle
          label="Show tool outputs"
          description="Off by default — outputs are often large dumps (file contents, command stdout) and reflect the environment at the time, which may now be stale. Turn on when you need the actual result text."
          value={settings.display.showToolOutputs}
          onChange={(v) => onUpdate({ display: { ...settings.display, showToolOutputs: v } })}
        />

      </section>

      <section className="settings-card">
        <SectionTitle>Memory</SectionTitle>
        <SectionHint>Repositories shown in By commit are included automatically.</SectionHint>

        <Toggle
          label="Create commit memory"
          description="When enabled, new commits in the targets below run learn in the background"
          value={settings.knowledge.enabled}
          onChange={(v) => onUpdate({ knowledge: { ...settings.knowledge, enabled: v } })}
        />

        <div className="mb-3">
          <div className="text-[10.5px] font-bold uppercase tracking-[0.08em] mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
            Targets
          </div>
          {memoryTargets.length === 0 ? (
            <p className="m-0 text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
              No memory targets yet.
            </p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
              {memoryTargets.map((target) => (
                <MemoryTargetRow
                  key={target}
                  target={target}
                  kind={targetKind(target, repoStatus?.repoRoot, commitRepos)}
                  onRemove={() => removeMemoryTarget(target)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-2">
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="Add another repository path"
            className="focus-ring min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-[11px]"
            style={{
              borderColor: 'var(--border-main)',
              backgroundColor: 'var(--bg-inset)',
              color: 'var(--text-primary)',
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (canAddInput) addMemoryTarget(inputTarget);
            }}
            disabled={!canAddInput}
            className="focus-ring rounded-lg border px-3 py-2 text-[12px] font-semibold"
            style={{
              borderColor: 'var(--border-main)',
              backgroundColor: 'var(--bg-card)',
              color: 'var(--text-primary)',
              cursor: canAddInput ? 'pointer' : 'default',
              opacity: canAddInput ? 1 : 0.55,
            }}
          >
            {inputAlreadyAdded ? 'Added' : '+'}
          </button>
        </div>
      </section>

      <section className="settings-card">
        <SectionTitle>Knowledge Prompt</SectionTitle>
        <SectionHint>Customize how commit notes are written.</SectionHint>
        <textarea
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          placeholder="Loading prompt..."
          spellCheck={false}
          className="focus-ring w-full min-h-48 resize-y rounded-lg border px-3 py-2 font-mono text-[11px] leading-relaxed"
          style={{
            borderColor: 'var(--border-main)',
            backgroundColor: 'var(--bg-inset)',
            color: 'var(--text-primary)',
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {savedPrompt && savedPrompt !== defaultPrompt ? 'Custom prompt active' : 'Built-in prompt active'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resetPrompt}
              disabled={savedPrompt === defaultPrompt && promptDraft === defaultPrompt}
              className="focus-ring rounded-lg border px-3 py-1.5 text-[12px] font-semibold"
              style={{
                borderColor: 'var(--border-main)',
                backgroundColor: 'var(--bg-card)',
                color: 'var(--text-secondary)',
                cursor: savedPrompt !== defaultPrompt || promptDraft !== defaultPrompt ? 'pointer' : 'default',
                opacity: savedPrompt !== defaultPrompt || promptDraft !== defaultPrompt ? 1 : 0.55,
              }}
            >
              Use default
            </button>
            <button
              type="button"
              onClick={savePromptDraft}
              disabled={!promptChanged}
              className="focus-ring rounded-lg border px-3 py-1.5 text-[12px] font-semibold"
              style={{
                borderColor: promptChanged ? 'var(--accent)' : 'var(--border-main)',
                backgroundColor: promptChanged ? 'var(--accent)' : 'var(--bg-card)',
                color: promptChanged ? 'white' : 'var(--text-tertiary)',
                cursor: promptChanged ? 'pointer' : 'default',
                opacity: promptChanged ? 1 : 0.55,
              }}
            >
              Save
            </button>
          </div>
        </div>
      </section>

      {/* MCP Output */}
      <section className="settings-card">
        <SectionTitle>MCP Output</SectionTitle>
        <p className="m-0 mb-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          Defaults applied when an agent calls{' '}
          <code className="font-mono text-[10.5px] px-[5px] py-px rounded" style={{ backgroundColor: 'var(--bg-inset)' }}>
            get_agent_history
          </code>{' '}
          without arguments. Persisted to{' '}
          <code className="font-mono text-[10.5px] px-[5px] py-px rounded" style={{ backgroundColor: 'var(--bg-inset)' }}>
            ~/.agent-history/config.json
          </code>{' '}
          and read by the MCP process spawned via the config below.
        </p>
        <div className="flex flex-col">
          <Toggle
            label="Include tool calls"
            description="Append tool names to assistant summaries in MCP responses"
            value={settings.mcp.includeToolCalls}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, includeToolCalls: v } })}
          />
          <Toggle
            label="Include tool outputs"
            description="Off by default — tool outputs can be very large and consume MCP token budget. The next agent can re-run the tool if it needs the actual data."
            value={settings.mcp.includeToolOutputs}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, includeToolOutputs: v } })}
          />
          <NumberInput label="Max sessions" value={settings.mcp.maxSessions} min={1}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxSessions: v } })} />
          <NumberInput label="Max turns per session" value={settings.mcp.maxTurnsPerSession} min={1}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxTurnsPerSession: v } })} />
          <NumberInput label="Max chars per field" value={settings.mcp.maxCharsPerField} min={100}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxCharsPerField: v } })} />
        </div>
      </section>

      {/* MCP Config */}
      <section className="settings-card">
        <SectionTitle>Quick add</SectionTitle>
        <p className="m-0 mb-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          Add the agent-history MCP server from the CLI when your agent supports it.
        </p>
        <CodeBlock label="Claude Code (Windows / WSL)">
{`claude mcp add agent-history -- cmd.exe /c npx -y @contextberg/agent-history --mcp`}
        </CodeBlock>
        <CodeBlock label="Codex (Windows / WSL)">
{`codex mcp add agent-history -- cmd.exe /c npx -y @contextberg/agent-history --mcp`}
        </CodeBlock>
        <CodeBlock label="OpenClaw (Windows / WSL)">
{`openclaw mcp set agent-history -- cmd.exe /c npx -y @contextberg/agent-history --mcp`}
        </CodeBlock>
        <CodeBlock label="Skill">
{`npx skills add contextberg/agent-history --skill agent-history-cli`}
        </CodeBlock>
      </section>

      <section className="settings-card">
        <SectionTitle>Others / MCP Config</SectionTitle>
        <p className="m-0 mb-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
          For clients that use <code className="font-mono text-[10.5px] px-[5px] py-px rounded" style={{ backgroundColor: 'var(--bg-inset)' }}>mcp.json</code>, use <code className="font-mono text-[10.5px] px-[5px] py-px rounded" style={{ backgroundColor: 'var(--bg-inset)' }}>cmd.exe</code> on Windows or WSL, and <code className="font-mono text-[10.5px] px-[5px] py-px rounded" style={{ backgroundColor: 'var(--bg-inset)' }}>npx</code> directly on macOS or Linux.
        </p>
        <pre className="font-mono m-0 text-[11px] p-3.5 rounded-xl whitespace-pre overflow-x-auto border" style={{ backgroundColor: 'var(--bg-inset)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
{`{
  "mcpServers": {
    "agent-history": {
      "command": "cmd.exe",
      "args": [
        "/c",
        "npx",
        "-y",
        "@contextberg/agent-history",
        "--mcp"
      ]
    }
  }
}`}
        </pre>
      </section>

    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="m-0 text-[11px] font-bold tracking-[0.08em] uppercase" style={{ color: 'var(--text-primary)' }}>
      {children}
    </h2>
  );
}

function MemoryTargetRow({
  target,
  kind,
  onRemove,
}: {
  target: string;
  kind: 'current' | 'commit' | 'manual';
  onRemove: () => void;
}) {
  const label = kind === 'current' ? 'Open' : kind === 'commit' ? 'Auto' : 'Added';
  const name = repoName(target);
  return (
    <li
      className="flex items-center gap-2 rounded-lg border px-2.5 py-2.5"
      style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-inset)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="min-w-0 truncate text-[13px] font-semibold" title={name} style={{ color: 'var(--text-primary)' }}>
            {name}
          </span>
          <span
            className="shrink-0 text-[9.5px] font-bold uppercase tracking-[0.07em] rounded px-1.5 py-0.5"
            style={{
              color: kind === 'manual' ? 'var(--text-tertiary)' : 'var(--accent)',
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {label}
          </span>
        </div>
        <div className="truncate font-mono text-[10.5px]" title={target} style={{ color: 'var(--text-tertiary)' }}>
          {target}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${target}`}
        title="Remove"
        className="focus-ring shrink-0 w-7 h-7 rounded-md border text-[15px] leading-none"
        style={{
          borderColor: 'var(--border-main)',
          backgroundColor: 'var(--bg-card)',
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
        }}
      >
        x
      </button>
    </li>
  );
}

function SectionHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 mt-1 mb-3 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
      {children}
    </p>
  );
}

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (!out.some((existing) => samePath(existing, trimmed))) out.push(trimmed);
  }
  return out;
}

function targetKind(target: string, currentRepo: string | null | undefined, commitRepos: string[]): 'current' | 'commit' | 'manual' {
  if (currentRepo && samePath(target, currentRepo)) return 'current';
  if (commitRepos.some((repo) => samePath(repo, target))) return 'commit';
  return 'manual';
}

function repoName(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized.split('/').pop() || repoPath;
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  return norm(a) === norm(b);
}

const inlineCodeStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-inset)',
  padding: '1px 5px',
  borderRadius: 4,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10.5,
};

function CodeBlock({ label, children }: { label: string; children: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ marginBottom: 5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>{label}</div>
        <button
          type="button"
          onClick={() => { void copy(); }}
          style={{
            border: '1px solid var(--border-main)',
            borderRadius: 999,
            backgroundColor: 'var(--bg-card)',
            color: 'var(--text-secondary)',
            fontSize: 10.5,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="font-mono"
        style={{
          margin: 0,
          fontSize: 11,
          padding: '11px 12px',
          borderRadius: 10,
          backgroundColor: 'var(--bg-inset)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-secondary)',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {children}
      </pre>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
      <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
      {children}
    </div>
  );
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0' }}>
      <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)', flexShrink: 0 }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontSize: 12,
          padding: '5px 8px',
          borderRadius: 7,
          backgroundColor: 'var(--bg-inset)',
          border: '1px solid var(--border-main)',
          color: 'var(--text-primary)',
          fontFamily: 'inherit',
          cursor: 'pointer',
          outline: 'none',
          maxWidth: 200,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function NumberInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max?: number; onChange: (v: number) => void }) {
  const clamp = (n: number) => Math.max(min, max !== undefined ? Math.min(max, n) : n);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '8px 0' }}>
      <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</p>
      <input
        type="number"
        value={value}
        min={min}
        {...(max !== undefined ? { max } : {})}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        style={{
          width: 72,
          textAlign: 'center',
          fontSize: 13,
          padding: '4px 8px',
          borderRadius: 7,
          backgroundColor: 'var(--bg-inset)',
          border: '1px solid var(--border-main)',
          color: 'var(--text-primary)',
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
    </div>
  );
}

function Toggle({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '8px 0' }}>
      <div>
        <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</p>
        <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'var(--text-tertiary)' }}>{description}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        style={{
          position: 'relative',
          flexShrink: 0,
          width: 36,
          height: 20,
          borderRadius: 999,
          backgroundColor: value ? 'var(--accent)' : 'var(--bg-inset)',
          border: `1px solid ${value ? 'transparent' : 'var(--border-main)'}`,
          cursor: 'pointer',
          padding: 0,
          transition: 'background 200ms',
        }}
      >
        <span style={{
          position: 'absolute',
          top: 2,
          left: 2,
          width: 14,
          height: 14,
          borderRadius: 999,
          backgroundColor: 'white',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transform: value ? 'translateX(16px)' : 'translateX(0)',
          transition: 'transform 200ms',
        }} />
      </button>
    </div>
  );
}
