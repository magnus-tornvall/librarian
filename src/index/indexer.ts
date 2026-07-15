import Database from 'better-sqlite3';
import { readAllNotes } from '../log/noteLog.ts';
import { advanceCursor } from '../log/cursor.ts';
import { latestRecordPerNoteId, type NoteRecord, type NoteRevision } from '../note.ts';

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

export function indexNotes(db: Database.Database, dataDir: string, cursorPath?: string): number {
  // ponytail: v1 re-reads the whole note log and upserts by note_id instead of tracking a
  // true byte-offset cursor — cheap and correct at this scale; real incremental reads are
  // the eventual target per §5 once the log grows large enough to matter.
  const notes = readAllNotes(dataDir) as NoteRecord[];

  const deleteStmt = db.prepare('DELETE FROM notes_fts WHERE note_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, valid_at, invalid_at, superseded_by, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const supersessions = new Map<string, { created_at: string; superseded_by: string }>();
  for (const record of notes) {
    if (record.kind !== 'note_supersession') continue;
    const existing = supersessions.get(record.note_id);
    if (existing === undefined || record.created_at < existing.created_at) {
      supersessions.set(record.note_id, { created_at: record.created_at, superseded_by: record.superseded_by });
    }
  }

  let indexedCount = 0;
  for (const note of latestRecordPerNoteId(notes)) {
    // Delete first regardless of record kind: a tombstoned note must lose any existing row, and a
    // surviving revision is deleted-then-reinserted to upsert. This is how a tombstone removes a
    // note from the index (and therefore from recall) with no separate removal pass.
    deleteStmt.run(note.note_id);

    if (note.kind === 'note_tombstone') {
      continue; // latest record is a tombstone: leave the note deleted, never re-index it
    }

    if (!note.source.origin) {
      continue; // fail-closed: missing origin is a hard skip, never indexed with a null origin
    }

    let searchText: string;
    try {
      searchText = buildSearchText(note);
    } catch {
      continue; // fail-closed: one malformed note must not crash indexing for every note after it
    }

    // Scope columns carry §10.2 `scope` into the index so recall can enforce project
    // match / explicit global scope (§6). A note with neither project_slug nor global
    // is stored as project_slug='' + is_global=0 — recall can only reach it via a
    // matching project scope, never via a global query.
    const projectSlug = note.scope.project_slug ?? '';
    const isGlobal = note.scope.global === true ? 1 : 0;

    const supersession = supersessions.get(note.note_id);
    const supersessionWins = supersession !== undefined && (note.invalid_at === undefined || supersession.created_at <= note.invalid_at);
    const invalidAt = supersessionWins ? supersession.created_at : note.invalid_at ?? null;

    insertStmt.run(
      note.note_id,
      note.revision_id,
      note.source.origin,
      note.note_type,
      note.created_at,
      note.valid_at ?? note.created_at,
      invalidAt,
      supersessionWins ? supersession.superseded_by : null,
      projectSlug,
      isGlobal,
      searchText,
    );
    indexedCount += 1;
  }

  if (cursorPath !== undefined) {
    advanceCursor(cursorPath, {
      consumer: 'indexer',
      log_name: 'notes',
      file_path: dataDir,
      byte_offset: 0,
      updated_at: new Date().toISOString(),
    });
  }

  return indexedCount;
}
