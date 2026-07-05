# 016 — src/render/distillPrompt.ts

**Phase:** 3 — Walking skeleton
**Dependencies:** 003 (event types), 010 (fixture its test renders).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §7 ("Distill prompts render events as indexed compact text... ordinal indexes are already required for collector-stamped provenance")
**Do not relitigate:** §7's category rule — "storage formats optimize for machines... prompt formats optimize for signal-per-token. They meet only at the renderer" — means this function reads events and produces a string; it must never be handed a raw NDJSON blob to pass through unmodified, and it must never write anything back to a log. Field elision (drop `machine_id`, `schema_version`, collapse timestamps) is the point, not accidental data loss.

## Context

Depends on 010 (fixture events to render) and the event types (003). This is the read side of the renderer §7 describes; the exact example format is given in the spec — reproduce its shape, don't invent a new one. Feeds directly into task 018's distiller.

## Task

Create `src/render/distillPrompt.ts` exporting:
```ts
export function renderEventsForDistill(events: Array<Record<string, unknown>>): string
```
For each event, in order, emit one line: `[<ordinal>] <HH:MM> <kind-specific summary>  ← salient:<reason>` (the `← salient:...` suffix only present when `hints.possibly_salient` is true). Ordinal is 1-based index into the array (this is the "collector-stamped provenance" index — the LLM will cite these ordinals, and a later task maps them back to `event_id`s, but that mapping is out of scope here; this task only renders).

Kind-specific summary:
- `prompt`: `` prompt "<prompt text, redacted-already assumed>" ``
- `tool` with `category: "file_write"` or similar: `` write <files[0].path> `` (join multiple files with `, ` if more than one)
- `tool` with `category: "vcs_commit"`: `` bash: <command> ``
- `session`: `` session: <action> ``

Reproduce the exact §7 example almost verbatim using `fixtures/events/session-001.ndjson` (010) as input — that fixture was deliberately shaped to match it.

Create `tests/render/distillPrompt.test.ts`: render the 4 events from `fixtures/events/session-001.ndjson`, assert the output is a 4-line string, line 1 contains the prompt text, line 3 (the commit) ends with the commit message and has no `← salient` marker unless that event actually set `hints.possibly_salient`.

## Done-check

```
npm test
```
Expect: `tests/render/distillPrompt.test.ts` passes. Print the rendered output once by hand (`node --input-type=module -e "..."` or a scratch script) and visually confirm it reads like §7's example.
