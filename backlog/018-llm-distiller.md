# 018 — src/distill/llmDistiller.ts

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §4 ("LLM distiller: consumer of the event log via an inference provider; admission control"), §10.2 (note shape + rules), §5 (provenance is collector-stamped: "the renderer presents events with ordinal indexes; the LLM cites indexes; the collector maps indexes → ULIDs")
**Do not relitigate:** the distiller does not invent `note_id`/`revision_id`/provenance from LLM output — it stamps those mechanically after the LLM returns content. The LLM's job is judgment (is this worth remembering, what type, what summary); the code's job is identity and provenance. Don't let the LLM's response dictate `event_id`s or `note_id` — those come from the code side.

## Context

Depends on 016 (renderer, to build the prompt) and 017 (provider interface, to call it — using `makeFixtureProvider` in tests, never a live call). This is the heart of roadmap item 4: the first time an event range becomes a note. It does not yet write to the note log (that's task 019) — this task's function returns a `NoteRevision` object; wiring it to disk is the next task.

## Task

Create `src/distill/llmDistiller.ts` exporting:
```ts
export async function distill(
  events: Array<Record<string, unknown>>,
  sessionId: string,
  provider: InferenceProvider,
  origin: string,
): Promise<NoteRevision>
```
Steps:
1. Render `events` via `renderEventsForDistill()` (016), wrap in a short instruction (ask for JSON: `note_type`, `title`, `summary`, `bullets?`).
2. Call `provider.complete(prompt)`.
3. `JSON.parse` the response — on parse failure, throw (no retry in this task, per 017's scope note).
4. Stamp mechanically (not from the LLM response): `note_id` = `` `${origin}:${ulid()}` `` (episodic — see §5 V1 revision rule, this path never produces a deterministic-ID note), `revision_id` = new ULID, `created_at` = current ISO timestamp, `identity: { mode: "episodic" }`, `source: { origin, distiller: "llm" }`, `provenance: { session_id: sessionId, event_ids: events.map(e => e.event_id) }`.
5. Merge the LLM-provided `note_type`/`title`/`body.summary`/`body.bullets` into the final `NoteRevision`, matching §10.2's shape exactly.

You'll need a minimal ULID generator — a small hand-rolled function is fine (timestamp + random base32 suffix); don't add a `ulid` npm dependency for this (§5 anti-generic-abstraction / minimal-deps stance) unless you judge the hand-rolled version genuinely risks ID collisions in tests — if so, note that judgment call in the commit message rather than silently deciding it doesn't matter.

Create `tests/distill/llmDistiller.test.ts`: using `makeFixtureProvider(JSON.stringify({ note_type: 'decision', title: 'Expire check before redirect', summary: 'Fixed login redirect loop by checking token expiry before redirect.' }))` and the 4 fixture events (010), assert the returned object has `kind` implicitly satisfied by shape (no `kind` field needed per §10.2 — `NoteRevision` has no `kind` discriminant, only `NoteTombstone` needs distinguishing at the union level; check the type again if unsure), `source.distiller === 'llm'`, `source.origin` matches what was passed in, and `provenance.event_ids` has length 4 matching the input events' `event_id`s.

## Done-check

```
npm test
```
Expect: `tests/distill/llmDistiller.test.ts` passes with no live network/process calls (verify by checking the test doesn't import or shell out to `claude` anywhere).
