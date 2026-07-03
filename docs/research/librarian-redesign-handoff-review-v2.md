# Review V2: Librarian Redesign Handoff

## Executive Verdict

The redesign is directionally sound if the durable layer is **memory records**, not Obsidian pages. The two-log design is justified because it separates raw agent telemetry from distilled memory and lets exporters/indexers replay independently.

The first review missed two important constraints:

1. Human-edited Obsidian notes are part of the workflow and must not be clobbered by generated views.
2. Note revisions are only simple when the note identity is deterministic; otherwise the distiller becomes a recall/entity-resolution client.

These two corrections should become explicit v1 rules.

## Settled Architecture Decisions

- Durable memory records are the core domain layer.
- Obsidian pages are rendered views or curated inputs, not the canonical memory model.
- The system keeps two append-only logs: event log and note log.
- Event log contains normalized, redacted, canonical telemetry.
- Note log contains structured memory records and revisions.
- Generated Obsidian files are exporter-owned and may be overwritten.
- Human-authored notes are first-class inputs and must enter through ingestion.
- Snapshot revisions are used, not event-sourced note internals.
- Latest-revision-wins by `note_id`.
- Tombstones exist in the schema, but v1 does not require the distiller to emit them.
- Deterministic-ID notes may be revised.
- Non-deterministic memories are episodic and immutable in v1.
- `search_text` is derived by the indexer, not written by the distiller.
- `event_id` and `revision_id` should be ULIDs.
- Resource records stamp raw facts; project scope is derived later and cached.
- Instrumentation may emit cheap salience hints, but collector/distiller logic owns salience.
- Redaction must happen before durable append.
- Keep `librarian drain` as the manual recovery/debug command.

## Critical Correction: Human Curation

The clean boundary "Obsidian is a rendered view" is incomplete. It breaks the existing file-over-app workflow if generated aggregate pages overwrite hand edits.

Use a hard split:

- **Generated files are exporter-owned.** They live at deterministic paths, carry a generated marker, and can be overwritten freely.
- **Human-authored files are ingestion-owned.** They live in a curated directory or have an explicit frontmatter flag. They are converted into memory records with `source.kind: "human"`.

Recommended vault layout:

```text
vault/
  generated/
    projects/foo.md
    daily/2026-07-03.md
    people/alice.md

  curated/
    projects/foo.md
    decisions/use-snapshot-revisions.md
    notes/manual-context.md
```

Generated file marker:

```md
---
librarian_owned: true
librarian_generated: true
librarian_note_ids:
  - project:foo:summary
---

<!-- librarian:generated; do not edit -->
```

Curated file marker:

```md
---
librarian_source: human
note_type: decision
scope:
  project_slug: foo
---

# Use Snapshot Revisions

Human-authored content here.
```

Important invariant: generated files must be excluded from curated-note ingestion. Otherwise the system will ingest its own rendered output and create feedback loops.

For v1, prefer:

```text
curated markdown -> curated-note importer -> note log
```

over:

```text
curated markdown -> human event -> distiller -> note log
```

The human already performed the distillation. Do not send curated notes back through an LLM unless there is a specific later feature that needs normalization.

Recall should boost human-authored records above LLM-distilled records, all else equal.

## Critical Correction: Revision Scope

The original snapshot-revision model is correct, but only if v1 restricts what may be revised.

Replacing a `project_summary` is straightforward because the ID is deterministic. Updating an arbitrary decision/fact/person note is not straightforward because the distiller must answer: "which existing note is this about?" That silently introduces entity resolution and turns the distiller into a recall client.

V1 rule:

- Deterministic-ID notes may have multiple revisions.
- Episodic notes have one revision and are append-only forever.
- Consolidating episodic notes into durable logical notes is deferred.

Examples of deterministic IDs:

```text
project:{project_slug}:summary
person:{normalized_name}
daily:{yyyy-mm-dd}
repo:{remote_hash}:summary
curated:{path_hash}
```

Examples of episodic IDs:

```text
episode:{ulid}
fact:{ulid}
decision:{ulid}
observation:{ulid}
```

The distiller may fetch a prior revision only by deterministic ID:

```ts
const noteId = `project:${projectSlug}:summary`;
const previous = noteStore.getLatestRevision(noteId);
```

It should not search for "probably related" notes and mutate them in v1.

