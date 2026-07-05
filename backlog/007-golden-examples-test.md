# 007 — tests/schema/goldenExamples.test.ts

**Phase:** 1 — Schemas
**Dependencies:** 004 and 006 (reads both golden-example sets from disk).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §9 (qualification fixtures), §14 ("Test convention")
**Do not relitigate:** §14: black-box test, no schema-validation library (no zod/ajv) — a runtime shape check is a handful of `typeof`/`in` checks, not a framework. That restraint is deliberate (§5 "Deleted / deferred": no generic abstraction where concrete functions do).

## Context

Depends on 004 and 006 (needs both golden-example sets on disk). This is the first real test in the repo (002's smoke test doesn't count) and the first thing that actually reads the golden JSON files — it's also the seed of the "provider qualification fixtures" idea from §9, minus the LLM-in-the-loop part which comes later (task 018).

## Task

Create `tests/schema/goldenExamples.test.ts`:
1. Read every `*.json` file under `schema/examples/event/` and `schema/examples/note/` (use `node:fs` + `node:path`, glob by reading the directory — no glob library dependency).
2. For each event file: assert it parses as JSON, has `schema_version === 1`, a non-empty string `event_id`, `ts`, `resource`, `context`, and a `type` field that is one of `"prompt" | "tool" | "session"`.
3. For each note file: assert it parses as JSON, has `schema_version === 1`, a `kind` field that is `"note_revision"` or `"note_tombstone"`, and — for `note_revision` — a non-empty `source.origin` string and `source.distiller` in `["llm", "human"]` (this is the fail-closed-on-missing-`origin` rule from §5, exercised here as a smoke check, not yet as the real indexer gate — that's task 022).
4. Use one `test(...)` per file (or per directory) so a failure names the specific bad fixture.

## Done-check

```
npm test
```
Expect: all tests pass, including the new ones under `tests/schema/`. Break one golden example temporarily (e.g. delete `schema_version` from a copy) to confirm the test actually fails loudly, then revert — don't leave the repo in the broken state.
