import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../../src/index/schema.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import { recall, whyNot } from '../../src/recall/query.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import { runExport } from '../../src/export/exportRun.ts';

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

// A distinctive term the decoys never use, so BM25's IDF stays well above zero for this one note.
const TOMBSTONE_TERM = 'tombstonable';
const TOMBSTONABLE_NOTE = {
  kind: 'note_revision',
  schema_version: 1,
  note_id: 'curated:01J8X9F1TZ6R3M8N0P5Q7S9TOMB',
  revision_id: '01J8X9F1TZ6R3M8N0P5Q7S9TOMBA',
  created_at: '2026-07-05T10:00:00.000Z',
  identity: { mode: 'deterministic', key: 'tombstonable-note' },
  source: { origin: 'human', distiller: 'human' },
  note_type: 'curated',
  title: 'A tombstonable curated note about tombstonable things',
  scope: { project_slug: 'librarian' },
  provenance: {},
  links: [],
  body: { summary: 'This tombstonable note exists to be retired by a later tombstone.' },
};

// Recency decay is anchored near the notes' created_at, and enough decoys are indexed that
// FTS5's bm25() yields a nonzero relevance for TOMBSTONE_TERM (mirrors the recall test corpus).
const NOW = '2026-07-05T12:00:00.000Z';

function seedDecoyNotes(dataDir: string): void {
  for (let i = 0; i < 5; i += 1) {
    appendNote(dataDir, {
      ...VALID_NOTE,
      note_id: `decoy:${i}`,
      revision_id: `decoy-rev-${i}`,
      title: `unrelated filler note ${i}`,
      body: { summary: `unrelated filler content ${i}` },
    });
  }
}

test('a note is indexed, then a newer tombstone removes it from BOTH notes_fts and recall', () => {
  const dataDir = tempDataDir();
  const cursorPath = path.join(dataDir, 'cursor.json');
  seedDecoyNotes(dataDir);
  appendNote(dataDir, TOMBSTONABLE_NOTE);

  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, dataDir, cursorPath);

  // Precondition: the revision really is indexed and really is recallable, so the post-tombstone
  // absence assertions below are meaningful rather than vacuously true.
  const before = db.prepare('SELECT COUNT(*) as count FROM notes_fts WHERE note_id = ?').get(TOMBSTONABLE_NOTE.note_id) as {
    count: number;
  };
  assert.equal(before.count, 1);
  const recallBefore = recall(db, TOMBSTONE_TERM, { projectSlug: 'librarian' }, undefined, NOW);
  assert.equal(recallBefore.length, 1);
  assert.equal(recallBefore[0].note_id, TOMBSTONABLE_NOTE.note_id);

  // Append a tombstone newer than the revision, then re-run the full-rescan indexer.
  appendNote(dataDir, {
    kind: 'note_tombstone',
    schema_version: 1,
    note_id: TOMBSTONABLE_NOTE.note_id,
    revision_id: '01J8X9F1TZ6R3M8N0P5Q7S9TOMBSTONE',
    previous_revision_id: TOMBSTONABLE_NOTE.revision_id,
    reason: 'curated rename retired this note_id',
    created_at: '2026-07-05T11:00:00.000Z',
    source: { kind: 'human' },
  });
  indexNotes(db, dataDir, cursorPath);

  // DoD: absence asserted via a direct notes_fts query AND via recall(..., { global: true }).
  const after = db.prepare('SELECT COUNT(*) as count FROM notes_fts WHERE note_id = ?').get(TOMBSTONABLE_NOTE.note_id) as {
    count: number;
  };
  assert.equal(after.count, 0);
  const recallAfter = recall(db, TOMBSTONE_TERM, { projectSlug: 'librarian' }, undefined, NOW);
  assert.deepEqual(recallAfter, []);
});