## Schema Recommendation: Event Records

Create `schema/event.md` with prose, TypeScript types, and golden examples.

The event schema should be canonical, redacted, and append-safe. It should represent agent activity without embedding domain memory decisions.

```ts
type CanonicalEvent =
  | PromptEvent
  | ToolEvent
  | SessionEvent;

type EventBase = {
  schema_version: 1;
  event_id: string; // ULID.
  ts: string;       // ISO 8601.

  resource: {
    agent: string;
    agent_version?: string;
    machine_id: string;
    cwd: string;
    git_root?: string;
    git_remote?: string;
    git_branch?: string;
  };

  context: {
    session_id: string;
    turn?: number;
    cwd: string;
  };

  hints?: {
    possibly_salient?: boolean;
    reason?: "file_write" | "vcs_commit" | "cwd_change" | "user_pushback" | "manual";
  };
};

type PromptEvent = EventBase & {
  type: "prompt";
  prompt: string;
};

type ToolEvent = EventBase & {
  type: "tool";
  tool: {
    native_name: string;
    canonical_name: "read" | "write" | "edit" | "bash" | "search" | "unknown";
    category:
      | "file_read"
      | "file_write"
      | "command"
      | "search"
      | "vcs_commit"
      | "vcs_push"
      | "other";
  };
  command?: string;
  files?: Array<{
    path: string;
    action: "read" | "write" | "edit" | "delete";
  }>;
};

type SessionEvent = EventBase & {
  type: "session";
  action: "start" | "stop" | "compact" | "checkpoint";
};
```

Event schema rules:

- Redaction happens before append.
- `event_id` is generated before append and never changes.
- `resource` stores facts, not authoritative project identity.
- `project_slug` is not required in the event record.
- `hints` are non-authoritative.
- Partial JSON lines are ignored or quarantined, never treated as valid records.
- Consumers advance cursors only after successful processing.

Golden examples to include:

1. User prompt in a git repo.
2. File edit tool event with canonical category `file_write`.
3. Bash git commit normalized to `vcs_commit`.
4. Redacted command containing a token.
5. Session checkpoint event.

Example redacted command:

```json
{
  "schema_version": 1,
  "event_id": "01JZ6N7W3Z5W6V7A8B9C0D1E2F",
  "ts": "2026-07-03T12:00:00.000Z",
  "type": "tool",
  "resource": {
    "agent": "opencode",
    "machine_id": "macbook-pro",
    "cwd": "/Users/me/project",
    "git_root": "/Users/me/project",
    "git_remote": "git@github.com:me/project.git",
    "git_branch": "main"
  },
  "context": {
    "session_id": "01JZ6N7QAAAAAAAABBBBBBBBBB",
    "turn": 4,
    "cwd": "/Users/me/project"
  },
  "tool": {
    "native_name": "Bash",
    "canonical_name": "bash",
    "category": "command"
  },
  "command": "curl -H 'Authorization: Bearer [REDACTED:token:sha256:abc123]' https://api.example.com",
  "hints": {
    "possibly_salient": false
  }
}
```

## Schema Recommendation: Note Records

Create `schema/note.md` with prose, TypeScript types, and golden examples.

The note schema should model durable memory records, not rendered pages.

```ts
type NoteRecord = NoteRevision | NoteTombstone;

type NoteRevision = {
  kind: "note_revision";
  schema_version: 1;

  note_id: string;
  revision_id: string; // ULID.
  previous_revision_id?: string;
  created_at: string;

  identity: {
    mode: "deterministic" | "episodic";
    key?: string;
  };

  source: {
    kind: "distiller" | "human";
    agent?: string;
    source_path?: string;
    content_hash?: string;
  };

  note_type:
    | "fact"
    | "decision"
    | "project_summary"
    | "person"
    | "daily"
    | "episode"
    | "curated";

  title: string;

  scope: {
    project_slug?: string;
    git_root?: string;
    git_remote?: string;
    global?: boolean;
  };

  provenance: {
    session_id?: string;
    event_ids?: string[];
    event_range?: {
      from_event_id: string;
      to_event_id: string;
    };
  };

  links: Array<{
    target_type: "note" | "entity" | "project" | "file" | "url";
    target: string;
    relation?: string;
  }>;

  body: {
    summary: string;
    bullets?: string[];
    details?: string;
  };
};

type NoteTombstone = {
  kind: "note_tombstone";
  schema_version: 1;

  note_id: string;
  revision_id: string; // ULID.
  previous_revision_id: string;
  created_at: string;

  reason?: string;

  source: {
    kind: "human" | "cli";
  };
};
```

