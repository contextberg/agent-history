import { CursorReader } from '../src/readers/cursor.js';

const r = await new CursorReader().read({ maxSessions: 500, maxTurnsPerSession: 200 });
console.log('total cursor sessions:', r.length);
console.log('with cwd:', r.filter((s) => !!s.cwd).length);
const withEdits = r.filter((s) => s.turns.some((t) => (t.touchedFiles?.length ?? 0) > 0));
console.log('sessions with at least 1 edit turn:', withEdits.length);
console.log('total edit turns:', r.reduce((n, s) => n + s.turns.filter((t) => (t.touchedFiles?.length ?? 0) > 0).length, 0));
console.log('total edit paths:', r.reduce((n, s) => n + s.turns.reduce((m, t) => m + (t.touchedFiles?.length ?? 0), 0), 0));
const sample = withEdits[0];
if (sample) {
  const t = sample.turns.find((t) => (t.touchedFiles?.length ?? 0) > 0);
  console.log('sample session cwd:', sample.cwd);
  console.log('sample edit files:', t?.touchedFiles?.slice(0, 3));
}
