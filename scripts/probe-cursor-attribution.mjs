import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Find bubbles with non-empty diffsSinceLastApply, then check whether their composer
// has fullConversationHeadersOnly that includes the bubble.
const editBubbles = db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND length(value) > 1000 LIMIT 5000")
  .all();

let nonEmpty = 0;
let inHeaders = 0;
let composerSeen = new Set();
let composerWithEdits = new Set();
const composerHeadersById = new Map();

function loadComposerHeaders(composerId) {
  if (composerHeadersById.has(composerId)) return composerHeadersById.get(composerId);
  const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`);
  if (!row?.value) { composerHeadersById.set(composerId, null); return null; }
  try {
    const o = JSON.parse(row.value);
    const h = Array.isArray(o.fullConversationHeadersOnly) ? o.fullConversationHeadersOnly : (Array.isArray(o.conversation) ? o.conversation : []);
    const ids = new Set(h.map((x) => x?.bubbleId));
    composerHeadersById.set(composerId, ids);
    return ids;
  } catch { composerHeadersById.set(composerId, null); return null; }
}

for (const r of editBubbles) {
  let o; try { o = JSON.parse(r.value); } catch { continue; }
  if (!Array.isArray(o.diffsSinceLastApply) || o.diffsSinceLastApply.length === 0) continue;
  nonEmpty++;
  // Key format: bubbleId:<composerId>:<bubbleId>
  const parts = r.key.split(':');
  const composerId = parts[1];
  const bubbleId = parts.slice(2).join(':');
  composerSeen.add(composerId);
  const headers = loadComposerHeaders(composerId);
  if (headers && headers.has(bubbleId)) {
    inHeaders++;
    composerWithEdits.add(composerId);
  }
}

console.log(`non-empty diff bubbles: ${nonEmpty}`);
console.log(`of those, listed in their composer headers: ${inHeaders}`);
console.log(`distinct composers with edit bubbles: ${composerSeen.size}`);
console.log(`distinct composers where edits appear in headers: ${composerWithEdits.size}`);

db.close();
