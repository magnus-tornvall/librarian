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
   *
   * The range is BOTH ends: a delta that grew since the failing attempt (the
   * session kept appending, or the settle gate held it while it did) is a
   * different delta and gets a fresh budget, so a long hold can never make one
   * exhausted budget quarantine a day of events. `byte_end` is absent on cursors
   * written before it existed; such a budget simply restarts.
   */
  failed_attempts?: { byte_offset: number; byte_end?: number; count: number; last_error: string };
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
