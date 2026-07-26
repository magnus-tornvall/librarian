import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

/**
 * Shared prompt layer for the interactive surfaces (`init` now, the settings
 * menu #153 next). Reads lines from stdin via readline's async iterator — which
 * *queues* lines, so a scripted, non-interactive run is just newline-delimited
 * answers piped in on stdin (the event-based `.question()` drops buffered lines;
 * the iterator does not). EOF/blank falls back to the stated default.
 */
export type Prompter = {
  ask(question: string, fallback?: string): Promise<string>;
  select<T extends string>(question: string, options: readonly T[], fallback: T): Promise<T>;
  confirm(question: string, fallbackYes: boolean): Promise<boolean>;
  say(text: string): void;
  close(): void;
};

export function stdioPrompter(input: Readable = process.stdin, output: Writable = process.stdout): Prompter {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => {
    const { value, done } = await lines.next();
    return done ? '' : String(value);
  };
  const say = (text: string): void => { output.write(`${text}\n`); };
  return {
    async ask(question, fallback = '') {
      output.write(`${question}${fallback ? ` [${fallback}]` : ''}: `);
      const answer = (await nextLine()).trim();
      return answer || fallback;
    },
    async select(question, options, fallback) {
      say(question);
      options.forEach((opt, i) => say(`  ${i + 1}) ${opt}${opt === fallback ? ' (default)' : ''}`));
      output.write('> ');
      const raw = (await nextLine()).trim();
      if (!raw) return fallback;
      const index = Number.parseInt(raw, 10);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
      return options.find((opt) => opt.toLowerCase() === raw.toLowerCase()) ?? fallback;
    },
    async confirm(question, fallbackYes) {
      output.write(`${question} ${fallbackYes ? '[Y/n]' : '[y/N]'} `);
      const answer = (await nextLine()).trim().toLowerCase();
      return answer ? answer.startsWith('y') : fallbackYes;
    },
    say,
    close() { rl.close(); },
  };
}
