import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { NoteRecord, NoteRevision } from '../note.ts';
import type { EmbeddingModel, EmbeddingProvider } from '../embedding/provider.ts';
import { assertEmbeddingIndexModel, setEmbeddingIndexModel } from './database.ts';

export function buildSearchText(note: NoteRevision): string {
  return [
    note.title,
    note.body.summary,
    ...(note.body.bullets ?? []),
    note.body.details ?? '',
    note.scope.project_slug ?? '',
    ...note.links.map((link) => link.target),
  ]
    .filter(Boolean)
    .join(' ');
}

function updateFts(db: Database.Database, noteId: string): boolean {
  const deleteStmt = db.prepare('DELETE FROM notes_fts WHERE note_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, valid_at, invalid_at, superseded_by, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const state = db.prepare('SELECT record_json, record_kind, superseded_at, superseded_by FROM note_state WHERE note_id = ?').get(noteId) as
    | { record_json: string; record_kind: string; superseded_at: string | null; superseded_by: string | null }
    | undefined;
  deleteStmt.run(noteId);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_vectors'").get() !== undefined) {
    db.prepare('DELETE FROM note_vectors WHERE note_id = ?').run(noteId);
  }
  if (!state || state.record_kind === 'note_tombstone') return false;
  const note = JSON.parse(state.record_json) as NoteRevision;
  // Delete first regardless of record kind: a tombstoned note must lose any existing row, and a
  // surviving revision is deleted-then-reinserted to upsert. This is how a tombstone removes a
  // note from the index (and therefore from recall) with no separate removal pass.
  if (!note.source?.origin) return false;

  let searchText: string;
  try { searchText = buildSearchText(note); } catch { return false; }

  // Scope columns carry §10.2 `scope` into the index so recall can enforce project
  // match / explicit global scope (§6). A note with neither project_slug nor global
  // is stored as project_slug='' + is_global=0 — recall can only reach it via a
  // matching project scope, never via a global query.
  const projectSlug = note.scope?.project_slug ?? '';
  const isGlobal = note.scope?.global === true ? 1 : 0;

  const supersessionWins = state.superseded_at !== null && (note.invalid_at === undefined || state.superseded_at <= note.invalid_at);
  const invalidAt = supersessionWins ? state.superseded_at : note.invalid_at ?? null;

  insertStmt.run(
      noteId,
      note.revision_id,
      note.source.origin,
      note.note_type,
      note.created_at,
      note.valid_at ?? note.created_at,
      invalidAt,
      supersessionWins ? state.superseded_by : null,
      projectSlug,
      isGlobal,
      searchText,
  );
  return true;
}

function vectorTableExists(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_vectors'").get() !== undefined;
}

function vectorDimension(db: Database.Database): number | undefined {
  const row = db.prepare("SELECT value FROM index_metadata WHERE key = 'embedding_dimensions'").get() as { value: string } | undefined;
  return row === undefined ? undefined : Number(row.value);
}

function createVectorTable(db: Database.Database, dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('embedding provider returned an empty vector');
  db.exec(`CREATE VIRTUAL TABLE note_vectors USING vec0(note_id TEXT PRIMARY KEY, embedding float[${dimensions}])`);
  db.prepare("INSERT INTO index_metadata (key, value) VALUES ('embedding_dimensions', ?)").run(String(dimensions));
}

/** Embed active FTS rows that have no vector. Individual provider failures leave rows for the next pass. */
export async function embedIndexedNotes(db: Database.Database, provider: EmbeddingProvider, model: EmbeddingModel): Promise<void> {
  assertEmbeddingIndexModel(db, model);
  setEmbeddingIndexModel(db, model);
  const rows = db.prepare(vectorTableExists(db)
    ? `SELECT note_id, search_text FROM notes_fts WHERE invalid_at IS NULL AND note_id NOT IN (SELECT note_id FROM note_vectors)`
    : 'SELECT note_id, search_text FROM notes_fts WHERE invalid_at IS NULL').all() as Array<{ note_id: string; search_text: string }>;
  for (const row of rows) {
    try {
      const vector = await provider.embed(row.search_text);
      const dimensions = vectorDimension(db);
      if (!vectorTableExists(db)) createVectorTable(db, vector.length);
      else if (dimensions !== vector.length) throw new Error(`embedding provider changed vector dimensions from ${dimensions} to ${vector.length}`);
      db.prepare('INSERT INTO note_vectors (note_id, embedding) VALUES (?, ?)').run(row.note_id, JSON.stringify(vector));
    } catch {
      // ponytail: retry failed embeddings on the next index pass; no separate retry store is needed.
    }
  }
}

