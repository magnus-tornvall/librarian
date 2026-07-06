import Database from 'better-sqlite3';
import { readAllNotes } from '../log/noteLog.ts';
import { advanceCursor } from '../log/cursor.ts';
import type { NoteRevision } from '../distill/llmDistiller.ts';

type NoteLogRecord = NoteRevision | { kind: 'note_tombstone' };

function latestRevisionPerNoteId(records: NoteLogRecord[]): NoteRevision[] {
  const latest = new Map<string, NoteRevision>();
  for (const record of records) {
    if (record.kind === 'note_tombstone') {
      // ponytail: v1 doesn't remove tombstoned notes from the index yet — real gap, not silently ignored.
      continue;
    }
    const existing = latest.get(record.note_id);
    // <=, not <: on a created_at tie, prefer whichever revision was appended later in the log.
    if (!existing || existing.created_at <= record.created_at) {
      latest.set(record.note_id, record);
    }
  }
  return [...latest.values()];
}

function buildSearchText(note: NoteRevision): string {
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

export function indexNotes(db: Database.Database, dataDir: string, cursorPath: string): number {
  // ponytail: v1 re-reads the whole note log and upserts by note_id instead of tracking a
  // true byte-offset cursor — cheap and correct at this scale; real incremental reads are
  // the eventual target per §5 once the log grows large enough to matter.
  const notes = readAllNotes(dataDir) as NoteLogRecord[];

  const deleteStmt = db.prepare('DELETE FROM notes_fts WHERE note_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, search_text) VALUES (?, ?, ?, ?, ?, ?)',
  );

  let indexedCount = 0;
  for (const note of latestRevisionPerNoteId(notes)) {
    if (!note.source.origin) {
      continue; // fail-closed: missing origin is a hard skip, never indexed with a null origin
    }

    let searchText: string;
    try {
      searchText = buildSearchText(note);
    } catch {
      continue; // fail-closed: one malformed note must not crash indexing for every note after it
    }

    deleteStmt.run(note.note_id);
    insertStmt.run(note.note_id, note.revision_id, note.source.origin, note.note_type, note.created_at, searchText);
    indexedCount += 1;
  }

  advanceCursor(cursorPath, {
    consumer: 'indexer',
    log_name: 'notes',
    file_path: dataDir,
    byte_offset: 0,
    updated_at: new Date().toISOString(),
  });

  return indexedCount;
}
