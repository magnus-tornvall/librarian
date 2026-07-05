# 021 — src/index/schema.ts (FTS5 migration)

**Phase:** 3 — Walking skeleton
**Dependencies:** none (scaffold merged). Only task that edits `package.json` (installs `better-sqlite3`) — merge it before or apart from anything else touching the lockfile.
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §5 ("BM25-over-SQLite-FTS5 is the one blessed index. No recall provider abstraction."), §11
**Do not relitigate:** FTS5 only, no `sqlite-vec`/vector columns (§5's schema-must-not-block-vector-search rule means don't paint yourself into a corner, but it does **not** mean add vector columns now — those are explicitly deferred, §15/§13 open items). This is the first task that adds a real runtime dependency: `better-sqlite3` (§14 already approved it, "added when the code that needs them lands" — this is that moment).

## Context

Depends on 002 (scaffold). First task in this backlog to `npm install better-sqlite3`. Later tasks (022 indexer, 024 recall query) both open the database this migration creates.

## Task

1. `npm install better-sqlite3` (and its `@types/better-sqlite3` if it helps TS, though native modules sometimes ship their own types — check what's actually needed rather than assuming).
2. Create `src/index/schema.ts` exporting:
   ```ts
   import Database from 'better-sqlite3';
   export function migrate(db: Database.Database): void
   ```
   Creates (if not exists) an FTS5 virtual table, e.g.:
   ```sql
   CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
     note_id UNINDEXED, revision_id UNINDEXED, origin UNINDEXED,
     note_type UNINDEXED, created_at UNINDEXED, search_text
   );
   ```
   (`search_text` is indexer-derived per §5 — this table just needs a column for it; the derivation rule itself lives in task 022, not here.)

Create `tests/index/schema.test.ts`: open an in-memory `better-sqlite3` database (`new Database(':memory:')`), run `migrate()`, query `sqlite_master` (or attempt a trivial `INSERT`/`SELECT` against `notes_fts`) to confirm the table exists and accepts a row; running `migrate()` twice on the same db doesn't throw (idempotent).

## Done-check

```
npm test
```
Expect: `tests/index/schema.test.ts` passes, confirming `better-sqlite3` + FTS5 actually works in this environment (some platforms need a rebuild step for native modules — if `npm install` produces a prebuilt binary mismatch error, that's a real finding to report, not something to route around with a different package).
