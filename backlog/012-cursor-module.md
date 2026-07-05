# 012 — src/log/cursor.ts

**Phase:** 3 — Walking skeleton
**Dependencies:** none hard. Soft: 011 (mirrors its dir-creation idiom; no import — workable in parallel with 011).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §5 ("Cursors: `{consumer, log_name, file_path, byte_offset, last_record_id?, updated_at}`; advance only after successful processing")
**Do not relitigate:** the cursor shape is already specified — use those exact field names. Don't add retry/backoff logic here (§5 mentions "bounded retries" as a separate concern from cursor storage itself; this task is just read/write the pointer).

## Context

Depends on 011 (cursor state itself is small enough to persist as a single JSON file, not NDJSON — but reuse `node:fs` patterns, not `ndjson.ts`'s functions, since a cursor is one mutable record, not an append-only sequence). Every consumer in Phase 3 that reads a log incrementally (the distiller reading the event log, the indexer reading the note log) will use this in a later task.

## Task

Create `src/log/cursor.ts` exporting:
```ts
export type Cursor = {
  consumer: string; log_name: string; file_path: string;
  byte_offset: number; last_record_id?: string; updated_at: string;
};
export function readCursor(cursorPath: string): Cursor | null
export function advanceCursor(cursorPath: string, cursor: Cursor): void
```
- `readCursor`: returns `null` if the file doesn't exist (first run, nothing processed yet — not an error).
- `advanceCursor`: writes the cursor as pretty-printed JSON, creating parent dirs as needed (mirror `appendRecord`'s dir-creation approach from 011).

Create `tests/log/cursor.test.ts`: read a nonexistent cursor returns `null`; write then read round-trips all fields; writing twice overwrites (not appends) — a cursor file always holds exactly one JSON object, never a growing list.

## Done-check

```
npm test
```
Expect: `tests/log/cursor.test.ts` passes.
