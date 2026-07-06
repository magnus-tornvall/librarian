/**
 * Note record types per spec §10.2 — the note log's unit of storage. Single
 * source of truth for `NoteRevision`/`NoteTombstone`/`NoteRecord`; distillers
 * (LLM, human) are the only writers.
 */

export type NoteRevision = {
  kind: 'note_revision';
  schema_version: 1;
  note_id: string;
  revision_id: string;
  previous_revision_id?: string;
  created_at: string;
  identity: { mode: 'deterministic' | 'episodic'; key?: string };
  source: {
    origin: string;
    distiller: 'llm' | 'human';
    model?: string;
    agent?: string;
    source_path?: string;
    content_hash?: string;
  };
  note_type: 'fact' | 'decision' | 'project_summary' | 'person' | 'daily' | 'episode' | 'curated';
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

export type NoteRecord = NoteRevision | NoteTombstone;