test('a revision newer than a tombstone re-indexes the note (latest-wins is symmetric)', () => {
  const dataDir = tempDataDir();
  const cursorPath = path.join(dataDir, 'cursor.json');
  seedDecoyNotes(dataDir);
  appendNote(dataDir, TOMBSTONABLE_NOTE);

  // Tombstone at 11:00 retires the 10:00 revision...
  appendNote(dataDir, {
    kind: 'note_tombstone',
    schema_version: 1,
    note_id: TOMBSTONABLE_NOTE.note_id,
    revision_id: '01J8X9F1TZ6R3M8N0P5Q7S9TOMBSTONE',
    previous_revision_id: TOMBSTONABLE_NOTE.revision_id,
    created_at: '2026-07-05T11:00:00.000Z',
    source: { kind: 'human' },
  });
  // ...but a revision at 12:00 is newer, so the note must come back.
  appendNote(dataDir, {
    ...TOMBSTONABLE_NOTE,
    revision_id: '01J8X9F1TZ6R3M8N0P5Q7S9REVIVED',
    previous_revision_id: TOMBSTONABLE_NOTE.revision_id,
    created_at: '2026-07-05T12:00:00.000Z',
    title: 'The tombstonable note, revived after its tombstone',
  });

  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, dataDir, cursorPath);

  const row = db.prepare('SELECT revision_id FROM notes_fts WHERE note_id = ?').get(TOMBSTONABLE_NOTE.note_id) as
    | { revision_id: string }
    | undefined;
  assert.ok(row, 'a revision newer than the tombstone must be re-indexed');
  assert.equal(row.revision_id, '01J8X9F1TZ6R3M8N0P5Q7S9REVIVED');
  const recalled = recall(db, TOMBSTONE_TERM, { projectSlug: 'librarian' }, undefined, '2026-07-05T13:00:00.000Z');
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].note_id, TOMBSTONABLE_NOTE.note_id);
});

test('a supersession retains the revision in the index with its interval closed', () => {
  const dataDir = tempDataDir();
  appendNote(dataDir, TOMBSTONABLE_NOTE);
  appendNote(dataDir, {
    kind: 'note_supersession', schema_version: 1, note_id: TOMBSTONABLE_NOTE.note_id,
    superseded_by: 'curated:replacement', revision_id: 'supersession-rev',
    created_at: '2026-07-05T11:00:00.000Z', source: { kind: 'cli' },
  });
  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, dataDir);

  const row = db.prepare('SELECT revision_id, invalid_at FROM notes_fts WHERE note_id = ?').get(TOMBSTONABLE_NOTE.note_id) as {
    revision_id: string; invalid_at: string;
  };
  assert.equal(row.revision_id, TOMBSTONABLE_NOTE.revision_id, 'annotation must not displace the revision');
  assert.equal(row.invalid_at, '2026-07-05T11:00:00.000Z');
  assert.deepEqual(recall(db, TOMBSTONE_TERM, { projectSlug: 'librarian' }, undefined, NOW), []);
});

test('a supersession does not create or remove a vault file', () => {
  const dataDir = tempDataDir();
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersession-vault-'));
  appendNote(dataDir, TOMBSTONABLE_NOTE);
  assert.equal(runExport({ dataDir, vaultDir }).exported, 1);
  const generated = path.join(vaultDir, 'generated', 'curated', 'curated-01J8X9F1TZ6R3M8N0P5Q7S9TOMB.md');
  const before = fs.readFileSync(generated, 'utf8');

  appendNote(dataDir, {
    kind: 'note_supersession', schema_version: 1, note_id: TOMBSTONABLE_NOTE.note_id,
    superseded_by: 'curated:replacement', revision_id: 'supersession-rev',
    created_at: '2026-07-05T11:00:00.000Z', source: { kind: 'cli' },
  });
  assert.deepEqual(runExport({ dataDir, vaultDir }), { exported: 0, removed: 0 });
  assert.equal(fs.readFileSync(generated, 'utf8'), before);
});

