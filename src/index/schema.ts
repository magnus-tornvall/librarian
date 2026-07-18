import Database from 'better-sqlite3';

export const INDEX_SCHEMA_VERSION = 4;

/**
 * FTS5 recall index (§6). `project_slug`/`is_global` carry each note's scope
 * (§10.2 `scope`) so recall can enforce the push-path rule "require project match
 * or explicit global scope" (§6) per row — without this, cross-project negative
 * recall fixtures (§9) can't be written because every row looks scopeless.
 * Both are UNINDEXED: they are filter/return columns, never full-text tokenized.
 */
export function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== 0 && version !== INDEX_SCHEMA_VERSION) {
    throw new Error(`unsupported index schema version ${version}`);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      note_id UNINDEXED, revision_id UNINDEXED, origin UNINDEXED,
      note_type UNINDEXED, created_at UNINDEXED, valid_at UNINDEXED, invalid_at UNINDEXED, superseded_by UNINDEXED,
      project_slug UNINDEXED, is_global UNINDEXED,
      search_text
    );
    CREATE TABLE IF NOT EXISTS note_state (
      note_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      record_kind TEXT NOT NULL,
      record_created_at TEXT NOT NULL,
      superseded_at TEXT,
      superseded_by TEXT
    );
    CREATE TABLE IF NOT EXISTS index_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      segment TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      last_record_id TEXT,
      updated_at TEXT NOT NULL,
      data_dir TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
  `);
}
