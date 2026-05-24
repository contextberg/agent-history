import { spawn } from 'node:child_process';
import { loadConfig } from '../config.js';
import { ensurePromptFile, resolvePrompt } from './prompt-file.js';

export async function editPrompt(): Promise<void> {
  const config = await loadConfig();
  const promptPath = await ensurePromptFile(config);
  console.log('contextberg edit-prompt\n');
  console.log(`Opening ${promptPath}`);
  console.log('Save the file to change the prompt. The next extraction reads this file directly.\n');
  await openEditor(promptPath);
  const resolved = await resolvePrompt(config);
  console.log(`Active prompt: ${resolved.source} (${resolved.prompt.length} characters).`);
}

async function openEditor(filePath: string): Promise<void> {
  const configuredEditor = process.env['VISUAL'] ?? process.env['EDITOR'];
  if (!configuredEditor) {
    await spawnEditor(defaultEditor(), [filePath]);
    return;
  }

  const quotedPath = quoteForShell(filePath);
  await spawnShellEditor(configuredEditor, quotedPath);
}

async function spawnEditor(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

async function spawnShellEditor(editor: string, quotedPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command = `${editor} ${quotedPath}`;
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${editor} exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

function defaultEditor(): string {
  return process.platform === 'win32' ? 'notepad.exe' : 'vi';
}

function quoteForShell(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
