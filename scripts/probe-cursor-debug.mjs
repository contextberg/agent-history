import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Find the 20 composers with edits.
const editBubbles = db
  .prepare("SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%diffsSinceLastApply%' AND length(value) > 1000")
  .all();
const editComposerIds = new Set();
for (const r of editBubbles) {
  // We need to verify content actually has non-empty diffs
  const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(r.key);
  if (!row) continue;
  let o; try { o = JSON.parse(row.value); } catch { continue; }
  if (Array.isArray(o.diffsSinceLastApply) && o.diffsSinceLastApply.length > 0) {
    const composerId = r.key.split(':')[1];
    editComposerIds.add(composerId);
  }
}
console.log('composers with non-empty edit bubbles:', editComposerIds.size);

// Now load composer metadata for these.
const editComposers = [];
for (const id of editComposerIds) {
  const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key=?").get(`composerData:${id}`);
  if (!row) { console.log(`  ${id}: NO composerData row`); continue; }
  try {
    const cd = JSON.parse(row.value);
    const headers = Array.isArray(cd.fullConversationHeadersOnly) ? cd.fullConversationHeadersOnly
      : Array.isArray(cd.conversation) ? cd.conversation : [];
    editComposers.push({
      id,
      headersLen: headers.length,
      lastUpdatedAt: cd.lastUpdatedAt ?? cd.createdAt ?? 0,
      name: cd.name ?? null,
      hasFullHeaders: !!cd.fullConversationHeadersOnly,
      hasConversation: !!cd.conversation,
    });
  } catch { console.log(`  ${id}: parse fail`); }
}
editComposers.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
console.log(`\ncomposers with edits, sorted by lastUpdatedAt:`);
for (const c of editComposers.slice(0, 10)) {
  const d = c.lastUpdatedAt > 0 ? new Date(c.lastUpdatedAt).toISOString() : '?';
  console.log(`  ${c.id.slice(0, 8)} headers=${c.headersLen.toString().padStart(4)} (full=${c.hasFullHeaders}/conv=${c.hasConversation}) lastUpdated=${d} name=${c.name?.slice(0,40) ?? ''}`);
}

// Compare against what the reader picks
const allComposers = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
const all = [];
for (const r of allComposers) {
  if (!r.value) continue;
  try {
    const cd = JSON.parse(r.value);
    const headers = Array.isArray(cd.fullConversationHeadersOnly) ? cd.fullConversationHeadersOnly
      : Array.isArray(cd.conversation) ? cd.conversation : [];
    if (headers.length === 0) continue;
    const id = r.key.slice('composerData:'.length);
    all.push({ id, headersLen: headers.length, lastUpdatedAt: cd.lastUpdatedAt ?? cd.createdAt ?? 0 });
  } catch {}
}
all.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
console.log(`\ntotal composers with non-empty headers: ${all.length}`);
const top50 = new Set(all.slice(0, 50).map((c) => c.id));
const editsInTop50 = [...editComposerIds].filter((id) => top50.has(id));
console.log(`edit-composers in top 50: ${editsInTop50.length}/${editComposerIds.size}`);

db.close();