function applyRecord(db: Database.Database, record: NoteRecord): boolean {
  const current = db.prepare('SELECT record_created_at, superseded_at FROM note_state WHERE note_id = ?').get(record.note_id) as
    | { record_created_at: string; superseded_at: string | null }
    | undefined;
  if (record.kind === 'note_supersession') {
    if (!current || current.superseded_at === null || record.created_at < current.superseded_at) {
      if (current) {
        db.prepare('UPDATE note_state SET superseded_at = ?, superseded_by = ? WHERE note_id = ?').run(record.created_at, record.superseded_by, record.note_id);
      } else {
        db.prepare('INSERT INTO note_state (note_id, record_json, record_kind, record_created_at, superseded_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(record.note_id, '{}', 'note_supersession', '', record.created_at, record.superseded_by);
      }
      return current ? updateFts(db, record.note_id) : false;
    }
    return false;
  }
  if (current && record.created_at < current.record_created_at) return false;
  db.prepare(`INSERT INTO note_state (note_id, record_json, record_kind, record_created_at, superseded_at, superseded_by)
    VALUES (?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(note_id) DO UPDATE SET record_json = excluded.record_json, record_kind = excluded.record_kind, record_created_at = excluded.record_created_at`)
    .run(record.note_id, JSON.stringify(record), record.kind, record.created_at);
  return updateFts(db, record.note_id);
}

function completeRecords(bytes: Buffer): { records: NoteRecord[]; consumed: number; lastId: string | null } {
  const end = bytes.lastIndexOf(10);
  if (end < 0) return { records: [], consumed: 0, lastId: null };
  const text = bytes.subarray(0, end + 1).toString('utf8');
  const records: NoteRecord[] = [];
  let lastId: string | null = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const record = JSON.parse(line) as NoteRecord;
    records.push(record);
    lastId = record.revision_id;
  }
  return { records, consumed: end + 1, lastId };
}

function readPending(file: string, offset: number): Buffer {
  const end = fs.statSync(file).size;
  if (offset > end) throw new Error(`index cursor exceeds ${file}`);
  const bytes = Buffer.alloc(end - offset);
  if (bytes.length === 0) return bytes;
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, bytes, 0, bytes.length, offset);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function indexNotes(db: Database.Database, dataDir: string): number {
  const notesDir = path.join(dataDir, 'notes');
  const segments = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter((name) => name.endsWith('.ndjson')).sort() : [];
  let cursor: { segment: string; byte_offset: number; data_dir: string } | undefined;
  let indexed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    cursor = db.prepare('SELECT segment, byte_offset, data_dir FROM index_cursor WHERE id = 1').get() as typeof cursor;
    if (cursor && (cursor.data_dir !== dataDir || !segments.includes(cursor.segment) || cursor.byte_offset > fs.statSync(path.join(notesDir, cursor.segment)).size)) {
      db.exec('DELETE FROM notes_fts; DELETE FROM note_state; DELETE FROM index_cursor;');
      cursor = undefined;
    }
    const start = cursor ? segments.indexOf(cursor.segment) : 0;
    for (let i = Math.max(0, start); i < segments.length; i += 1) {
      const segment = segments[i];
      const file = path.join(notesDir, segment);
      const offset = cursor && i === start ? cursor.byte_offset : 0;
      const bytes = readPending(file, offset);
      const parsed = completeRecords(bytes);
      for (const record of parsed.records) if (applyRecord(db, record)) indexed += 1;
      if (parsed.consumed > 0) {
        db.prepare(`INSERT INTO index_cursor (id, segment, byte_offset, last_record_id, updated_at, data_dir) VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET segment = excluded.segment, byte_offset = excluded.byte_offset, last_record_id = excluded.last_record_id, updated_at = excluded.updated_at, data_dir = excluded.data_dir`)
          .run(segment, offset + parsed.consumed, parsed.lastId, new Date().toISOString(), dataDir);
      }
      // Preserve an incomplete trailing line for a later pass rather than moving
      // the singleton cursor into a newer segment and losing those bytes.
      if (parsed.consumed < bytes.length) break;
    }
    db.exec('COMMIT');
    return indexed;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
