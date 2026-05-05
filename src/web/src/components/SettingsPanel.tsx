import type { AppSettings } from '../hooks/useSettings';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

export function SettingsPanel({ settings, onUpdate }: Props) {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-8">

      {/* Display */}
      <section>
        <h2 className="text-xs font-bold tracking-widest uppercase text-gray-500 mb-4">Display</h2>
        <div className="space-y-3">
          <Toggle
            label="Show tool calls"
            description="Display tool execution badges in conversation view"
            value={settings.display.showToolCalls}
            onChange={(v) => onUpdate({ display: { ...settings.display, showToolCalls: v } })}
          />
        </div>
      </section>

      {/* MCP Output */}
      <section>
        <h2 className="text-xs font-bold tracking-widest uppercase text-gray-500 mb-1">MCP Output</h2>
        <p className="text-xs text-gray-600 mb-4">
          Controls what gets sent when an agent calls <code className="bg-white/5 px-1 rounded">get_agent_history</code> via MCP.
        </p>
        <div className="space-y-3">
          <Toggle
            label="Include tool calls"
            description="Append tool names to assistant summaries in MCP responses"
            value={settings.mcp.includeToolCalls}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, includeToolCalls: v } })}
          />
          <NumberInput
            label="Max sessions"
            value={settings.mcp.maxSessions}
            min={1} max={50}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxSessions: v } })}
          />
          <NumberInput
            label="Max turns per session"
            value={settings.mcp.maxTurnsPerSession}
            min={1} max={20}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxTurnsPerSession: v } })}
          />
          <NumberInput
            label="Max chars per field"
            value={settings.mcp.maxCharsPerField}
            min={100} max={2000}
            onChange={(v) => onUpdate({ mcp: { ...settings.mcp, maxCharsPerField: v } })}
          />
        </div>
      </section>

      {/* MCP config snippet */}
      <section>
        <h2 className="text-xs font-bold tracking-widest uppercase text-gray-500 mb-3">MCP Config</h2>
        <pre className="text-xs font-mono bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 text-gray-400 overflow-x-auto whitespace-pre">
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

function Toggle({
  label, description, value, onChange,
}: { label: string; description: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <p className="text-sm font-medium text-gray-100">{label}</p>
        <p className="text-xs text-gray-400 mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`relative shrink-0 w-10 h-5 rounded-full transition-colors duration-200 ${
          value ? 'bg-indigo-500' : 'bg-white/10'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
            value ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

function NumberInput({
  label, value, min, max, onChange,
}: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <p className="text-sm font-medium text-gray-100">{label}</p>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value))))}
        className="w-20 text-center text-sm bg-white/[0.08] border border-white/[0.15] rounded-lg px-2 py-1 text-gray-100 focus:outline-none focus:border-indigo-500/70"
      />
    </div>
  );
}