test('a flag does not create or remove a vault file (#106)', () => {
  const dataDir = tempDataDir();
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-vault-'));
  appendNote(dataDir, TOMBSTONABLE_NOTE);
  assert.equal(runExport({ dataDir, vaultDir }).exported, 1);
  const generated = path.join(vaultDir, 'generated', 'curated', 'curated-01J8X9F1TZ6R3M8N0P5Q7S9TOMB.md');
  const before = fs.readFileSync(generated, 'utf8');

  appendNote(dataDir, {
    kind: 'note_flag', schema_version: 1, note_id: TOMBSTONABLE_NOTE.note_id,
    revision_id: 'flag-rev', created_at: '2026-07-05T11:00:00.000Z',
    reason: 'flagged wrong', source: { kind: 'cli' },
  });
  // Validity-close-only: mints no content, resolves to the same revision, so the
  // export delta touches nothing — exported: 0, and the file is byte-unchanged.
  assert.deepEqual(runExport({ dataDir, vaultDir }), { exported: 0, removed: 0 });
  assert.equal(fs.readFileSync(generated, 'utf8'), before);
});

// A close (flag/supersession) applies only to revisions it post-dates; a newer revision re-opens
// the note (spec 12.2/12.12 amendment 2026-07-19). These fixtures pin that behavior and its edges.

function flag(noteId: string, createdAt: string, revisionId = `flag-${createdAt}`) {
  return { kind: 'note_flag', schema_version: 1, note_id: noteId, revision_id: revisionId, created_at: createdAt, reason: 'wrong', source: { kind: 'cli' } };
}
function revisionAt(createdAt: string, revisionId: string) {
  return { ...TOMBSTONABLE_NOTE, revision_id: revisionId, previous_revision_id: TOMBSTONABLE_NOTE.revision_id, created_at: createdAt };
}
function freshIndex(dataDir: string, cursorPath?: string): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, dataDir, cursorPath);
  return db;
}
function ships(db: Database.Database, at = '2026-07-06T00:00:00.000Z'): boolean {
  return recall(db, TOMBSTONE_TERM, { projectSlug: 'librarian' }, undefined, at).some((r) => r.note_id === TOMBSTONABLE_NOTE.note_id);
}

test('flag -> newer revision re-opens the note for recall (#106 re-open rule)', () => {
  const dataDir = tempDataDir();
  seedDecoyNotes(dataDir);
  appendNote(dataDir, TOMBSTONABLE_NOTE);                                   // 10:00 revision
  appendNote(dataDir, flag(TOMBSTONABLE_NOTE.note_id, '2026-07-05T11:00:00.000Z')); // 11:00 flag closes it
  appendNote(dataDir, revisionAt('2026-07-05T12:00:00.000Z', 'reopen-rev'));        // 12:00 revision re-opens

  const db = freshIndex(dataDir);
  const row = db.prepare('SELECT invalid_at, invalidation_kind FROM notes_fts WHERE note_id = ?').get(TOMBSTONABLE_NOTE.note_id) as
    | { invalid_at: string | null; invalidation_kind: string | null } | undefined;
  assert.ok(row, 'the re-opening revision must be indexed');
  assert.equal(row.invalid_at, null, 'a newer revision clears the flag close');
  assert.equal(row.invalidation_kind, null);
  assert.ok(ships(db), 'the re-opened note must ship in recall again');
});

test('flag -> newer revision -> newer flag closes it again (#106)', () => {
  const dataDir = tempDataDir();
  seedDecoyNotes(dataDir);
  appendNote(dataDir, TOMBSTONABLE_NOTE);                                   // 10:00
  appendNote(dataDir, flag(TOMBSTONABLE_NOTE.note_id, '2026-07-05T11:00:00.000Z', 'flag-a'));
  appendNote(dataDir, revisionAt('2026-07-05T12:00:00.000Z', 'reopen-rev'));
  appendNote(dataDir, flag(TOMBSTONABLE_NOTE.note_id, '2026-07-05T13:00:00.000Z', 'flag-b')); // newer flag

  const db = freshIndex(dataDir);
  assert.ok(!ships(db, '2026-07-05T14:00:00.000Z'), 'a flag newer than the re-opening revision closes it again');
  const row = db.prepare('SELECT invalidation_kind FROM notes_fts WHERE note_id = ?').get(TOMBSTONABLE_NOTE.note_id) as { invalidation_kind: string | null };
  assert.equal(row.invalidation_kind, 'flag');
});

