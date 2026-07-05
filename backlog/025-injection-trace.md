# 025 — src/diagnostics/injectionTrace.ts

**Phase:** 3 — Walking skeleton
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §8 ("Injection trace per injection: `injection_id`... query, candidate `note_id`s with raw and post-weight scores, cut reasons... records shipped, `indexed_through`, and a config snapshot")
**Do not relitigate:** this file writes to `~/.librarian/diagnostics/` (via `paths.ts`, 009), never into the vault and never into the note log — that's the structural isolation from §8/task 008, and it applies here as code, not just as a rule someone has to remember. The trace record's own shape must **not** validate as a canonical event or note (it's fine, even correct, that it would be hard-rejected by `validateEvent.ts`, 014, if it were ever mistakenly fed into the collector — that's the poison-pill property working as intended).

## Context

Depends on 011 (append machinery), 009 (`DIAGNOSTICS_DIR`), and conceptually on 024 (this records what a `recall()` call decided). This is the last piece before the capstone integration test wires everything together.

## Task

Create `src/diagnostics/injectionTrace.ts` exporting:
```ts
export type InjectionTrace = {
  record_class: "diagnostic";
  injection_id: string;
  ts: string;
  query: string;
  candidates: Array<{ note_id: string; raw_score: number; post_weight_score: number; cut_reason?: "below_floor" | "budget" | "scope_mismatch" }>;
  shipped_note_ids: string[];
  indexed_through: string;
  config_snapshot: unknown;
};
export function writeInjectionTrace(diagnosticsDir: string, trace: InjectionTrace): void
export function makeInjectionId(): string
```
`writeInjectionTrace` appends to `<diagnosticsDir>/injections/<yyyy-mm>.ndjson` via `appendRecord()` (011) — same monthly-segment idea as the note log (019), reused because §8 says diagnostics use "the same NDJSON/cursor machinery." `makeInjectionId` can reuse whatever ULID approach task 018 settled on (don't invent a second one).

Create `tests/diagnostics/injectionTrace.test.ts`: write a trace to a temp diagnostics dir, read the segment file back with `readAll()` (011), confirm the record round-trips including `record_class: "diagnostic"`; separately, feed the same trace object into `validateEvent()` (014) and assert it throws the diagnostic-rejection error — this is the cross-check that the poison-pill property (§8) actually holds between these two modules, not just in prose.

## Done-check

```
npm test
```
Expect: `tests/diagnostics/injectionTrace.test.ts` passes, including the cross-module poison-pill assertion against `validateEvent()`.
