import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openIndexRead, openIndexWrite } from '../../src/index/database.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import { recall } from '../../src/recall/query.ts';

function dirs(): { dataDir: string; indexDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-index-'));
  return { dataDir: path.join(root, 'data'), indexDir: path.join(root, 'index') };
}

const note = {
  kind: 'note_revision', schema_version: 1, note_id: 'fact:persistent', revision_id: 'rev-1',
  created_at: '2026-07-05T10:00:00.000Z', identity: { mode: 'episodic' },
  source: { origin: 'opencode', distiller: 'llm' }, note_type: 'fact', title: 'persistent narwhal',
  scope: { project_slug: 'librarian' }, provenance: {}, links: [], body: { summary: 'persistent narwhal recall' },
};

function appendDecoys(dataDir: string): void {
  for (let i = 0; i < 5; i += 1) {
    appendNote(dataDir, { ...note, note_id: `fact:decoy-${i}`, revision_id: `decoy-${i}`, title: `unrelated ${i}`, body: { summary: `unrelated ${i}` } });
  }
}

test('persistent index bootstraps, serves warm reads without the note log, and leaves an unchanged cursor alone', () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note);
  appendDecoys(dataDir);
  const write = openIndexWrite(indexDir);
  indexNotes(write, dataDir);
  const first = write.prepare('SELECT updated_at FROM index_cursor WHERE id = 1').get() as { updated_at: string };
  assert.equal(indexNotes(write, dataDir), 0);
  assert.equal((write.prepare('SELECT updated_at FROM index_cursor WHERE id = 1').get() as { updated_at: string }).updated_at, first.updated_at);
  write.close();
  fs.renameSync(path.join(dataDir, 'notes'), path.join(dataDir, 'notes-unavailable'));
  const read = openIndexRead(indexDir);
  assert.equal(recall(read, 'narwhal', { projectSlug: 'librarian' }, undefined, '2026-07-05T11:00:00.000Z')[0]?.note_id, note.note_id);
  read.close();
});

test('incremental revision, tombstone, and revival update persisted recall state', () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, note);
  appendDecoys(dataDir);
  const db = openIndexWrite(indexDir);
  indexNotes(db, dataDir);
  appendNote(dataDir, { ...note, revision_id: 'rev-2', created_at: '2026-07-05T11:00:00.000Z', title: 'revised narwhal' });
  indexNotes(db, dataDir);
  assert.equal((db.prepare('SELECT revision_id FROM notes_fts WHERE note_id = ?').get(note.note_id) as { revision_id: string }).revision_id, 'rev-2');
  appendNote(dataDir, { kind: 'note_tombstone', schema_version: 1, note_id: note.note_id, revision_id: 'dead', previous_revision_id: 'rev-2', created_at: '2026-07-05T12:00:00.000Z', source: { kind: 'cli' } });
  indexNotes(db, dataDir);
  assert.equal(recall(db, 'narwhal', { projectSlug: 'librarian' }, undefined, '2026-07-05T13:00:00.000Z').length, 0);
  appendNote(dataDir, { ...note, revision_id: 'rev-3', created_at: '2026-07-05T14:00:00.000Z' });
  indexNotes(db, dataDir);
  assert.equal(recall(db, 'narwhal', { projectSlug: 'librarian' }, undefined, '2026-07-05T15:00:00.000Z')[0]?.note_id, note.note_id);
  appendNote(dataDir, { kind: 'note_supersession', schema_version: 1, note_id: note.note_id, superseded_by: 'fact:replacement', revision_id: 'superseded', created_at: '2026-07-05T16:00:00.000Z', source: { kind: 'cli' } });
  indexNotes(db, dataDir);
  assert.equal(recall(db, 'narwhal', { projectSlug: 'librarian' }, undefined, '2026-07-05T17:00:00.000Z').length, 0);
  db.close();
});

test('month rollover waits for an incomplete trailing line before advancing the cursor', () => {
  const { dataDir, indexDir } = dirs();
  appendNote(dataDir, { ...note, note_id: 'fact:july', revision_id: 'july', created_at: '2026-07-31T23:00:00.000Z' });
  const august = { ...note, note_id: 'fact:august', revision_id: 'august', created_at: '2026-08-01T00:00:00.000Z' };
  const augustPath = path.join(dataDir, 'notes', '2026-08.ndjson');
  fs.mkdirSync(path.dirname(augustPath), { recursive: true });
  const serialized = JSON.stringify(august);
  fs.writeFileSync(augustPath, serialized.slice(0, -1));

  const db = openIndexWrite(indexDir);
  indexNotes(db, dataDir);
  assert.equal((db.prepare('SELECT segment FROM index_cursor WHERE id = 1').get() as { segment: string }).segment, '2026-07.ndjson');
  fs.appendFileSync(augustPath, serialized.slice(-1) + '\n');
  indexNotes(db, dataDir);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM notes_fts WHERE note_id = ?').get(august.note_id) as { count: number }).count, 1);
  db.close();
});
