# 014 — src/collector/validateEvent.ts

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §10.1 (event rules), §8 (poison-pill: "diagnostic records carry `record_class: 'diagnostic'`... every ingestion-side validator hard-rejects them")
**Do not relitigate:** no schema-validation library (§14 test convention's spirit extends here too — plain functions, not zod/ajv, per §5's anti-generic-abstraction stance). The diagnostic hard-reject is not optional and not a warning — it must throw, matching §8's "quarantine-with-error, not silent skip."

## Context

Depends on 003/004 (the event shape and golden examples to validate against) and 009 (not a hard code dependency, but conceptually this is where §8's diagnostics-isolation invariant — documented in 008 — gets its first real enforcement point). This validator is what task 015's collector calls before appending anything.

## Task

Create `src/collector/validateEvent.ts` exporting:
```ts
export function validateEvent(record: unknown): void // throws on invalid, returns void on valid
```
Checks, in order:
1. If `record` has `record_class === "diagnostic"` (or any `record_class` field at all — canonical events never have one), throw a distinct error (e.g. `DiagnosticRecordRejectedError`) — this is the hard-reject.
2. `schema_version === 1`.
3. `type` is one of `"prompt" | "tool" | "session"`.
4. Required base fields present: `event_id` (string), `ts` (string), `resource` (object with `agent`, `machine_id`, `cwd`), `context` (object with `session_id`, `cwd`).
5. Type-specific required fields: `prompt` string on `PromptEvent`; `tool.native_name`/`tool.canonical_name`/`tool.category` on `ToolEvent`; `action` on `SessionEvent`.

Throw a plain `Error` with a message naming the missing/wrong field for cases 2–5; throw the distinct diagnostic-rejection error for case 1 so callers (and tests) can tell the two failure modes apart.

Create `tests/collector/validateEvent.test.ts`: all 5 golden examples from `schema/examples/event/` (task 004) pass; a record with `record_class: "diagnostic"` throws the distinct error; a record missing `event_id` throws a plain error; a `PromptEvent` missing `prompt` throws.

## Done-check

```
npm test
```
Expect: `tests/collector/validateEvent.test.ts` passes, all 5 golden examples validate clean.
