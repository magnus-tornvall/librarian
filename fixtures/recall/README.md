# Recall calibration fixtures (§9 negative recall fixtures)

This directory is the **recall calibration gate**: a widenable suite that proves push-path
recall surfaces what it must and — the point of the gate — *excludes* what it must not,
before any reranking, vector search, or mem0-style retrieval is ever considered (§5, §15).

Each fixture is a plain JSON file. **Adding coverage means adding a `.json` file here — never
editing test logic.** The runner at `tests/recall/fixtures.test.ts` auto-discovers every
`fixtures/recall/**/*.json`, seeds a fresh temp note log + in-memory SQLite FTS index, runs
the real `indexNotes()` → `recall()` path, and applies the fixture's assertions. It exercises
real index/recall behavior, not `rankAndFilter()` alone.

## Why this is only possible now

Recall enforces the §6 push-path rule "require project match or explicit global scope." That
gate lives in the index (`notes_fts.project_slug` / `notes_fts.is_global`, populated by the
indexer from each note's `scope`). Without per-row scope in the index, cross-project and
cross-repo negative fixtures could not be written — every row would look scopeless. Storing
scope is the enabler for the fixtures below.

## File format

```jsonc
{
  "name": "human-readable fixture name (also the subtest name)",
  "query": "the FTS MATCH query string passed to recall()",
  "opts": { "projectSlug": "alpha", "global": true },  // recall scope opts; at least one of
                                                        // projectSlug / global is required, or
                                                        // recall returns [] by the §6 gate
  "now": "2026-07-06T12:00:00.000Z",   // optional; fixed clock for deterministic recency decay
                                        // (defaults to a fixed constant in the runner)
  "notes": [ /* NoteSeed[] — seeded into the note log, then indexed (see below) */ ],
  "expect": {
    "include":       ["note_id", ...],      // these note_ids MUST appear in the results
    "exclude":       ["note_id", ...],      // these note_ids MUST NOT appear (the distractors)
    "orderedBefore": [["a", "b"], ...],     // "a" must rank strictly before "b" in results
    "maxResults":    5,                      // result count must be <= this (push austerity: 0-5)
    "empty":         false                   // when true, results MUST be exactly [] (valid case)
  },
  "reason": "one sentence: what recall behavior this fixture pins and why it matters"
}
```

Every key under `expect` is optional; a fixture asserts only the constraints it cares about.
An empty `expect` is legal but pointless — every fixture should state at least one of
`include` / `exclude` / `empty`.

TTL fixtures must set `now` explicitly: the runner passes that fixed timestamp through recall,
so a note's `created_at` can deterministically prove its type's shelf-life boundary without
depending on the machine clock.

### `NoteSeed` shape

A `NoteSeed` is a trimmed `NoteRevision` (see `src/note.ts`). Only the fields that affect
recall are required; the runner stamps mechanical defaults (`schema_version`, `revision_id`,
`identity`, `provenance`, `links`, `source.distiller`) so fixtures stay small.

```jsonc
{
  "note_id":    "decision:alpha-auth",     // required
  "note_type":  "decision",                // required: fact|decision|project_summary|person|daily|episode|curated
  "origin":     "opencode",                // required: drives the §6 origin weight (human|opencode|email|...)
  "created_at": "2026-07-06T10:00:00.000Z", // required: drives recency decay
  "scope":      { "project_slug": "alpha" }, // required: { project_slug } and/or { global: true }.
                                             //   A note with neither is unreachable by recall by design.
  "title":      "Alpha auth decision",     // required: indexed into search_text
  "body":       { "summary": "...", "bullets": ["..."], "details": "..." }, // required: summary; bullets/details optional
  "revision_id": "optional-explicit-id",   // optional; defaults to a deterministic id from note_id
   "kind":       "note_revision"            // optional; set "note_tombstone" to seed a tombstone
                                           //   (then previous_revision_id is required)
}
```

To seed a **tombstone** (e.g. to prove a retired note is gone from recall), use:

```jsonc
{ "kind": "note_tombstone", "note_id": "decision:alpha-auth", "previous_revision_id": "...",
  "created_at": "2026-07-06T11:00:00.000Z" }
```

Notes are seeded in array order, so a later-appended record wins a `created_at` tie exactly
as it would in production (latest-revision-wins is order-symmetric — see the indexer).

To seed a **supersession**, append it after both revisions:

```jsonc
{ "kind": "note_supersession", "note_id": "decision:old", "superseded_by": "decision:new",
  "created_at": "2026-07-06T11:00:00.000Z" }
```

It is an annotation, not a latest-record competitor: the old revision stays indexed and is
excluded at recall time once its interval has closed.

## Corpus / BM25 note

FTS5's `bm25()` IDF term collapses toward zero when a query term appears in a tiny corpus, so
a lone matching note can score below the relevance floor and (correctly) not recall at all. If
a fixture needs a note to actually surface, give the corpus a handful of unrelated filler
notes whose text does **not** contain the query term (see existing fixtures). This mirrors the
decoy idiom already used across the unit tests.

## Pending fixture candidates (documented, not yet added)

These §9 cases are intentionally deferred until the paths they exercise land on `main`
(this issue does not add collector/importer wiring, per its "do not relitigate" section):

- **generated-export loop** — "generated exports are not re-ingested." Belongs to the
  collector/importer boundary (the human distiller already refuses `generated/`; see
  `tests/curatedPath.integration.test.ts` §5). Recall-level coverage waits until an export →
  re-ingest path exists to point a recall fixture at.
- **redacted secret** — "secret-like content is redacted before append." Redaction happens at
  the collector boundary (`src/redact.ts`), before a note is ever minted, so it is not a
  recall-gate concern. Add here only if/when a recall-visible redaction assertion is needed.