test('adversarial replay: revision -> flag -> newer revision -> newer flag ends CLOSED (single-row state)', () => {
  // The single note_state row keeps one close (earliest effective). This pins that the timestamp
  // rule survives the sequence the reviewer flagged: the note must end closed, not spuriously open.
  const dataDir = tempDataDir();
  seedDecoyNotes(dataDir);
  appendNote(dataDir, revisionAt('2026-07-05T10:00:00.000Z', 'rev-1'));
  appendNote(dataDir, flag(TOMBSTONABLE_NOTE.note_id, '2026-07-05T10:30:00.000Z', 'flag-1'));
  appendNote(dataDir, revisionAt('2026-07-05T11:00:00.000Z', 'rev-2'));
  appendNote(dataDir, flag(TOMBSTONABLE_NOTE.note_id, '2026-07-05T11:30:00.000Z', 'flag-2'));

  const db = freshIndex(dataDir);
  assert.ok(!ships(db, '2026-07-05T12:00:00.000Z'), 'the newest flag post-dates the newest revision → closed');
});

test('a close older than the current winning revision is void (#106)', () => {
  // Revision at 12:00 is already the winner; a flag at 11:00 (older) must not close it.
  const dataDir = tempDataDir();
  seedDecoyNotes(dataDir);
  appendNote(dataDir, revisionAt('2026-07-05T12:00:00.000Z', 'rev-late'));
  appendNote(dataDir, flag(TOMBSTONABLE_NOTE.note_id, '2026-07-05T11:00:00.000Z', 'stale-flag'));

  const db = freshIndex(dataDir);
  assert.ok(ships(db, '2026-07-05T13:00:00.000Z'), 'a flag predating the winning revision is void');
});

test('placeholder ordering: a flag newer than its revision still excludes when indexed first (#106)', () => {
  // The flag is appended BEFORE the revision it closes, but carries a newer timestamp — it must win.
  const dataDir = tempDataDir();
  seedDecoyNotes(dataDir);
  appendNote(dataDir, flag(TOMBSTONABLE_NOTE.note_id, '2026-07-05T11:00:00.000Z')); // placeholder close
  appendNote(dataDir, TOMBSTONABLE_NOTE);                                            // 10:00 revision arrives after

  const db = freshIndex(dataDir);
  assert.ok(!ships(db), 'a flag newer than the revision must exclude regardless of index order');
  const row = db.prepare('SELECT invalidation_kind FROM notes_fts WHERE note_id = ?').get(TOMBSTONABLE_NOTE.note_id) as { invalidation_kind: string | null };
  assert.equal(row.invalidation_kind, 'flag');
});

test('supersede -> revise old note re-opens it (12.2 amendment: closes apply only to revisions they post-date)', () => {
  const dataDir = tempDataDir();
  seedDecoyNotes(dataDir);
  appendNote(dataDir, TOMBSTONABLE_NOTE);                                   // 10:00
  appendNote(dataDir, {
    kind: 'note_supersession', schema_version: 1, note_id: TOMBSTONABLE_NOTE.note_id,
    superseded_by: 'curated:replacement', revision_id: 'supersession-rev',
    created_at: '2026-07-05T11:00:00.000Z', source: { kind: 'cli' },
  });
  appendNote(dataDir, revisionAt('2026-07-05T12:00:00.000Z', 'revised-rev')); // human revises the old note

  const db = freshIndex(dataDir);
  assert.ok(ships(db, '2026-07-05T13:00:00.000Z'), 'a revision newer than the supersession re-opens the old note');
});

test('why-not reports intrinsic invalid_at expiry as expired, not flagged (#106 finding 2)', () => {
  const dataDir = tempDataDir();
  seedDecoyNotes(dataDir);
  // A revision whose OWN validity window has closed — no flag, no supersession record exists.
  appendNote(dataDir, { ...TOMBSTONABLE_NOTE, revision_id: 'intrinsic-rev', invalid_at: '2026-07-05T11:00:00.000Z' });

  const db = freshIndex(dataDir);
  const result = whyNot(db, TOMBSTONE_TERM, TOMBSTONABLE_NOTE.note_id, { projectSlug: 'librarian' }, undefined, '2026-07-05T12:00:00.000Z');
  assert.equal(result.matched, true);
  assert.equal(result.gate, 'expired', 'intrinsic expiry must not be mislabeled as a human flag');
});