Note schema rules:

- `note_id` is stable logical identity.
- `revision_id` is immutable revision identity.
- `previous_revision_id` is only required when revising or tombstoning.
- `identity.mode: "deterministic"` permits revisions.
- `identity.mode: "episodic"` means one revision in v1.
- Human-authored records use `source.kind: "human"`.
- Distilled records use `source.kind: "distiller"`.
- `search_text` is not in the note record.
- The indexer derives search text from a fixed concatenation rule.
- Tombstones are part of the replay model but v1 emitters are CLI/human actions, not the distiller.

Recommended derived search text rule:

```ts
function deriveSearchText(note: NoteRevision): string {
  return [
    note.title,
    note.body.summary,
    ...(note.body.bullets ?? []),
    note.body.details ?? "",
    note.scope.project_slug ?? "",
    note.scope.git_remote ?? "",
    ...note.links.map((link) => `${link.target_type}:${link.target}`),
  ]
    .filter(Boolean)
    .join("\n");
}
```

Golden examples to include:

1. Episodic decision note from a distiller.
2. Deterministic project summary first revision.
3. Deterministic project summary second revision with `previous_revision_id`.
4. Human-authored curated note imported from Markdown.
5. Tombstone emitted by CLI for a curated note.

Example episodic decision:

```json
{
  "kind": "note_revision",
  "schema_version": 1,
  "note_id": "decision:01JZ6P1B2C3D4E5F6G7H8J9K0L",
  "revision_id": "01JZ6P1B2C3D4E5F6G7H8J9K0M",
  "created_at": "2026-07-03T12:15:00.000Z",
  "identity": {
    "mode": "episodic"
  },
  "source": {
    "kind": "distiller",
    "agent": "opencode"
  },
  "note_type": "decision",
  "title": "Use snapshot revisions for Librarian notes",
  "scope": {
    "project_slug": "librarian",
    "git_root": "/Users/me/librarian",
    "git_remote": "git@github.com:me/librarian.git"
  },
  "provenance": {
    "session_id": "01JZ6N7QAAAAAAAABBBBBBBBBB",
    "event_ids": [
      "01JZ6N7W3Z5W6V7A8B9C0D1E2F"
    ]
  },
  "links": [],
  "body": {
    "summary": "The project will use snapshot revisions rather than event-sourced note internals.",
    "bullets": [
      "Logical identity is stored in note_id.",
      "Immutable revision identity is stored in revision_id.",
      "Only deterministic-ID notes may be revised in v1."
    ]
  }
}
```

Example deterministic project summary revision:

```json
{
  "kind": "note_revision",
  "schema_version": 1,
  "note_id": "project:librarian:summary",
  "revision_id": "01JZ6P2Q3R4S5T6V7W8X9Y0Z1A",
  "previous_revision_id": "01JZ6P1Q3R4S5T6V7W8X9Y0Z1A",
  "created_at": "2026-07-03T12:30:00.000Z",
  "identity": {
    "mode": "deterministic",
    "key": "project:librarian:summary"
  },
  "source": {
    "kind": "distiller",
    "agent": "opencode"
  },
  "note_type": "project_summary",
  "title": "Librarian project summary",
  "scope": {
    "project_slug": "librarian"
  },
  "provenance": {
    "session_id": "01JZ6N7QAAAAAAAABBBBBBBBBB",
    "event_range": {
      "from_event_id": "01JZ6N7W3Z5W6V7A8B9C0D1E2F",
      "to_event_id": "01JZ6P0W3Z5W6V7A8B9C0D1E2F"
    }
  },
  "links": [],
  "body": {
    "summary": "Librarian is an AI memory system with canonical events, structured note records, generated Obsidian views, and human curated inputs.",
    "bullets": [
      "Two append-only logs separate telemetry from memory records.",
      "Human-authored notes are ingested as first-class memory records.",
      "Generated Obsidian pages are exporter-owned."
    ]
  }
}
```

Example human curated note:

