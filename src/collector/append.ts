import { appendRecord } from '../log/ndjson.ts';
import { redact } from '../redact.ts';
import { validateEvent } from './validateEvent.ts';
import os from 'node:os';

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

export function appendEvent(logFilePath: string, event: Record<string, unknown>): void {
  const normalized = event; // ponytail: normalize is a no-op until instrumentation adapters exist

  const redacted = normalizeHomePaths(normalized) as Record<string, unknown>;
  if (typeof redacted.command === 'string') {
    redacted.command = redact(redacted.command);
  }
  if (typeof redacted.prompt === 'string') {
    redacted.prompt = redact(redacted.prompt);
  }
  // Command output arrives with no `<private>` markup — nobody tagged it — so the patterns
  // are the only guard it gets, on the same non-retrofittable boundary. `redacted` is the
  // fresh deep copy normalizeHomePaths returned, so mutating in place cannot touch the input.
  if (typeof redacted.outcome === 'object' && redacted.outcome !== null) {
    const outcome = redacted.outcome as Record<string, unknown>;
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = outcome[stream];
      if (typeof text === 'string') {
        outcome[stream] = redact(text);
      }
    }
  }

  validateEvent(redacted);
  appendRecord(logFilePath, redacted);
}
