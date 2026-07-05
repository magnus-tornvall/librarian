# Librarian — Implementation Plan

**Status:** active. Companion to `docs/specs/librarian-design-consolidated.md` (v4) — that document is the spec; this document is the work breakdown. If the two disagree, the spec wins and this plan is stale.

**Execution model (§14):** every task below is a `backlog/<NNN>-<slug>.md` file, written to be picked up by a coding agent in a fresh session with no memory of this plan. See `backlog/README.md` for the file convention. This plan is the map; the backlog files are the territory.

## Phases

Phases 1–3 below implement roadmap items 1–4 from the spec (§12). Phase 0 is scaffolding the spec doesn't cover in detail because repo bootstrap is explicitly deferred (§14) — it's the minimum needed for any later task to have somewhere to put code, kept intentionally small so it doesn't front-run the deferred decisions (license, package metadata, final layout).

### Phase 0 — Scaffold (minimal, revisit later)
Not itself a spec roadmap item. Unblocks everything else.
- 001 — package.json + tsconfig.json
- 002 — `node --test` smoke test

### Phase 1 — Schemas (roadmap items 1–2, spec §10)
Each schema file is prose + TypeScript types + golden JSON examples (§14: examples extracted, not inlined).
- 003 — `schema/event.md` (prose + types, §10.1)
- 004 — `schema/examples/event/*.json` (5 golden examples)
- 005 — `schema/note.md` (prose + types, §10.2)
- 006 — `schema/examples/note/*.json` (5 golden examples)
- 007 — golden-examples test (loads every extracted JSON file, asserts required-field shape)

### Phase 2 — Structural invariants (roadmap item 3, spec §5/§8/§11)
- 008 — `docs/specs/structural-invariants.md`: curated-note ingestion + generated-file exclusion + diagnostics isolation, as one short doc (the three structural invariants together, per §12 item 3)
- 009 — `src/paths.ts`: `~/.librarian/{data,diagnostics,machine-id,config.json}` constants + test asserting diagnostics root ≠ data root (the isolation invariant starts being true in code here, not just in prose)

### Phase 3 — Walking skeleton (roadmap item 4, spec §12 item 4)
Fixture events → renderer → LLM distill → note log → Obsidian export → BM25 index → recall with floor + weights + injection trace. Decomposed into one module + one black-box test per task (§14 test convention). Sequential dependency chain — later tasks assume earlier ones are merged.

- 010 — `fixtures/events/session-001.ndjson` (static fixture, shape matches §10.1)
- 011 — `src/log/ndjson.ts` (append/read-all)
- 012 — `src/log/cursor.ts` (§5 cursor contract)
- 013 — `src/redact.ts` (§5 redaction-before-append)
- 014 — `src/collector/validateEvent.ts` (§10.1 rules; hard-reject `record_class: diagnostic` per §8)
- 015 — `src/collector/append.ts` (wires 011+012+013+014 — the Collector role, §4)
- 016 — `src/render/distillPrompt.ts` (§7 indexed compact text)
- 017 — `src/distill/provider.ts` (inference-provider interface + fixture stub, §5)
- 018 — `src/distill/llmDistiller.ts` (§4 LLM distiller; produces a `NoteRevision`, §10.2)
- 019 — `src/log/noteLog.ts` (§11 monthly segments)
- 020 — `src/export/obsidian.ts` (§5 vault split — `generated/` only, at this stage)
- 021 — `src/index/schema.ts` (FTS5 migration, §5)
- 022 — `src/index/indexer.ts` (§4 Indexer role; `search_text` derivation, fail-closed on missing `origin`)
- 023 — `src/recall/scoring.ts` (§6 weights + recency decay + relevance floor, pure function)
- 024 — `src/recall/query.ts` (§6 push-path budget: 0–5 records, never force-filled)
- 025 — `src/diagnostics/injectionTrace.ts` (§8 injection trace record)
- 026 — `tests/walkingSkeleton.integration.test.ts` (capstone: fixture → append → distill → note log → index → recall → assert injected content + injection trace)

## What's deliberately not in this plan

- Roadmap items 5–11 (curated Markdown ingestion, real instrumentation, MCP server, push adapters, hardening, second provider/exporter, non-agent integrations). Not exploded into backlog tasks yet — the prompt that produced this plan scoped backlog generation to roadmap items 1–4. Explode the next phase only after the walking skeleton (026) is merged and has taught whatever it's going to teach about the note schema (§12 says as much: "revise the note schema from what the skeleton teaches").
- Anything the spec explicitly deferred (§5 "Deleted / deferred", §13/§15 "Open items"). Building those now would be relitigating a settled decision.

## Task sizing

Every task is sized so implementation + verification fits in roughly 15 minutes for an agent already oriented by the task file's context section (§14, "task size sanity check"). Where a natural unit of work exceeded that (the walking skeleton), it was split by pipeline stage — one module, one done-check, one file — rather than by arbitrary line count.
