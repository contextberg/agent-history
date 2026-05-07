/**
 * Eval: build lineages from real claude-code sessions and print a summary.
 */
import { ClaudeCodeReader } from '../src/readers/claude-code.js';
import { buildLineages } from '../src/linkage/lineage.js';

const sessions = await new ClaudeCodeReader().read({ maxSessions: 200, maxTurnsPerSession: 50 });
console.log(`# Sessions loaded: ${sessions.length}`);

const lineages = buildLineages(sessions);
const multi = lineages.filter((l) => l.members.length > 1);
const single = lineages.filter((l) => l.members.length === 1);
const totalMembers = lineages.reduce((n, l) => n + l.members.length, 0);

console.log(`# Lineages: ${lineages.length}  (single=${single.length}, multi=${multi.length})`);
console.log(`# Total members across lineages: ${totalMembers} (should equal ${sessions.length})`);
console.log();

if (multi.length === 0) {
  console.log('No multi-session lineages in this dataset.');
} else {
  console.log('=== Multi-member lineages ===');
  for (const l of multi.slice(0, 10)) {
    const span = `${l.startedAt.toISOString().slice(0, 16)} → ${l.endedAt.toISOString().slice(0, 16)}`;
    console.log(`* ${l.id.slice(0, 8)}  members=${l.members.length}  cwd=${l.cwd ?? '?'}  ${span}`);
    for (const m of l.members) {
      const e = (m.endedAt ?? m.startedAt).toISOString().slice(0, 16);
      const s = m.startedAt.toISOString().slice(0, 16);
      const tag = m.resumedFrom ? `↳ ${m.resumedFrom.slice(0, 8)}` : '(root)';
      console.log(`    - ${m.id.slice(0, 8)}  ${s} → ${e}  turns=${m.turns.length}  ${tag}`);
    }
  }
}
