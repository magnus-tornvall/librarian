# 019 — src/log/noteLog.ts

**Phase:** 3 — Walking skeleton
**Dependencies:** 009 (`paths.ts`), 011 (`ndjson.ts`).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §11 ("Note-log layout: monthly append-only segments `notes/{yyyy-mm}.ndjson`, never rewritten")
**Do not relitigate:** monthly segmentation by `created_at`'s year-month is fixed — don't switch to daily/single-file/size-based segmentation. This module appends `NoteRevision`/`NoteTombstone` records; it does not validate them (that's a gap this backlog knowingly leaves — see task 026's integration test, which is where validation-shaped confidence actually comes from for v1).

## Context

Depends on 011 (`ndjson.ts` — this module is a thin, segment-aware wrapper around it) and 009 (`paths.ts`, for `DATA_DIR`). Depends conceptually on 018 (the shape of what gets appended) but has no import-time dependency on the distiller. This is where task 018's output actually lands on disk, closing the loop from event to durable note.

## Task

Create `src/log/noteLog.ts` exporting:
```ts
export function appendNote(dataDir: string, note: Record<string, unknown>): void
export function readAllNotes(dataDir: string): unknown[]
```
- `appendNote`: derive the segment filename from `note.created_at` (`YYYY-MM`), write to `<dataDir>/notes/<YYYY-MM>.ndjson` via `appendRecord()` (011).
- `readAllNotes`: read every file under `<dataDir>/notes/*.ndjson` (sorted by filename for determinism) and concatenate via `readAll()` (011).

Create `tests/log/noteLog.test.ts`, using a temp directory (not the real `~/.librarian`) as `dataDir`: append two notes with `created_at` in the same month, confirm they land in one segment file; append a third with a different month, confirm a second segment file is created; `readAllNotes` returns all three regardless of segment.

## Done-check

```
npm test
```
Expect: `tests/log/noteLog.test.ts` passes, and manually confirm (via `fs.readdirSync` in the test or a quick scratch check) that exactly 2 segment files exist after the 3-note test scenario.
