import React from 'react';
import type { AppSettings } from '../hooks/useSettings';
import type { ViewSettings, AccentName, TranscriptStyle, ToolStyle, Density } from '../hooks/useViewSettings';
import { ACCENT_PRESETS } from '../hooks/useViewSettings';

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

        {/* Transcript style */}
        <SelectRow
          label="Transcript"
          value={viewSettings.transcriptStyle}
          options={[
            { value: 'transcript', label: 'Log — labeled turns' },
            { value: 'chat', label: 'Chat — bubbles' },
            { value: 'document', label: 'Document — prose' },
          ]}
          onChange={(v) => onUpdateView('transcriptStyle', v as TranscriptStyle)}
        />

        {/* Tool call style */}
        <SelectRow
          label="Tool calls"
          value={viewSettings.toolStyle}
          options={[
            { value: 'collapse', label: 'Collapsible (default)' },
            { value: 'inline', label: 'Inline one-liner' },
            { value: 'gutter', label: 'Gutter (left rail)' },
            { value: 'card', label: 'Card' },
          ]}
          onChange={(v) => onUpdateView('toolStyle', v as ToolStyle)}
        />

        {/* Density */}
        <Row label="Density">
          <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 8, backgroundColor: 'var(--bg-inset)' }}>
            {(['compact', 'cozy', 'comfortable'] as Density[]).map((d) => {
              const active = viewSettings.density === d;
              return (
                <button
                  key={d}
                  onClick={() => onUpdateView('density', d)}
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 6,
                    backgroundColor: active ? 'var(--bg-panel)' : 'transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    border: active ? '1px solid var(--border-main)' : '1px solid transparent',
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    boxShadow: active ? 'var(--shadow-card)' : 'none',
                    transition: 'background 120ms',
                  }}
                >
                  {d === 'compact' ? 'Tight' : d === 'cozy' ? 'Cozy' : 'Roomy'}
                </button>
              );
            })}
          </div>
        </Row>
      </section>

      {/* MCP Output */}
      <section>
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
          <NumberInput label="Max sessions" value={settings.mcp.maxSessions} min={1} max={50}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxSessions: v } })} />
          <NumberInput label="Max turns per session" value={settings.mcp.maxTurnsPerSession} min={1} max={20}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxTurnsPerSession: v } })} />
          <NumberInput label="Max chars per field" value={settings.mcp.maxCharsPerField} min={100} max={2000}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxCharsPerField: v } })} />
        </div>
      </section>

      {/* MCP Config */}
      <section>
        <SectionTitle>MCP Config</SectionTitle>
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

      {/* Tone */}
      <section>
        <SectionTitle>Tone</SectionTitle>
        <Row label="Accent color">
          <div style={{ display: 'flex', gap: 6 }}>
            {(Object.keys(ACCENT_PRESETS) as AccentName[]).map((name) => (
              <button
                key={name}
                onClick={() => onUpdateView('accent', name)}
                title={name}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  backgroundColor: ACCENT_PRESETS[name].color,
                  border: `2px solid ${viewSettings.accent === name ? 'var(--text-primary)' : 'transparent'}`,
                  outline: viewSettings.accent === name ? `2px solid ${ACCENT_PRESETS[name].color}` : 'none',
                  outlineOffset: 1,
                  cursor: 'pointer',
                  padding: 0,
                  transition: 'border 120ms, outline 120ms',
                }}
              />
            ))}
          </div>
        </Row>
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

function NumberInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '8px 0' }}>
      <p style={{ margin: 0, fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</p>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value))))}
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

