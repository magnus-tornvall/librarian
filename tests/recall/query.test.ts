import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../../src/index/schema.ts';
import { recall } from '../../src/recall/query.ts';

const NOW = '2026-07-05T00:00:00.000Z';

function seededDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, search_text) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('note-1', 'rev-1', 'human', 'curated', '2026-07-01T00:00:00.000Z', 'librarian recall scoring pipeline');
  // Decoy rows: FTS5's bm25() IDF term collapses to ~0 in a tiny corpus where a term
  // appears in half the documents, so a realistic-sized corpus is needed for a nonzero score.
  for (let i = 0; i < 5; i += 1) {
    insert.run(`decoy-${i}`, `decoy-rev-${i}`, 'human', 'fact', '2026-07-01T00:00:00.000Z', `unrelated filler content ${i}`);
  }
  return db;
}

test('a matching note is returned with { global: true }', () => {
  const db = seededDb();
  const results = recall(db, 'librarian', { global: true }, undefined, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].note_id, 'note-1');
});

test('{} (neither project nor global) returns [] even when the note would match', () => {
  const db = seededDb();
  const results = recall(db, 'librarian', {}, undefined, NOW);
  assert.deepEqual(results, []);
});

test('a no-match query returns [], not an error', () => {
  const db = seededDb();
  const results = recall(db, 'nonexistenttermxyz', { global: true }, undefined, NOW);
  assert.deepEqual(results, []);
});
