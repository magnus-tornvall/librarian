# Note record

A note record is a structured memory record — the note log's unit of storage, written only
by distillers, never directly by instrumentation. There are three kinds: `NoteRevision` (a
version of a note's content), `NoteTombstone` (removes a note_id), `NoteSupersession`
(an append-only recall annotation for an older fact), and `NoteCorroboration` (an append-only
TTL annotation from the novelty gate). The
one-sentence version of the distill-only rule: nothing enters the note log without a
distiller's judgment — `llm` or `human` — there is no generic import path, not even for
pre-condensed machine content.

## Types

```ts
type NoteRecord = NoteRevision | NoteTombstone | NoteSupersession | NoteCorroboration;

type NoteRevision = {
  kind: "note_revision"; schema_version: 1;
  note_id: string; revision_id: string;              // revision_id: ULID
  previous_revision_id?: string;
  created_at: string;
  valid_at?: string; invalid_at?: string;              // valid_at defaults to created_at
  identity: { mode: "deterministic" | "episodic"; key?: string };
  source: {
    origin: string;                                  // open vocabulary, MANDATORY
    distiller: "llm" | "human";
    model?: string; agent?: string;
    source_path?: string; content_hash?: string;
  };
  note_type: "fact" | "decision" | "project_summary" | "person" | "daily" | "episode" | "curated";
  title: string;
  scope: { project_slug?: string; git_root?: string; git_remote?: string; global?: boolean };
  provenance: { session_id?: string; event_ids?: string[];
                event_range?: { from_event_id: string; to_event_id: string } };
  links: Array<{ target_type: "note" | "entity" | "project" | "file" | "url";
                 target: string; relation?: string }>;
  body: { summary: string; bullets?: string[]; details?: string };
};

type NoteTombstone = {
  kind: "note_tombstone"; schema_version: 1;
  note_id: string; revision_id: string; previous_revision_id: string;
  reason?: string; created_at: string;
  source: { kind: "human" | "cli" };
};

type NoteSupersession = {
  kind: "note_supersession"; schema_version: 1;
  note_id: string; superseded_by: string; revision_id: string; // revision_id: ULID
  created_at: string; reason?: string;
  source: { kind: "human" | "cli" };
};

type NoteCorroboration = {
  kind: "note_corroboration"; schema_version: 1;
  note_id: string; revision_id: string; created_at: string;
  corroborated_by: { session_id: string;
                     event_range?: { from_event_id: string; to_event_id: string } };
  source: { kind: "novelty_gate" };
};
```

## Rules

`origin` mandatory, denormalized, indexed, fail-closed. Human distiller preserves Markdown
verbatim in `body.details`, derives `title` from H1 and `summary` from first paragraph.
Curated frontmatter may declare `note_id`; importer tombstones orphaned IDs on rename.
`search_text` is indexer-derived. Tombstones and supersessions are CLI/human only in v1.
`NoteSupersession` never competes with revisions in latest-revision-wins. The index retains
the revision and carries its earliest supersession timestamp as `invalid_at`; recall excludes
the closed interval at query time so `why-not` can report `superseded`.
`NoteCorroboration` never competes with revisions either. The index carries its newest
timestamp as `last_corroborated_at`, and TTL uses the later of that and `created_at`.

Only deterministic-ID notes (`project:{slug}:summary`, `person:{normalized_name}`,
`daily:{yyyy-mm-dd}`, `curated:{id}`) may be revised — the distiller fetches a prior
revision only by that deterministic ID, never by "probably related" search. Everything
else is episodic (`{type}:{ulid}`), one revision, immutable forever.

## Golden examples

1. [`01-episodic-decision-llm-opencode.json`](schema/examples/note/01-episodic-decision-llm-opencode.json) — an episodic decision note, `distiller: "llm"`, `origin: "opencode"`.
2. [`02-deterministic-project-summary-rev1.json`](schema/examples/note/02-deterministic-project-summary-rev1.json) — a deterministic project-summary note, revision 1.
3. [`03-deterministic-project-summary-rev2.json`](schema/examples/note/03-deterministic-project-summary-rev2.json) — the same note's revision 2, chained via `previous_revision_id`.
4. [`04-curated-note-human-explicit-id.json`](schema/examples/note/04-curated-note-human-explicit-id.json) — a curated note, `distiller: "human"`, explicit frontmatter `note_id`.
5. [`05-tombstone-via-cli.json`](schema/examples/note/05-tombstone-via-cli.json) — a tombstone emitted via the CLI.
6. [`06-supersession-via-cli.json`](schema/examples/note/06-supersession-via-cli.json) — an append-only supersession emitted via the CLI.
7. [`07-corroboration-via-novelty-gate.json`](schema/examples/note/07-corroboration-via-novelty-gate.json) — an append-only duplicate citation emitted by the novelty gate.

## Post-skeleton revision (2026-07)

Gate per §12 item 4: reconcile this doc against what the walking skeleton (roadmap items
010–025) actually implemented, and extract `NoteRevision`/`NoteTombstone`/`NoteRecord` into
one shared module (`src/note.ts`). Findings below cover every top-level field of both types;
"no change" entries were reviewed against `src/distill/llmDistiller.ts`, `src/index/indexer.ts`,
`src/export/obsidian.ts`, `src/recall/query.ts`, `src/recall/scoring.ts`, and
`tests/walkingSkeleton.integration.test.ts`, not skipped.

**Structural — DELTA (fixed).** `NoteRevision` was defined inline in `llmDistiller.ts` and
re-declared as a throwaway `{ kind: 'note_tombstone' }` stub in `indexer.ts`, instead of
living in one shared module. Extracted to `src/note.ts`; both consumers now import from
there.

**`note_id` (episodic notes) — DELTA (fixed).** The LLM distiller minted episodic
`note_id`s as `{origin}:{ulid}` (e.g. `opencode:01J8...`). §5 and this doc's own Rules
section are explicit that episodic ids are `{type}:{ulid}` (e.g. `decision:01J8...`, per
golden example 1) — `origin` and `note_type` are different fields and the skeleton
conflated them. Fixed in `llmDistiller.ts` to mint `{note_type}:{ulid}`; updated the tests
that had encoded the old (wrong) convention.

**`kind` / `schema_version`** — no change. Both types stamp the literals exactly as
specified everywhere they're produced or read.

**`revision_id` / `created_at`** — no change. Minted via `ulid()` / `new Date().toISOString()`
in the distiller, exactly as documented.

**`previous_revision_id`** — no change. Correctly never set by the LLM distiller: it only
ever mints fresh episodic notes (one revision, immutable), and revision chaining is a
deterministic-note concern the human/curated distiller owns (later issue in this phase, not
built yet).

**`identity`** — no change. LLM distiller stamps `{ mode: 'episodic' }` with no `key`,
matching the rule that only deterministic notes carry a `key`.

**`source`** — no change to the type. `origin`/`distiller` are always stamped (fail-closed
on missing `origin` is enforced in `indexer.ts`). `model`/`agent`/`source_path`/`content_hash`
are optional and currently never populated by the LLM path — `InferenceProvider` (task 017)
exposes only `complete(prompt)`, no model identity, so there's nothing to stamp yet. Not a
schema mismatch (the fields are optional); flagged here so it isn't silently invisible.

**`note_type`** — no change. The skeleton's 7-value union matches this doc's exactly.

**`title` / `body`** — no change. LLM path fills `summary`/`bullets` only; `details` is
correctly left unset (human-only field per the Rules section, preserved verbatim from
Markdown by the human distiller, which doesn't exist yet).

**`scope`** — no change to the type. The LLM distiller always stamps `{}`; deterministic
`project_slug`/`git_root`/`git_remote` derivation (§4) is not implemented by any module yet
— there is no project-slug-deriving code anywhere in `src/`. This is a real gap, but it's
new functionality (out of scope per this issue's "reconciliation, not redesign" rule), not
a doc/implementation disagreement about the shape.

**`provenance`** — no change. `session_id`/`event_ids` are stamped mechanically from the
input events, exactly as documented; `event_range` is unused by the LLM path (it stamps
individual `event_ids` instead), which the type already allows since both sub-fields are
optional.

**`links`** — no change. Always `[]` from the LLM path; no linking logic exists yet.

**`NoteTombstone` (all fields)** — no change. No producer exists yet (no CLI), so there is
nothing in the skeleton to disagree with; the type matches golden example 5 exactly. The
former `indexer.ts` stub only ever checked `kind === 'note_tombstone'` as a discriminant,
never accessed `NoteTombstone`'s other fields — replaced with the real type from
`src/note.ts` (see Structural finding above).
