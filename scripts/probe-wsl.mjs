import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const e = promisify(execFile);

const r = await e('wsl.exe', ['-l', '-q'], { encoding: 'buffer' });
const distros = r.stdout
  .toString('utf16le')
  .split(/\r?\n/)
  .map((s) => s.replace(/\0/g, '').trim())
  .filter(Boolean);
console.log('distros:', distros);

for (const d of distros) {
  const root = `\\\\wsl.localhost\\${d}\\home`;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    console.log(d, '->', entries.map((x) => x.name));
    for (const u of entries) {
      if (!u.isDirectory()) continue;
      const cl = `${root}\\${u.name}\\.claude\\projects`;
      try {
        await fs.access(cl);
        console.log('  EXIST:', cl);
      } catch {
        console.log('  miss :', cl);
      }
    }
  } catch (err) {
    console.log(d, 'readdir err:', err.code);
  }
}
