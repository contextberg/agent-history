import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

console.log('=== top key prefixes ===');
const prefixes = db
  .prepare("SELECT substr(key,1,30) as p, count(*) as n FROM cursorDiskKV GROUP BY substr(key,1,30) ORDER BY n DESC LIMIT 25")
  .all();
for (const r of prefixes) console.log(r.n, r.p);

console.log('\n=== composerData payload structure ===');
const cd = db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND length(value) > 800 LIMIT 1")
  .get();
if (cd) {
  const o = JSON.parse(cd.value);
  console.log('top-level keys:', Object.keys(o).sort().join(','));
  console.log('\n-- string fields with path-like content --');
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && (v.includes('\\') || v.includes('/')) && v.length < 300) {
      console.log(`${k}: ${v}`);
    }
  }
  console.log('\n-- context field --');
  if (o.context) console.log(JSON.stringify(o.context, null, 2).slice(0, 1200));
  console.log('\n-- name --', o.name);
}

console.log('\n=== bubble payload structure (one with toolFormerData) ===');
const bb = db
  .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%toolFormerData%' LIMIT 1")
  .get();
if (bb) {
  const o = JSON.parse(bb.value);
  console.log('top-level keys:', Object.keys(o).sort().join(','));
  console.log('-- timestamp-ish keys --');
  for (const [k, v] of Object.entries(o)) {
    if (/at|time|stamp|created|updated/i.test(k)) console.log(`${k}: ${JSON.stringify(v).slice(0, 80)}`);
  }
  console.log('-- toolFormerData keys --');
  if (o.toolFormerData) {
    console.log(Object.keys(o.toolFormerData).sort().join(','));
    console.log('  name:', o.toolFormerData.name);
    if (o.toolFormerData.params) {
      try {
        const p = typeof o.toolFormerData.params === 'string' ? JSON.parse(o.toolFormerData.params) : o.toolFormerData.params;
        console.log('  params keys:', Object.keys(p).sort().join(','));
        console.log('  params sample:', JSON.stringify(p).slice(0, 400));
      } catch {}
    }
  }
}

console.log('\n=== bubble examples — distinct tool names ===');
const tools = db
  .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%toolFormerData%' LIMIT 200")
  .all();
const toolNames = new Set();
const paramKeys = new Set();
for (const r of tools) {
  try {
    const o = JSON.parse(r.value);
    const tfd = o.toolFormerData;
    if (tfd?.name) toolNames.add(tfd.name);
    if (tfd?.params) {
      try {
        const p = typeof tfd.params === 'string' ? JSON.parse(tfd.params) : tfd.params;
        for (const k of Object.keys(p ?? {})) paramKeys.add(k);
      } catch {}
    }
  } catch {}
}
console.log('tool names:', [...toolNames].join(' | '));
console.log('all param keys seen:', [...paramKeys].join(','));

db.close();
