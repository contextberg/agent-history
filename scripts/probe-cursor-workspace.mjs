import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const wsRoot = path.join(process.env.APPDATA, 'Cursor', 'User', 'workspaceStorage');
const dirs = fs.readdirSync(wsRoot).filter((d) => fs.existsSync(path.join(wsRoot, d, 'state.vscdb')));
console.log(`workspace dirs: ${dirs.length}`);

let composerKeysFound = false;
const tableSeen = new Set();
const composerToFolder = new Map();

for (const d of dirs) {
  const wsJsonPath = path.join(wsRoot, d, 'workspace.json');
  let folder = null;
  try { folder = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8')).folder; } catch {}
  if (!folder) continue;

  const dbPath = path.join(wsRoot, d, 'state.vscdb');
  let db;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch { continue; }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const t of tables) tableSeen.add(t.name);
    // ItemTable is workspace-level KV
    const composerKey = db
      .prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%composer%' OR key LIKE '%Composer%'")
      .all();
    if (composerKey.length && !composerKeysFound) {
      composerKeysFound = true;
      console.log(`\nworkspace: ${folder}`);
      console.log('composer-related ItemTable keys:');
      for (const r of composerKey) {
        console.log(`  ${r.key} → ${(r.value || '').slice(0, 200)}`);
      }
    }
    // Try the standard key Cursor uses
    const allComp = db.prepare("SELECT key, value FROM ItemTable WHERE key = 'composer.composerData'").get();
    if (allComp) {
      try {
        const j = JSON.parse(allComp.value);
        const ids = Array.isArray(j?.allComposers) ? j.allComposers.map((c) => c.composerId) : [];
        for (const id of ids) composerToFolder.set(id, folder);
      } catch {}
    }
  } finally { db.close(); }
}

console.log('\ntables across workspace dbs:', [...tableSeen].join(','));
console.log(`\ncomposers mapped to a workspace folder: ${composerToFolder.size}`);
const sample = [...composerToFolder.entries()].slice(0, 5);
for (const [c, f] of sample) console.log(`  ${c.slice(0,8)} → ${f}`);
