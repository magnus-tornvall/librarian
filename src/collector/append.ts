import { appendRecord } from '../log/ndjson.ts';
import { redact } from '../redact.ts';
import { validateEvent } from './validateEvent.ts';

export function appendEvent(logFilePath: string, event: Record<string, unknown>): void {
  const normalized = event; // ponytail: normalize is a no-op until instrumentation adapters exist

  const redacted = { ...normalized };
  if (typeof redacted.command === 'string') {
    redacted.command = redact(redacted.command);
  }
  if (typeof redacted.prompt === 'string') {
    redacted.prompt = redact(redacted.prompt);
  }

  validateEvent(redacted);
  appendRecord(logFilePath, redacted);
}
