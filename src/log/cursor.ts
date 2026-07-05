import fs from 'node:fs';
import path from 'node:path';

export type Cursor = {
  consumer: string;
  log_name: string;
  file_path: string;
  byte_offset: number;
  last_record_id?: string;
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
