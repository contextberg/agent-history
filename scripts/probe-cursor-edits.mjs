import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Look for bubbles where editing actually appears persistent
const rows = db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND length(value) > 5000 LIMIT 1000")
  .all();

let stats = {
  diffsSinceLastApplyNonEmpty: 0,
  assistantSuggestedDiffsNonEmpty: 0,
  suggestedCodeBlocksNonEmpty: 0,
  codeBlocksNonEmpty: 0,
  toolFormerDataPresent: 0,
};
const filePathsByField = new Map();

for (const r of rows) {
  let o; try { o = JSON.parse(r.value); } catch { continue; }
  for (const f of ['diffsSinceLastApply', 'assistantSuggestedDiffs', 'suggestedCodeBlocks', 'codeBlocks']) {
    const arr = o[f];
    if (Array.isArray(arr) && arr.length > 0) {
      stats[f + 'NonEmpty']++;
      const sample = arr[0];
      if (sample && typeof sample === 'object') {
        // Try to find a path inside
        const path1 = sample.relativeWorkspacePath
          ?? sample.uri?.path
          ?? sample.uri?._fsPath
          ?? sample.path
          ?? sample.filename;
        if (typeof path1 === 'string' && path1) {
          filePathsByField.set(f, (filePathsByField.get(f) ?? new Set()).add(path1));
        }
      }
    }
  }
  if (o.toolFormerData) stats.toolFormerDataPresent++;
}

console.log('over', rows.length, 'bubbles:');
for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
console.log('\nsample paths by field:');
for (const [k, v] of filePathsByField.entries()) {
  console.log(`  ${k}: ${[...v].slice(0,3).join(' | ')}`);
}

// Also inspect a non-empty assistantSuggestedDiffs
const sample = rows.find((r) => {
  try { const o = JSON.parse(r.value); return Array.isArray(o.assistantSuggestedDiffs) && o.assistantSuggestedDiffs.length > 0; } catch { return false; }
});
if (sample) {
  const o = JSON.parse(sample.value);
  console.log('\n=== assistantSuggestedDiffs[0] ===');
  console.log(JSON.stringify(o.assistantSuggestedDiffs[0], null, 2).slice(0, 800));
}

const sample2 = rows.find((r) => {
  try { const o = JSON.parse(r.value); return Array.isArray(o.suggestedCodeBlocks) && o.suggestedCodeBlocks.length > 0; } catch { return false; }
});
if (sample2) {
  const o = JSON.parse(sample2.value);
  console.log('\n=== suggestedCodeBlocks[0] ===');
  console.log(JSON.stringify(o.suggestedCodeBlocks[0], null, 2).slice(0, 800));
}

db.close();
