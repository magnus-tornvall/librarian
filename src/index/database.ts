import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';
import { INDEX_DIR } from '../paths.ts';
import { INDEX_SCHEMA_VERSION, migrate } from './schema.ts';
import type { NoteRevision } from '../note.ts';
import type { EmbeddingModel } from '../embedding/provider.ts';

export function indexDbPath(indexDir = INDEX_DIR): string {
  return path.join(indexDir, 'notes.db');
}

function configure(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  loadSqliteVec(db);
}

export function openIndexWrite(indexDir = INDEX_DIR): Database.Database {
  fs.mkdirSync(indexDir, { recursive: true });
  const file = indexDbPath(indexDir);
  let db = new Database(file);
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== 0 && version !== INDEX_SCHEMA_VERSION) {
    db.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
    db = new Database(file);
  }
  configure(db);
  migrate(db);
  return db;
}

export function openIndexRead(indexDir = INDEX_DIR): Database.Database {
  const file = indexDbPath(indexDir);
  if (!fs.existsSync(file)) {
    throw new Error(`recall index is missing at ${file}; run librarian drain to rebuild it`);
  }
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    loadSqliteVec(db);
  } catch (err) {
    throw new Error(`cannot open recall index at ${file}; run librarian drain to rebuild it: ${(err as Error).message}`);
  }
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== INDEX_SCHEMA_VERSION) {
    db.close();
    throw new Error(`recall index at ${file} is incompatible; run librarian drain to rebuild it`);
  }
  return db;
}

export function indexedThrough(db: Database.Database): string {
  const row = db.prepare('SELECT updated_at FROM index_cursor WHERE id = 1').get() as { updated_at: string } | undefined;
  return row?.updated_at ?? '';
}

export function embeddingIndexModel(db: Database.Database): EmbeddingModel | undefined {
  const rows = db.prepare("SELECT key, value FROM index_metadata WHERE key IN ('embedding_model', 'embedding_digest')").all() as Array<{ key: string; value: string }>;
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return values.embedding_model && values.embedding_digest
    ? { name: values.embedding_model, digest: values.embedding_digest }
    : undefined;
}

export function setEmbeddingIndexModel(db: Database.Database, model: EmbeddingModel): void {
  const write = db.prepare('INSERT INTO index_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  write.run('embedding_model', model.name);
  write.run('embedding_digest', model.digest);
}

export type EmbeddingCoverage = { embedded: number; total: number; state: 'disabled' | 'partial' | 'complete' };

/**
 * `enabled` comes from config (embedding configured or not) — the index alone
 * cannot distinguish "disabled" from "configured but the provider never
 * succeeded", and that difference is exactly what coverage must not hide.
 * Callers without config fall back to the stamped index model.
 */
export function embeddingCoverage(db: Database.Database, enabled?: boolean): EmbeddingCoverage {
  const total = (db.prepare("SELECT COUNT(*) AS count FROM notes_fts WHERE invalid_at IS NULL OR invalid_at > ?").get(new Date().toISOString()) as { count: number }).count;
  const hasVectors = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_vectors'").get() !== undefined;
  const embedded = hasVectors
    ? (db.prepare('SELECT COUNT(*) AS count FROM note_vectors').get() as { count: number }).count
    : 0;
  const active = enabled ?? embeddingIndexModel(db) !== undefined;
  return { embedded, total, state: !active ? 'disabled' : embedded === total ? 'complete' : 'partial' };
}

export function assertEmbeddingIndexModel(db: Database.Database, model: EmbeddingModel): void {
  const indexed = embeddingIndexModel(db);
  if (indexed && (indexed.name !== model.name || indexed.digest !== model.digest)) {
    throw new Error(`embedding model changed from ${indexed.name}@${indexed.digest} to ${model.name}@${model.digest}; delete the index directory and run librarian drain to rebuild it`);
  }
}

export function stateNotes(db: Database.Database, noteIds?: readonly string[]): NoteRevision[] {
  const rows = noteIds === undefined
    ? db.prepare("SELECT record_json FROM note_state WHERE record_kind = 'note_revision'").all()
    : noteIds.length === 0
      ? []
      : db.prepare(`SELECT record_json FROM note_state WHERE note_id IN (${noteIds.map(() => '?').join(', ')}) AND record_kind = 'note_revision'`).all(...noteIds);
  return (rows as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json) as NoteRevision);
}

export function sessionStartNotes(db: Database.Database, projectSlug: string | undefined, global: boolean, now: string): NoteRevision[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (projectSlug !== undefined) {
    clauses.push("note_id = ?");
    params.push(`project:${projectSlug}:summary`);
    clauses.push("(json_extract(record_json, '$.note_type') = 'curated' AND json_extract(record_json, '$.scope.project_slug') = ?)");
    params.push(projectSlug);
  }
  if (global) {
    clauses.push("(json_extract(record_json, '$.note_type') = 'curated' AND json_extract(record_json, '$.scope.global') = 1)");
  }
  if (clauses.length === 0) return [];
  const rows = db.prepare(`SELECT record_json FROM note_state
    WHERE record_kind = 'note_revision'
      AND (${clauses.join(' OR ')})
      AND (superseded_at IS NULL OR superseded_at > ?)
      AND (json_extract(record_json, '$.invalid_at') IS NULL OR json_extract(record_json, '$.invalid_at') > ?)
      AND COALESCE(json_extract(record_json, '$.valid_at'), json_extract(record_json, '$.created_at')) <= ?`)
    .all(...params, now, now, now);
  return (rows as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json) as NoteRevision);
}
