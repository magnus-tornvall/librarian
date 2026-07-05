# 022 — src/index/indexer.ts

**Phase:** 3 — Walking skeleton
**Dependencies:** 012 (cursor), 019 (note log), 021 (FTS5 schema).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §4 ("Indexer: note-log consumer... derives `search_text` by fixed concatenation rule; indexes `origin` as a filterable column; fail-closed: records missing `origin` are excluded"), §5 ("`search_text` is indexer-derived (fixed concatenation rule over title/summary/bullets/details/scope/links), never a record field")
**Do not relitigate:** the fail-closed-on-missing-`origin` rule is not a warning-and-continue — a note without `source.origin` must be skipped from indexing, not indexed with a null/empty origin. `search_text` is computed here and only here; it must never be read from or written into the note record itself.

## Context

Depends on 019 (reads the note log), 021 (writes into the FTS5 table), and 012 (cursor, so re-running the indexer doesn't re-index everything from scratch every time). This is "latest-revision-wins by `note_id`" (§5) made concrete on the read side — the walking skeleton's recall step (024) queries what this task writes.

## Task

Create `src/index/indexer.ts` exporting:
```ts
export function indexNotes(db: Database.Database, dataDir: string, cursorPath: string): number // returns count newly indexed
```
Steps:
1. Read cursor (012); if none, start from the beginning.
2. Read all notes (019) — for v1 walking-skeleton scope, re-reading everything and relying on an `INSERT OR REPLACE`-style upsert keyed by `note_id` is acceptable (true incremental byte-offset tracking via the cursor is the eventual target per §5, but don't over-build the cursor-precision here at the expense of finishing the task — note in a comment that this is the simplification, per §14's "task size sanity check").
3. For each `NoteRevision` (skip `NoteTombstone`s — v1 doesn't remove from the index yet, that's a real gap, name it in a code comment rather than silently ignoring it): if `source.origin` is missing/empty, **skip** (fail-closed). Otherwise compute `search_text` = `[title, body.summary, ...(body.bullets ?? []), body.details ?? '', scope.project_slug ?? '', ...links.map(l => l.target)].filter(Boolean).join(' ')`. Upsert into `notes_fts` keyed by `note_id`, keeping the row with the latest `created_at` when multiple revisions of the same `note_id` exist (delete-then-insert is fine for FTS5).
4. Advance the cursor.

Create `tests/index/indexer.test.ts`, using an in-memory db + temp `dataDir`: index the note log built from appending task 018's example note (via `noteLog.ts`, 019) plus a second note missing `source.origin` (hand-constructed, bypassing the distiller) — assert the FTS5 table has exactly 1 row (the origin-having one), and that its `search_text` contains the note's title and summary text.

## Done-check

```
npm test
```
Expect: `tests/index/indexer.test.ts` passes, explicitly asserting the missing-origin note did **not** get indexed (query `SELECT COUNT(*) FROM notes_fts` and check it's 1, not 2).
