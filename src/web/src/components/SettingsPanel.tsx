import React from 'react';
import type { AppSettings } from '../hooks/useSettings';
import type { ViewSettings } from '../hooks/useViewSettings';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
  viewSettings: ViewSettings;
  onUpdateView: <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => void;
}

export function SettingsPanel({ settings, onUpdate, viewSettings, onUpdateView }: Props) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 28 }}>

      {/* View */}
      <section>
        <SectionTitle>View</SectionTitle>

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

      {/* MCP Output */}
      <section style={{ borderTop: '1px solid var(--border-main)', paddingTop: 24 }}>
        <SectionTitle>MCP Output</SectionTitle>
        <p style={{ margin: '0 0 12px', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          Defaults applied when an agent calls{' '}
          <code style={{ backgroundColor: 'var(--bg-inset)', padding: '1px 5px', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>
            get_agent_history
          </code>{' '}
          without arguments. Persisted to{' '}
          <code style={{ backgroundColor: 'var(--bg-inset)', padding: '1px 5px', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>
            ~/.agent-history/config.json
          </code>{' '}
          and read by the MCP process spawned via the config below.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
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
      <section>
        <SectionTitle>Quick add</SectionTitle>
        <p style={{ margin: '0 0 12px', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          Add the MCP server from the CLI when your agent supports it, or install the companion skill when you want the usage pattern available inside the agent.
        </p>
        <CodeBlock label="Claude Code (Windows)">
{`claude mcp add agent-history -- cmd /c "npx -y @contextberg/agent-history --mcp"`}
        </CodeBlock>
        <CodeBlock label="Codex">
{`codex mcp add agent-history -- npx -y @contextberg/agent-history --mcp`}
        </CodeBlock>
        <CodeBlock label="Skill">
{`npx skills add contextberg/agent-history --skill agent-history-cli`}
        </CodeBlock>
      </section>

      <section>
        <SectionTitle>MCP Config</SectionTitle>
        <p style={{ margin: '0 0 12px', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          Cursor reads MCP configuration from <code style={inlineCodeStyle}>mcp.json</code>; the same JSON also works for clients that prefer direct config editing.
        </p>
        <pre className="font-mono" style={{ margin: 0, fontSize: 11, padding: '14px', borderRadius: 10, backgroundColor: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', overflowX: 'auto', whiteSpace: 'pre' }}>
{`{
  "mcpServers": {
    "agent-history": {
      "command": "npx",
      "args": [
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
    <h2 style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-primary)' }}>
      {children}
    </h2>
  );
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
