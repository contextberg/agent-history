import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/**
 * Reusable readline-based prompts. Inspired by reference/hermes_cli/setup.py
 * but kept minimal — no curses, no checklist multi-select for v1.
 *
 * Each function takes an `rl` so a single Interface is reused across a wizard
 * run (avoids racing readline instances on stdin).
 */

export type RL = readline.Interface;

export function createInterface(): RL {
  return readline.createInterface({ input, output });
}

export function isInteractiveStdin(): boolean {
  return Boolean(input.isTTY);
}

export function printNonInteractiveGuidance(reason?: string): void {
  const lines = [
    '',
    'contextberg setup needs an interactive terminal but stdin is not a TTY.',
  ];
  if (reason) lines.push(`Reason: ${reason}`);
  lines.push(
    '',
    'Either:',
    '  • Run `contextberg setup` directly in a terminal, or',
    '  • Pre-populate ~/.agent-history/config.json by hand and skip setup.',
    '',
  );
  console.error(lines.join('\n'));
}

export function printHeader(title: string): void {
  const bar = '─'.repeat(Math.max(8, title.length + 4));
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

/** Single-line text prompt with optional default. Returns trimmed value. */
export async function prompt(
  rl: RL,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const hint = defaultValue ? ` (${defaultValue})` : '';
  const raw = await rl.question(`${question}${hint}: `);
  return raw.trim() || defaultValue || '';
}

/**
 * Masked-input prompt for API keys. Each typed/pasted character renders as
 * `*` (paste of N chars → N stars) so the user can SEE that the input
 * registered, closing the feedback gap that made the previous version feel
 * broken. Falls back to plain prompt when stdin isn't a TTY (CI / piped).
 *
 * Implementation: take exclusive control of stdin in raw mode, read bytes
 * one chunk at a time, echo `*` for each printable char, restore the
 * caller's readline interface on Enter / Ctrl+C. This is what works
 * cross-platform — the prior monkey-patch of stdout.write didn't fire on
 * Windows because readline's echo path there bypasses process.stdout.
 */
export async function promptApiKey(rl: RL, question: string): Promise<string> {
  if (!input.isTTY) {
    return prompt(rl, question);
  }

  process.stdout.write(`${question}: `);

  // Suspend the wizard's rl so we can claim stdin without two consumers
  // racing for keypresses.
  rl.pause();

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  if (!wasRaw) stdin.setRawMode(true);
  stdin.resume();

  // Park the wizard rl's data listeners — readline registers a 'data'
  // listener on stdin that would still fire alongside ours. Restore on exit.
  const previousListeners = stdin.listeners('data') as Array<(chunk: Buffer | string) => void>;
  for (const l of previousListeners) stdin.removeListener('data', l);
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve) => {
    let buf = '';

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      if (!wasRaw) stdin.setRawMode(false);
      for (const l of previousListeners) stdin.on('data', l);
      rl.resume();
    };

    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {                  // Enter / LF
          process.stdout.write('\n');
          cleanup();
          resolve(buf.trim());
          return;
        }
        if (code === 3) {                                  // Ctrl+C
          process.stdout.write('\n');
          cleanup();
          process.exit(130);
        }
        if (code === 8 || code === 127) {                  // Backspace / DEL
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (code >= 32 && code < 127) {                    // printable ASCII
          buf += ch;
          process.stdout.write('*');
        }
        // Other control chars (esc sequences, arrow keys, etc.) silently ignored.
      }
    };

    stdin.on('data', onData);
  });
}

export async function promptYesNo(
  rl: RL,
  question: string,
  defaultValue = true,
): Promise<boolean> {
  const hint = defaultValue ? '[Y/n]' : '[y/N]';
  while (true) {
    const raw = (await rl.question(`${question} ${hint}: `)).trim().toLowerCase();
    if (!raw) return defaultValue;
    if (['y', 'yes'].includes(raw)) return true;
    if (['n', 'no'].includes(raw)) return false;
    console.log('  Please answer y or n.');
  }
}

export interface Choice<T> {
  /** Display label. */
  label: string;
  /** Optional one-line subtitle shown below the label. */
  description?: string;
  /** Returned when this choice is picked. */
  value: T;
}

/**
 * Numbered single-select. Returns the picked Choice's value. The first choice
 * is the default — Enter accepts it.
 */
export async function promptChoice<T>(
  rl: RL,
  question: string,
  choices: Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  if (choices.length === 0) throw new Error('promptChoice: empty choices');
  if (choices.length === 1) return choices[0]!.value;

  console.log('');
  choices.forEach((c, i) => {
    const marker = i === defaultIndex ? '*' : ' ';
    console.log(`  ${marker} ${i + 1}) ${c.label}`);
    if (c.description) console.log(`       ${c.description}`);
  });

  while (true) {
    const raw = (await rl.question(`${question} [1-${choices.length}, default ${defaultIndex + 1}]: `)).trim();
    if (!raw) return choices[defaultIndex]!.value;
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= choices.length) return choices[n - 1]!.value;
    console.log(`  Enter a number between 1 and ${choices.length}.`);
  }
}
