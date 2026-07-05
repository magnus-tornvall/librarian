import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendNote, readAllNotes } from '../../src/log/noteLog.ts';

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notelog-test-'));
}

test('notes in the same month land in one segment file, a different month starts a second', () => {
  const dataDir = tempDataDir();
  appendNote(dataDir, { id: 'a', created_at: '2026-07-01T00:00:00.000Z' });
  appendNote(dataDir, { id: 'b', created_at: '2026-07-15T00:00:00.000Z' });
  appendNote(dataDir, { id: 'c', created_at: '2026-08-01T00:00:00.000Z' });

  const segmentFiles = fs.readdirSync(path.join(dataDir, 'notes'));
  assert.equal(segmentFiles.length, 2);
  assert.deepEqual(segmentFiles.sort(), ['2026-07.ndjson', '2026-08.ndjson']);

  const all = readAllNotes(dataDir);
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((note) => (note as Record<string, unknown>).id),
    ['a', 'b', 'c'],
  );
});

test('readAllNotes returns an empty array when no notes exist', () => {
  const dataDir = tempDataDir();
  assert.deepEqual(readAllNotes(dataDir), []);
});
