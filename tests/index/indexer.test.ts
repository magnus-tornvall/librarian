import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../../src/index/schema.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import { appendNote } from '../../src/log/noteLog.ts';

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));
}

const VALID_NOTE = {
  kind: 'note_revision',
  schema_version: 1,
  note_id: 'decision:01J8X9F1TZ6R3M8N0P5Q7S9VWX',
  revision_id: '01J8X9F1TZ6R3M8N0P5Q7S9VWY',
  created_at: '2026-07-05T10:00:00.000Z',
  identity: { mode: 'episodic' },
  source: { origin: 'opencode', distiller: 'llm', model: 'claude-sonnet-5', agent: 'opencode' },
  note_type: 'decision',
  title: 'Adopt BM25-over-SQLite-FTS5 as the sole recall index',
  scope: { project_slug: 'librarian' },
  provenance: {},
  links: [],
  body: {
    summary: 'BM25 over SQLite FTS5 is the one blessed index for v1; no recall provider abstraction.',
    bullets: ['Schema must not block later vector search, but nothing more is built now.'],
  },
};

const NOTE_MISSING_ORIGIN = {
  kind: 'note_revision',
  schema_version: 1,
  note_id: 'decision:01J8X9F1TZ6R3M8N0P5Q7S9ORIGIN',
  revision_id: '01J8X9F1TZ6R3M8N0P5Q7S9ORIY',
  created_at: '2026-07-05T11:00:00.000Z',
  identity: { mode: 'episodic' },
  source: { distiller: 'llm', model: 'claude-sonnet-5', agent: 'opencode' },
  note_type: 'decision',
  title: 'A note that should never be indexed',
  scope: {},
  provenance: {},
  links: [],
  body: { summary: 'This note is missing source.origin and must be fail-closed skipped.' },
};

test('a note missing source.origin is skipped; only the valid note gets indexed', () => {
  const dataDir = tempDataDir();
  const cursorPath = path.join(dataDir, 'cursor.json');
  appendNote(dataDir, VALID_NOTE);
  appendNote(dataDir, NOTE_MISSING_ORIGIN);

  const db = new Database(':memory:');
  migrate(db);
  const indexedCount = indexNotes(db, dataDir, cursorPath);

  const { count } = db.prepare('SELECT COUNT(*) as count FROM notes_fts').get() as { count: number };
  assert.equal(count, 1);
  assert.equal(indexedCount, 1);

  const row = db.prepare('SELECT search_text FROM notes_fts WHERE note_id = ?').get(VALID_NOTE.note_id) as {
    search_text: string;
  };
  assert.match(row.search_text, /Adopt BM25-over-SQLite-FTS5 as the sole recall index/);
  assert.match(row.search_text, /BM25 over SQLite FTS5 is the one blessed index/);
});

test('a note with a malformed body is skipped without aborting the rest of the batch', () => {
  const dataDir = tempDataDir();
  const cursorPath = path.join(dataDir, 'cursor.json');
  const malformedNote = { ...VALID_NOTE, note_id: 'decision:malformed', body: null };
  appendNote(dataDir, malformedNote);
  appendNote(dataDir, VALID_NOTE);

  const db = new Database(':memory:');
  migrate(db);
  const indexedCount = indexNotes(db, dataDir, cursorPath);

  assert.equal(indexedCount, 1);
  const { count } = db.prepare('SELECT COUNT(*) as count FROM notes_fts').get() as { count: number };
  assert.equal(count, 1);
});

test('when two revisions of the same note_id share a created_at, the later-appended one wins', () => {
  const dataDir = tempDataDir();
  const cursorPath = path.join(dataDir, 'cursor.json');
  const revisionOne = { ...VALID_NOTE, revision_id: 'rev-1', title: 'first revision' };
  const revisionTwo = { ...VALID_NOTE, revision_id: 'rev-2', title: 'second revision' };
  appendNote(dataDir, revisionOne);
  appendNote(dataDir, revisionTwo);

  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, dataDir, cursorPath);

  const row = db.prepare('SELECT revision_id FROM notes_fts WHERE note_id = ?').get(VALID_NOTE.note_id) as {
    revision_id: string;
  };
  assert.equal(row.revision_id, 'rev-2');
});
