import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const rows = db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%diffsSinceLastApply%' AND length(value) > 1000 LIMIT 5")
  .all();

console.log(`bubbles with diffsSinceLastApply: ${rows.length}`);
for (const r of rows) {
  const o = JSON.parse(r.value);
  const d = o.diffsSinceLastApply;
  console.log(`\n--- ${r.key.slice(0, 60)}... (type=${o.type}) ---`);
  if (Array.isArray(d) && d.length) {
    console.log('count:', d.length);
    console.log('first item keys:', Object.keys(d[0]).sort().join(','));
    console.log('first item:', JSON.stringify(d[0]).slice(0, 500));
  }
}

// Also check timingInfo presence pattern
const all = db
  .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' LIMIT 500")
  .all();
let withTiming = 0, withTimingByType = { 1: 0, 2: 0 };
let totalByType = { 1: 0, 2: 0 };
for (const r of all) {
  try {
    const o = JSON.parse(r.value);
    const t = o.type;
    if (t === 1 || t === 2) totalByType[t]++;
    if (o.timingInfo) {
      withTiming++;
      if (t === 1 || t === 2) withTimingByType[t]++;
    }
  } catch {}
}
console.log(`\nbubbles sampled: ${all.length}, with timingInfo: ${withTiming}`);
console.log(`type=1 (user): ${withTimingByType[1]}/${totalByType[1]} have timingInfo`);
console.log(`type=2 (assistant): ${withTimingByType[2]}/${totalByType[2]} have timingInfo`);

db.close();
