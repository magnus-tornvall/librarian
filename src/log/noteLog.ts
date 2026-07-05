import fs from 'node:fs';
import path from 'node:path';
import { appendRecord, readAll } from './ndjson.ts';

function segmentPath(dataDir: string, note: Record<string, unknown>): string {
  const yearMonth = (note.created_at as string).slice(0, 7);
  return path.join(dataDir, 'notes', `${yearMonth}.ndjson`);
}

export function appendNote(dataDir: string, note: Record<string, unknown>): void {
  appendRecord(segmentPath(dataDir, note), note);
}

export function readAllNotes(dataDir: string): unknown[] {
  const notesDir = path.join(dataDir, 'notes');
  if (!fs.existsSync(notesDir)) {
    return [];
  }
  return fs
    .readdirSync(notesDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .flatMap((name) => readAll(path.join(notesDir, name)));
}
