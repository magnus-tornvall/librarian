import { appendRecord } from '../log/ndjson.ts';
import { redact } from '../redact.ts';
import { validateEvent } from './validateEvent.ts';
import os from 'node:os';

const HOME_PATH = new RegExp(`${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\\\/])`, 'g');

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

  validateEvent(redacted);
  appendRecord(logFilePath, redacted);
}
