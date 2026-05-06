/**
 * Diagnostic: how many sessions per source actually expose the linkage fields
 * (cwd, endedAt, touchedFiles)? Run with: npx tsx scripts/probe-cwd-coverage.ts
 */
import { ClaudeCodeReader } from '../src/readers/claude-code.js';
import { CodexReader } from '../src/readers/codex.js';
import { CursorReader } from '../src/readers/cursor.js';
import type { AgentSession, AgentSource } from '../src/readers/types.js';

async function main(): Promise<void> {
  const opts = { maxSessions: 50, maxTurnsPerSession: 100 };
  const sources: Array<[AgentSource, () => Promise<AgentSession[]>]> = [
    ['claude-code', () => new ClaudeCodeReader().read(opts)],
    ['codex', () => new CodexReader().read(opts)],
    ['cursor', () => new CursorReader().read(opts)],
  ];

  for (const [name, fn] of sources) {
    const sessions = await fn().catch(() => []);
    const total = sessions.length;
    const withCwd = sessions.filter((s) => !!s.cwd).length;
    const withEnded = sessions.filter((s) => !!s.endedAt).length;
    const withBranch = sessions.filter((s) => !!s.gitBranch).length;
    const turnsTotal = sessions.reduce((n, s) => n + s.turns.length, 0);
    const turnsWithStart = sessions.reduce((n, s) => n + s.turns.filter((t) => !!t.startedAt).length, 0);
    const turnsWithFiles = sessions.reduce((n, s) => n + s.turns.filter((t) => (t.touchedFiles?.length ?? 0) > 0).length, 0);
    const filesTotal = sessions.reduce(
      (n, s) => n + s.turns.reduce((m, t) => m + (t.touchedFiles?.length ?? 0), 0),
      0,
    );
    console.log(`[${name}] sessions=${total}  cwd=${withCwd}  endedAt=${withEnded}  gitBranch=${withBranch}`);
    console.log(`         turns=${turnsTotal}  turnsWithStart=${turnsWithStart}  turnsWithEdits=${turnsWithFiles}  totalEditPaths=${filesTotal}`);
    const sample = sessions.find((s) => s.cwd);
    if (sample) console.log(`         sample cwd: ${sample.cwd}`);
    const editSample = sessions.find((s) => s.turns.some((t) => (t.touchedFiles?.length ?? 0) > 0));
    if (editSample) {
      const t = editSample.turns.find((t) => (t.touchedFiles?.length ?? 0) > 0);
      console.log(`         sample edit: ${t?.touchedFiles?.[0]}`);
    }
    console.log();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
