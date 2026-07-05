import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCursor, advanceCursor, type Cursor } from '../../src/log/cursor.ts';

function tempCursorPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-test-'));
  return path.join(dir, 'nested', 'cursor.json');
}

test('reading a nonexistent cursor returns null', () => {
  assert.equal(readCursor(tempCursorPath()), null);
});

test('write then read round-trips all fields', () => {
  const cursorPath = tempCursorPath();
  const cursor: Cursor = {
    consumer: 'indexer',
    log_name: 'notes',
    file_path: '/tmp/notes/2026-07.ndjson',
    byte_offset: 128,
    last_record_id: 'rec-1',
    updated_at: '2026-07-05T00:00:00.000Z',
  };
  advanceCursor(cursorPath, cursor);
  assert.deepEqual(readCursor(cursorPath), cursor);
});

test('writing twice overwrites rather than appends', () => {
  const cursorPath = tempCursorPath();
  const first: Cursor = {
    consumer: 'indexer',
    log_name: 'notes',
    file_path: '/tmp/notes/2026-07.ndjson',
    byte_offset: 0,
    updated_at: '2026-07-05T00:00:00.000Z',
  };
  const second: Cursor = { ...first, byte_offset: 256, updated_at: '2026-07-05T01:00:00.000Z' };
  advanceCursor(cursorPath, first);
  advanceCursor(cursorPath, second);
  assert.deepEqual(readCursor(cursorPath), second);
});
