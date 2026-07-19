/**
 * Note record types per spec §10.2 — the note log's unit of storage. Single
 * source of truth for `NoteRevision`/`NoteTombstone`/`NoteRecord`; distillers
 * (LLM, human) are the only writers.
 */

import { ulid } from 'ulid';

// Single source of truth for the note-type vocabulary: the union is DERIVED from this
// array (`typeof NOTE_TYPES[number]`), so a value added here updates both the type and the
// runtime list distillers validate against — they can't drift and silently coerce a new
// type to 'episode'.
export const NOTE_TYPES = ['fact', 'decision', 'project_summary', 'person', 'daily', 'episode', 'curated'] as const;
export type NoteType = typeof NOTE_TYPES[number];

/** Deterministic note id for a project's rolling summary. Written by the distiller and
 *  read by the index and injector — one place so this write/read identity contract can't
 *  drift silently (a typo at one site would empty session-start summaries). */
export function projectSummaryId(projectSlug: string): string {
  return `project:${projectSlug}:summary`;
}

export type NoteRevision = {
  kind: 'note_revision';
  schema_version: 1;
  note_id: string;
  revision_id: string;
  previous_revision_id?: string;
  created_at: string;
  valid_at?: string;
  invalid_at?: string;
  identity: { mode: 'deterministic' | 'episodic'; key?: string };
  source: {
    origin: string;
    distiller: 'llm' | 'human';
    model?: string;
    agent?: string;
    source_path?: string;
    content_hash?: string;
  };
  note_type: NoteType;
  title: string;
  scope: { project_slug?: string; git_root?: string; git_remote?: string; global?: boolean };
  provenance: {
    session_id?: string;
    event_ids?: string[];
    event_range?: { from_event_id: string; to_event_id: string };
  };
  links: Array<{
    target_type: 'note' | 'entity' | 'project' | 'file' | 'url';
    target: string;
    relation?: string;
  }>;
  body: { summary: string; bullets?: string[]; details?: string };
};

export type NoteTombstone = {
  kind: 'note_tombstone';
  schema_version: 1;
  note_id: string;
  revision_id: string;
  previous_revision_id: string;
  reason?: string;
  created_at: string;
  source: { kind: 'human' | 'cli' };
};

export type NoteSupersession = {
  kind: 'note_supersession';
  schema_version: 1;
  note_id: string;
  superseded_by: string;
  revision_id: string;
  created_at: string;
  reason?: string;
  source: { kind: 'human' | 'cli' };
};

/**
 * Validity-close-only invalidation (spec §12.12, #106): flags a note as wrong so
 * recall excludes it, without minting replacement content (no `superseded_by`).
 * Reuses the supersession → `invalid_at` index path; reversible — a newer revision
 * of the note re-opens it (a close applies only to revisions it post-dates).
 */
export type NoteFlag = {
  kind: 'note_flag';
  schema_version: 1;
  note_id: string;
  revision_id: string;
  created_at: string;
  reason: string;
  source: { kind: 'human' | 'cli' };
};
export type NoteRecord = NoteRevision | NoteTombstone | NoteSupersession | NoteFlag;
export type NoteStateRecord = NoteRevision | NoteTombstone;

/** Shared factory for a validity-close-only flag record (#106) — CLI and MCP both mint via this. */
export function buildFlagRecord(noteId: string, reason: string, source: { kind: 'human' | 'cli' }): NoteFlag {
  return {
    kind: 'note_flag', schema_version: 1, note_id: noteId, revision_id: ulid(),
    created_at: new Date().toISOString(), reason, source,
  };
}

export function latestRecordPerNoteId(records: NoteRecord[]): NoteStateRecord[] {
  const latest = new Map<string, NoteStateRecord>();
  for (const record of records) {
    if (record.kind === 'note_supersession' || record.kind === 'note_flag') continue;
    const existing = latest.get(record.note_id);
    // Tombstones and revisions compete as peers on created_at; latest-wins is symmetric, so a
    // tombstone can retire a note and a newer revision can revive it. <=, not <: on a created_at
    // tie, prefer whichever record was appended later in the log.
    if (!existing || existing.created_at <= record.created_at) {
      latest.set(record.note_id, record);
    }
  }
  return [...latest.values()];
}
