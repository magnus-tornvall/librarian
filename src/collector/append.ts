import { appendRecord } from '../log/ndjson.ts';
import { redact, redactOutput } from '../redact.ts';
import { validateEvent } from './validateEvent.ts';
import os from 'node:os';

/**
 * Head+tail cap per captured output stream. "Verbatim" is the contract for what an outcome
 * *says* — it is not a commitment to archive an unbounded `cat big.log`. One such command
 * would put megabytes on a permanent NDJSON line that `readAll` slurps whole for every
 * consumer. Head and tail both survive because a command's invocation and its error sit at
 * opposite ends of the output.
 */
const MAX_STREAM_CHARS = 64 * 1024;

/** Cap one stream, naming what was dropped so a reader never mistakes an elision for the
 *  whole output. Applied AFTER redaction — truncating first could split a secret across the
 *  cut and leave half of it unmatched. */
function capStream(text: string): string {
  if (text.length <= MAX_STREAM_CHARS) {
    return text;
  }
  const half = MAX_STREAM_CHARS / 2;
  const dropped = text.length - MAX_STREAM_CHARS;
  return `${text.slice(0, half)}\n…[${dropped} characters elided]…\n${text.slice(-half)}`;
}

// A home path is only a home path where one can start: at the beginning of the string or
// after a separator character. The lookbehind keeps a directory that merely *contains* the
// home path (`/mnt/backup/Users/me`, or `packages/root/x` when $HOME is `/root`) from being
// rewritten into a bogus `~` — corruption that would be as permanent as the leak this guards.
const HOME_PATH = new RegExp(`(?<![\\w.~-])${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\\\/])`, 'g');

function normalizeHomePaths(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(HOME_PATH, '~');
  if (Array.isArray(value)) return value.map(normalizeHomePaths);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeHomePaths(entry)]));
  }
  return value;
}

export async function appendEvent(logFilePath: string, event: Record<string, unknown>): Promise<void> {
  const normalized = event; // ponytail: normalize is a no-op until instrumentation adapters exist

  const redacted = normalizeHomePaths(normalized) as Record<string, unknown>;
  if (typeof redacted.command === 'string') {
    redacted.command = await redact(redacted.command);
  }
  if (typeof redacted.prompt === 'string') {
    redacted.prompt = await redact(redacted.prompt);
  }
  // Command output arrives with no `<private>` markup — nobody tagged it — so the patterns
  // are the only guard it gets, on the same non-retrofittable boundary. `redactOutput` is
  // the machine-text variant (see redact.ts). `redacted` is the fresh deep copy
  // normalizeHomePaths returned, so mutating in place cannot touch the input.
  if (typeof redacted.outcome === 'object' && redacted.outcome !== null) {
    const outcome = redacted.outcome as Record<string, unknown>;
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = outcome[stream];
      if (typeof text === 'string') {
        outcome[stream] = capStream(await redactOutput(text));
      }
    }
  }

  validateEvent(redacted);
  appendRecord(logFilePath, redacted);
}
