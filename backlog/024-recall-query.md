# 024 — src/recall/query.ts

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §6 ("Push path... 0–5 records per prompt, never force-filled... Require project match or explicit global scope")
**Do not relitigate:** the 0–5 cap and "never force-filled" rule mean this function must be able to return **zero** results without erroring or padding with low-relevance filler — an empty result is a correct, expected output, not a failure mode to work around. This task implements the push-path rules specifically (§6 is explicit that "austerity rules above are push-path rules" — the MCP pull-path's looser ~10-result rule is a different, later task, not this one).

## Context

Depends on 021 (FTS5 table to query) and 023 (scoring). This is where "recall" as a concept becomes runnable — feed it a query string, get back 0–5 notes.

## Task

Create `src/recall/query.ts` exporting:
```ts
export function recall(
  db: Database.Database,
  query: string,
  opts: { projectSlug?: string; global?: boolean },
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  nowIso: string = new Date().toISOString(),
): Array<ScoredCandidate & { score: number }>
```
1. Run an FTS5 `MATCH` query against `notes_fts.search_text`, pulling `bm25(notes_fts)` as the raw score (note: FTS5's `bm25()` returns *lower-is-better* — negate or invert it before feeding to `scoreCandidate`, and say so in a comment so nobody "fixes" the sign later).
2. Map rows to `ScoredCandidate[]`, setting `is_project_match` from whether the row's stored project info matches `opts.projectSlug` (v1: if the indexer isn't yet storing project scope per row, `is_project_match` can default to `false` for now with a comment noting the gap — don't block this task on backfilling scope data that's genuinely a later concern).
3. `rankAndFilter()` (023), then: if neither `opts.projectSlug` nor `opts.global` is set, return `[]` (the "require project match or explicit global scope" rule) — otherwise slice to the top 5.

Create `tests/recall/query.test.ts`, using the in-memory db from 021/022's pattern: index a note whose `search_text` clearly matches a test query, then confirm `recall(db, query, { global: true })` returns it; confirm `recall(db, query, {})` (neither project nor global) returns `[]` even though the note would otherwise match; confirm a query matching nothing returns `[]`, not an error.

## Done-check

```
npm test
```
Expect: `tests/recall/query.test.ts` passes, including the empty-scope-returns-empty and no-match-returns-empty cases.
