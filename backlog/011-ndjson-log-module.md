# 011 — src/log/ndjson.ts (append/read-all)

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §4 (logs are "append-only, replayable, never deleted"), §5 ("partial trailing JSON lines ignored until completed")
**Do not relitigate:** this is a generic-looking module but must stay narrow — one file's worth of append/read, not a database abstraction, not a generic `Log<T>` class hierarchy (§5 "Deleted / deferred": generic storage layer rejected). Keep it to plain functions over a file path.

## Context

The lowest-level building block for both the event log and the note log (tasks 015 and 019 both build on this). Depends on 002 (scaffold) only — no dependency on the fixture or paths module, this is pure file I/O.

## Task

Create `src/log/ndjson.ts` exporting two functions:
```ts
export function appendRecord(filePath: string, record: unknown): void
export function readAll(filePath: string): unknown[]
```
- `appendRecord`: `JSON.stringify(record) + '\n'`, appended (create the file and any parent directories if they don't exist; use `fs.mkdirSync(dir, { recursive: true })` then `fs.appendFileSync`).
- `readAll`: read the whole file, split on `\n`, `JSON.parse` each non-empty line, **skip a trailing line that fails to parse** (the "partial trailing line" case from §5) rather than throwing — but a malformed line that is *not* the last line should still throw (that's real corruption, not an in-progress write).

Create `tests/log/ndjson.test.ts` covering: append then read-all round-trips correctly; reading a file with a truncated final line silently drops it; reading a nonexistent file returns `[]` (don't throw — nothing's been appended yet is a normal state, not an error).

## Done-check

```
npm test
```
Expect: `tests/log/ndjson.test.ts` passes. Manually verify by hand once: append 2 records, then append a raw truncated JSON fragment directly to the file with `fs.appendFileSync`, and confirm `readAll` still returns exactly 2 records.
