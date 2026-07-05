# 015 — src/collector/append.ts

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §4 ("Collector... normalize → redact → validate → append"), §5 (pipeline order: "native event → normalize → redact → validate → append")
**Do not relitigate:** the pipeline order is fixed by the spec — redact **then** validate **then** append, always in that order, never reordered or made configurable. "Normalize" is a no-op passthrough in v1 (nothing to normalize yet — instrumentation adapters don't exist until roadmap step 6) — don't build normalization machinery for a need that doesn't exist yet.

## Context

Depends on 011 (ndjson append), 013 (redact), 014 (validate). This is the Collector role from §4 made concrete — the one place an event actually lands in the event log for real. Later, task 018's distiller reads what this function wrote.

## Task

Create `src/collector/append.ts` exporting:
```ts
export function appendEvent(logFilePath: string, event: Record<string, unknown>): void
```
Pipeline, in order:
1. Normalize: identity passthrough (a comment noting it's a placeholder for future instrumentation-specific normalization is fine — one line, not a paragraph).
2. Redact: if the event has a `command` field (string), run it through `redact()` (013) and replace it. If it has a `prompt` field (string, for `PromptEvent`), redact that too (§5: "Applies to prompts as well as commands").
3. Validate: `validateEvent()` (014) — let it throw; don't catch and swallow.
4. Append: `appendRecord(logFilePath, event)` (011).

Create `tests/collector/append.test.ts`: appending a golden example event (task 004) to a temp file results in a file `readAll` can read back with the same content; appending an event whose `command` contains a plausible pre-redaction secret string results in the persisted record's `command` containing `[REDACTED:...]`, not the original secret; appending an invalid event (missing `event_id`) throws and the temp log file is not created/modified.

## Done-check

```
npm test
```
Expect: `tests/collector/append.test.ts` passes, including the secret-doesn't-reach-disk assertion (read the temp file's raw bytes, not just the parsed object, to be sure the literal secret string isn't present anywhere in the file).
