import Database from 'better-sqlite3';

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      note_id UNINDEXED, revision_id UNINDEXED, origin UNINDEXED,
      note_type UNINDEXED, created_at UNINDEXED, search_text
    );
  `);
}
