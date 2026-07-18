import { openIndexWrite } from '../index/database.ts';
import { buildSearchText, indexNotes } from '../index/indexer.ts';
import type { NoteRevision } from '../note.ts';

// FTS5 BM25 is lower-is-better; this is the positive score exposed by the gate.
// Tuned for the near-identical fixture while excluding distinct drafts.
//
// §6 ruling (settled): embeddings FETCH candidates, never DECIDE the verdict. An
// embedding model scores contradictions ("we chose Kamal" / "we abandoned Kamal")
// as near neighbours, so a cosine NOOP would silently eat exactly the §12.1
// knowledge-update notes the gate must let through. The duplicate verdict therefore
// stays this deterministic BM25 rule even with embeddings on; hybrid's only licence
// here is to widen the candidate *fetch*, which cannot raise the BM25 max and so is
// a pure no-op for the verdict — deliberately not built (YAGNI) until a gate step
// beyond top-1 BM25 needs the extra candidates.
const NEAR_DUPLICATE_SCORE = 0.00001;

function ftsQuery(text: string): string | undefined {
  const terms = [...new Set(text.match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  if (terms.length === 0) return undefined;
  if (terms.length === 1) return terms[0];
  return terms.map((_, omitted) => `(${terms.filter((__, index) => index !== omitted).join(' AND ')})`).join(' OR ');
}

export function findNearDuplicate(dataDir: string, draft: NoteRevision, indexDir?: string): { note_id: string; score: number } | null {
  const query = ftsQuery(buildSearchText(draft));
  if (query === undefined) return null;

  const scope = draft.scope.project_slug
    ? { clause: 'project_slug = ?', value: draft.scope.project_slug }
    : draft.scope.global === true
      ? { clause: 'is_global = 1', value: undefined }
      : undefined;
  if (scope === undefined) return null;

  const db = openIndexWrite(indexDir);
  try {
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
