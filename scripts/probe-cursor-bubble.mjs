import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Find bubbles that look like real edits (have assistantSuggestedDiffs or suggestedCodeBlocks with content)
const rows = db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND length(value) > 5000 LIMIT 200")
  .all();

let editSample = null;
const fieldsWithPaths = new Map();
const timestampFields = new Map();

for (const r of rows) {
  let o;
  try { o = JSON.parse(r.value); } catch { continue; }
  if (!editSample && Array.isArray(o.suggestedCodeBlocks) && o.suggestedCodeBlocks.length > 0) {
    editSample = { key: r.key, obj: o };
  }
  // count fields with file path strings
  walk(o, '', fieldsWithPaths, timestampFields);
}

console.log('=== top fields containing file paths ===');
const topPaths = [...fieldsWithPaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
for (const [k, n] of topPaths) console.log(`${n.toString().padStart(4)} ${k}`);

console.log('\n=== fields with timestamp-like values ===');
const topTs = [...timestampFields.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
for (const [k, n] of topTs) console.log(`${n.toString().padStart(4)} ${k}`);

if (editSample) {
  console.log('\n=== edit-bubble suggestedCodeBlocks[0] keys ===');
  const b0 = editSample.obj.suggestedCodeBlocks[0];
  console.log(Object.keys(b0).sort().join(','));
  console.log('uri:', b0.uri);
  console.log('relativeWorkspacePath:', b0.relativeWorkspacePath);
  console.log('language:', b0.language);

  console.log('\n=== edit-bubble assistantSuggestedDiffs[0] keys ===');
  if (Array.isArray(editSample.obj.assistantSuggestedDiffs) && editSample.obj.assistantSuggestedDiffs.length) {
    const d0 = editSample.obj.assistantSuggestedDiffs[0];
    console.log(Object.keys(d0).sort().join(','));
    console.log('relativeWorkspacePath:', d0.relativeWorkspacePath);
    console.log('uri:', d0.uri);
  }

  console.log('\n=== edit-bubble humanChanges[0] keys (if any) ===');
  if (Array.isArray(editSample.obj.humanChanges) && editSample.obj.humanChanges.length) {
    const h0 = editSample.obj.humanChanges[0];
    console.log(Object.keys(h0).sort().join(','));
  }
}

db.close();

function walk(obj, prefix, paths, ts, depth = 0) {
  if (depth > 4 || obj == null) return;
  if (typeof obj === 'string') {
    if ((obj.includes('\\') || obj.includes('/')) && obj.length < 500 && /\.[a-z0-9]{1,8}$/i.test(obj)) {
      paths.set(prefix, (paths.get(prefix) ?? 0) + 1);
    }
    return;
  }
  if (typeof obj === 'number' && obj > 1e12 && obj < 2e13) {
    ts.set(prefix, (ts.get(prefix) ?? 0) + 1);
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj.slice(0, 20)) walk(v, `${prefix}[]`, paths, ts, depth + 1);
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) walk(v, prefix ? `${prefix}.${k}` : k, paths, ts, depth + 1);
  }
}
