import fs from 'node:fs';
import path from 'node:path';

export type Cursor = {
  consumer: string;
  log_name: string;
  file_path: string;
  byte_offset: number;
  last_record_id?: string;
  /**
   * Bounded-retry bookkeeping (§5, issue #60): when a consumer fails on the
   * delta AT `byte_offset`, it records the attempt here instead of a second
   * bookkeeping file. Survives a failed run so the next run knows how many times
   * this exact range has already been tried. Reset (omitted) whenever the offset
   * advances — a fresh range starts its count at zero.
   */
  failed_attempts?: { byte_offset: number; count: number; last_error: string };
  updated_at: string;
};

export function readCursor(cursorPath: string): Cursor | null {
  if (!fs.existsSync(cursorPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Cursor;
}

export function advanceCursor(cursorPath: string, cursor: Cursor): void {
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, JSON.stringify(cursor, null, 2));
}
