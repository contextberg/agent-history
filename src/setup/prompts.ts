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
 * Hidden-input prompt for API keys. Echoes nothing while typing.
 *
 * readline doesn't expose a "no echo" mode, so we monkey-patch the output
 * stream's write() during the question. Falls back to plain prompt if stdin
 * is not a TTY — unattended scripts can pipe the key in without losing it.
 */
export async function promptApiKey(rl: RL, question: string): Promise<string> {
  if (!input.isTTY) {
    return prompt(rl, question);
  }
  const stdout = output as NodeJS.WriteStream & { _orig_write?: typeof output.write };
  stdout._orig_write = stdout.write.bind(stdout);
  process.stdout.write(`${question}: `);
  // Override write to swallow echoed characters.
  // readline calls output.write with the typed character on each keypress.
  let done = false;
  stdout.write = ((chunk: string | Buffer): boolean => {
    if (done) return stdout._orig_write!(chunk);
    // Allow newlines through so the prompt advances visually.
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('\n') || str.includes('\r')) return stdout._orig_write!('\n');
    return true;
  }) as typeof stdout.write;

  try {
    const raw = await rl.question('');
    return raw.trim();
  } finally {
    done = true;
    stdout.write = stdout._orig_write!;
  }
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
