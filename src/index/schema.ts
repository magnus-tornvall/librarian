import Database from 'better-sqlite3';

/**
 * FTS5 recall index (§6). `project_slug`/`is_global` carry each note's scope
 * (§10.2 `scope`) so recall can enforce the push-path rule "require project match
 * or explicit global scope" (§6) per row — without this, cross-project negative
 * recall fixtures (§9) can't be written because every row looks scopeless.
 * Both are UNINDEXED: they are filter/return columns, never full-text tokenized.
 */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      note_id UNINDEXED, revision_id UNINDEXED, origin UNINDEXED,
      note_type UNINDEXED, created_at UNINDEXED, valid_at UNINDEXED, invalid_at UNINDEXED, superseded_by UNINDEXED,
      project_slug UNINDEXED, is_global UNINDEXED,
      search_text
    );
  `);
}