```json
{
  "kind": "note_revision",
  "schema_version": 1,
  "note_id": "curated:6d1b8f4c9d2a",
  "revision_id": "01JZ6P3B2C3D4E5F6G7H8J9K0L",
  "created_at": "2026-07-03T12:45:00.000Z",
  "identity": {
    "mode": "deterministic",
    "key": "curated:6d1b8f4c9d2a"
  },
  "source": {
    "kind": "human",
    "source_path": "curated/decisions/use-snapshot-revisions.md",
    "content_hash": "sha256:abc123"
  },
  "note_type": "curated",
  "title": "Use Snapshot Revisions",
  "scope": {
    "project_slug": "librarian"
  },
  "provenance": {},
  "links": [],
  "body": {
    "summary": "Human-authored decision note explaining why Librarian uses snapshot revisions.",
    "details": "The human-authored Markdown body is preserved or normalized according to the curated-note importer rules."
  }
}
```

## Cursor, Lock, And Replay Requirements

These are not implementation details; they are correctness requirements.

Minimum cursor record:

```ts
type ConsumerCursor = {
  consumer: string;
  log_name: string;
  file_path: string;
  byte_offset: number;
  last_record_id?: string;
  updated_at: string;
};
```

Rules:

- A consumer advances its cursor only after successful processing.
- Failed records are retried with a bounded retry count.
- Poison records are quarantined with enough context to debug.
- Partial trailing JSON lines are ignored until completed.
- Detached workers need explicit lock ownership, stale-lock recovery, and token checks.
- `librarian drain` should process pending event logs, note logs, exports, and indexes.

## Redaction Requirements

Redaction is the one part that is almost impossible to retrofit. If secrets enter an append-only replayable log, they are immortal by design.

The write path should be:

```text
agent-native event
  -> normalize
  -> redact
  -> validate
  -> append canonical event log
```

Do not append raw events first and redact later.

Redaction should preserve correlation without preserving the secret:

```text
[REDACTED:token:sha256:abc123]
```

## Over-Engineering To Avoid

Delete or defer:

- Generic `Librarian` interface.
- Generic storage abstraction.
- Full provider qualification framework.
- Sophisticated inference-provider schema negotiation.
- Event-sourced note internals.
- Distiller-driven tombstones.
- Semantic consolidation of episodic notes.
- Generated/human mixed ownership regions inside the same Markdown file.

Keep:

- Two logs.
- Event IDs.
- Note/revision IDs.
- Schema versions.
- Idempotent exporters.
- Independent cursors.
- Generated/curated vault split.
- Human note ingestion.
- BM25-only v1 index.
- `librarian drain`.

## Challenged Decisions

### BM25-Only Recall

BM25-only is the right v1 choice. The schema should not block vector search later, but no recall provider abstraction is needed now.

### No Daemon

No daemon is reasonable for a personal side project. The lazy detached-worker model is already proven by SuperBrain. The recovery tool is more important than a resident process.

### Instrumentation-Side Salience

Instrumentation should not own salience. It may emit cheap hints, but canonical salience belongs in the collector/distiller.

### Resource At Instrumentation Time

Instrumentation should stamp facts, not final scope. Store `cwd`, `git_root`, `git_remote`, `git_branch`, `machine_id`, and agent details. Derive `project_slug` later and cache it in note `scope`.

## Recommended Roadmap

1. Draft `schema/event.md` with prose, TypeScript types, and 3-5 golden examples.
2. Draft `schema/note.md` with prose, TypeScript types, and 3-5 golden examples.
3. Specify curated-note ingestion and generated-file exclusion.
4. Build walking skeleton: fixture events -> distill -> note log -> generated Obsidian export -> BM25 -> recall.
5. Add curated Markdown -> note log -> BM25 -> recall.
6. Add real OpenCode or Claude instrumentation.
7. Add cursor, lock, retry, and quarantine hardening.
8. Add a second provider or exporter only after the first path works.

The schema work should happen before the walking skeleton, but only at minimum viable depth. The golden examples are the real test of whether the design is concrete enough.

## Final Recommendation

Adopt the converged decisions with one refinement: human-authored notes should be first-class memory records, but v1 should ingest them directly into the note log through a curated-note importer rather than routing them through the distiller.

That preserves the file-over-app workflow, prevents generated exports from clobbering manual curation, keeps the LLM from becoming the authority over human-written memory, and avoids prematurely solving entity resolution.
