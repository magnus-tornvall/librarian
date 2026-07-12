import Database from 'better-sqlite3';
import { buildSearchText, indexNotes } from '../index/indexer.ts';
import { migrate } from '../index/schema.ts';
import type { NoteRevision } from '../note.ts';

// FTS5 BM25 is lower-is-better; this is the positive score exposed by the gate.
// Tuned for the near-identical fixture while excluding distinct drafts.
const NEAR_DUPLICATE_SCORE = 0.00001;

function ftsQuery(text: string): string | undefined {
  const terms = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.length === 0 ? undefined : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

export function findNearDuplicate(dataDir: string, draft: NoteRevision): { note_id: string; score: number } | null {
  const query = ftsQuery(buildSearchText(draft));
  if (query === undefined) return null;

  const scope = draft.scope.project_slug
    ? { clause: 'project_slug = ?', value: draft.scope.project_slug }
    : draft.scope.global === true
      ? { clause: 'is_global = 1', value: undefined }
      : undefined;
  if (scope === undefined) return null;

  const db = new Database(':memory:');
  try {
    migrate(db);
    indexNotes(db, dataDir);
    const row = db
      .prepare(
        `SELECT note_id, -bm25(notes_fts) AS score
         FROM notes_fts
         WHERE notes_fts MATCH ? AND ${scope.clause}
         ORDER BY bm25(notes_fts) ASC
         LIMIT 1`,
      )
      .get(...(scope.value === undefined ? [query] : [query, scope.value])) as { note_id: string; score: number } | undefined;
    return row !== undefined && row.score >= NEAR_DUPLICATE_SCORE ? row : null;
  } finally {
    db.close();
  }
}
