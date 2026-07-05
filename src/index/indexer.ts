import Database from 'better-sqlite3';
import { readAllNotes } from '../log/noteLog.ts';
import { advanceCursor } from '../log/cursor.ts';

type NoteRecord = Record<string, unknown>;

function latestRevisionPerNoteId(notes: NoteRecord[]): NoteRecord[] {
  const latest = new Map<string, NoteRecord>();
  for (const note of notes) {
    if (note.kind === 'note_tombstone') {
      // ponytail: v1 doesn't remove tombstoned notes from the index yet — real gap, not silently ignored.
      continue;
    }
    const noteId = note.note_id as string;
    const existing = latest.get(noteId);
    if (!existing || (existing.created_at as string) < (note.created_at as string)) {
      latest.set(noteId, note);
    }
  }
  return [...latest.values()];
}

function buildSearchText(note: NoteRecord): string {
  const body = (note.body ?? {}) as NoteRecord;
  const scope = (note.scope ?? {}) as NoteRecord;
  const links = (note.links ?? []) as Array<{ target: string }>;
  return [
    note.title,
    body.summary,
    ...((body.bullets as string[] | undefined) ?? []),
    body.details ?? '',
    scope.project_slug ?? '',
    ...links.map((link) => link.target),
  ]
    .filter(Boolean)
    .join(' ');
}

export function indexNotes(db: Database.Database, dataDir: string, cursorPath: string): number {
  // ponytail: v1 re-reads the whole note log and upserts by note_id instead of tracking a
  // true byte-offset cursor — cheap and correct at this scale; real incremental reads are
  // the eventual target per §5 once the log grows large enough to matter.
  const notes = readAllNotes(dataDir) as NoteRecord[];

  const deleteStmt = db.prepare('DELETE FROM notes_fts WHERE note_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, search_text) VALUES (?, ?, ?, ?, ?, ?)',
  );

  let indexedCount = 0;
  for (const note of latestRevisionPerNoteId(notes)) {
    const origin = (note.source as NoteRecord | undefined)?.origin;
    if (typeof origin !== 'string' || origin.length === 0) {
      continue; // fail-closed: missing origin is a hard skip, never indexed with a null origin
    }

    deleteStmt.run(note.note_id);
    insertStmt.run(
      note.note_id,
      note.revision_id,
      origin,
      note.note_type,
      note.created_at,
      buildSearchText(note),
    );
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
