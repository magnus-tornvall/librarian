# 026 — tests/walkingSkeleton.integration.test.ts (capstone)

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §12 roadmap item 4 ("Walking skeleton: fixture events → renderer → LLM distill → note log → Obsidian export → BM25 index → recall query with floor + weights + injection trace. Ugly internals, real data.")
**Do not relitigate:** this test wires together tasks 010–025 exactly as the roadmap names the stages, in that order. It uses the fixture inference provider (017) — **not** a live `claude -p` call, matching §14's test convention. If this test tempts you to add a new abstraction "to make the wiring cleaner," don't — §5's whole point is that the walking skeleton is allowed to be ugly; cleanup is deliberately a later, separate concern (§12: "revise the note schema from what the skeleton teaches" happens *after* this lands, not during).

## Context

Depends on every task in Phase 3 (010–025) being merged. This is the roadmap-4 capstone and the last task in this backlog — after this, the spec says to revise the note schema based on what got learned, and to explode roadmap items 5+ into new backlog tasks (explicitly out of scope for this backlog, per `docs/plans/implementation-plan.md`'s "What's deliberately not in this plan").

## Task

Create `tests/walkingSkeleton.integration.test.ts`, using temp directories for everything (data dir, vault dir, diagnostics dir, in-memory SQLite) so the test never touches a real `~/.librarian`:

1. Read `fixtures/events/session-001.ndjson` (010) with `readAll()` (011).
2. Append each event to a temp event log via `appendEvent()` (015).
3. Read them back, render via `renderEventsForDistill()` (016) (sanity: non-empty string).
4. Distill via `distill()` (018) using `makeFixtureProvider()` (017) with a canned decision-note response.
5. Append the resulting note via `appendNote()` (019).
6. Export it via `exportNoteToVault()` (020); assert the file exists under the temp vault's `generated/`.
7. Migrate + index: `migrate()` (021) on an in-memory db, `indexNotes()` (022) against the temp data dir.
8. Query: `recall(db, '<a term from the note's title/summary>', { global: true })` (024); assert it returns exactly one result and that result's `note_id` matches the distilled note's `note_id`.
9. Write an injection trace via `writeInjectionTrace()` (025) recording that query and result; read it back and assert `shipped_note_ids` contains the note's `note_id`.

Every step's assertion should name which stage failed if it fails (separate `assert` calls per step, not one giant assertion at the end) — this test doubles as the map of the pipeline for whoever reads it next.

## Done-check

```
npm test
```
Expect: the full suite passes, including this integration test. This is also the moment to run `npm test` one final time from a clean `node_modules` (`rm -rf node_modules && npm install && npm test`) to confirm nothing in Phase 3 accidentally depends on leftover local state from earlier manual testing.
