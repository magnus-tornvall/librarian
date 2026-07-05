import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../../src/index/schema.ts';

test('migrate creates notes_fts and accepts a row', () => {
  const db = new Database(':memory:');
  migrate(db);

  db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, search_text) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('note-1', 'rev-1', 'human', 'fact', '2026-07-01T00:00:00.000Z', 'hello world');

  const row = db.prepare('SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?').get('hello');
  assert.deepEqual(row, { note_id: 'note-1' });
});

test('migrate is idempotent', () => {
  const db = new Database(':memory:');
  migrate(db);
  assert.doesNotThrow(() => migrate(db));
});
