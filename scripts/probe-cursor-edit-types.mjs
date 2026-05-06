import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Get all bubbles with non-empty diffsSinceLastApply, distribution by type
const rows = db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%diffsSinceLastApply%'")
  .all();

const byType = {};
let nonEmpty = 0;
const sampleByType = {};
for (const r of rows) {
  let o; try { o = JSON.parse(r.value); } catch { continue; }
  if (!Array.isArray(o.diffsSinceLastApply) || o.diffsSinceLastApply.length === 0) continue;
  nonEmpty++;
  const t = o.type ?? 'undef';
  byType[t] = (byType[t] ?? 0) + 1;
  if (!sampleByType[t]) sampleByType[t] = { key: r.key, paths: o.diffsSinceLastApply.slice(0, 2).map((d) => d.relativeWorkspacePath) };
}
console.log('non-empty diffsSinceLastApply by type:', byType);
console.log('total:', nonEmpty);
for (const [t, s] of Object.entries(sampleByType)) {
  console.log(`type=${t}: paths sample:`, s.paths);
}
db.close();
