# Review V2: Librarian Consolidated Design

**Reviewed document:** `docs/specs/librarian-design-consolidated.md`  
**Reviewer:** GPT-5.5  
**Date:** 2026-07-04

## Verdict

The architecture is sound and implementable. The major prior gaps around recall precision, human curation, provenance, diagnostics isolation, and prompt rendering are now mostly resolved.

The highest risk is no longer the core architecture. The highest risk is that the walking skeleton reveals practical mismatches in schema, cursoring, redaction, provenance, and recall calibration. Further abstract design review has diminishing returns; the next useful step is schema files plus fixtures.

## Top Findings

### 1. Event log deletion policy conflicts with privacy reality

The event log is described as sacred, append-only, replayable, and never deleted. That is correct as a normal replay model, but too absolute for a personal knowledge system.

Even with redaction-before-append, users will eventually discover a false-negative redaction, private prompt, accidental paste, or legally sensitive record. If the official story is "never deleted," the system has no honest recovery path.

Recommendation: keep append-only as the default invariant, but define an explicit emergency purge procedure. KISS version: `librarian purge-event-range --rewrite-segment` is rare, loud, intentionally breaks replay purity, and records a local audit note outside memory.

### 2. Provenance drill-down is underspecified for source excerpts

The MCP provenance drill-down tool depends on recoverable verbatim source. The current event schema captures prompts, commands, file paths, and session events, but not tool output, file diffs, assistant conclusions, or enough surrounding context to verify many distilled notes.

This creates a risk that provenance looks stronger than it is. A note may cite event IDs correctly while the underlying event log lacks the evidence needed to audit whether the note is faithful.

Recommendation: decide what "verbatim event excerpts" means in v1. If it only means prompts and commands, say that. If faithful note audit is a v1 goal, add either `ToolResultEvent`, assistant message events, or compact diff/output capture with aggressive redaction and size caps.

### 3. Redaction is named but not operationally specified

The design correctly makes redaction-before-append non-negotiable. But the redaction behavior is not yet concrete enough to implement safely.

The spec needs rules for multiline secrets, `.env` contents, private keys, URLs with tokens, command environment variables, pasted JSON blobs, and any future tool outputs.

Recommendation: create `schema/redaction.md` or include redaction rules in `schema/event.md`. Define minimum detectors, replacement format, stable hash salt policy, maximum inspected payload size, and golden negative examples. Redaction deserves first-class fixtures, not just one command example.

### 4. The note schema cannot distinguish uncertainty and contradiction

Injected memory is correctly framed as non-authoritative, but individual notes have no field for epistemic status. A distilled note can represent a firm decision, tentative hypothesis, failed attempt, superseded fact, or observed preference. Today that distinction is compressed into `note_type`, recency, weights, and prose.

Recommendation: do not add a generic confidence framework. If fixtures reveal ambiguity, add one small field such as `status?: "active" | "tentative" | "superseded" | "failed"`. At minimum, specify that failed attempts must be rendered as failed attempts and must not be injected as recommendations.

### 5. Supersession is only partially solved

The design handles deterministic revisions and tombstones, and it has a negative fixture for superseded decisions. But the schema has no explicit way to say one note supersedes another, and recall has no concrete suppression rule for older episodic notes that conflict with newer curated or deterministic notes.

Recommendation: use the existing `links` field minimally. Allow `relation: "supersedes"` and make recall suppress the target when the source is in scope and higher authority. This uses the current schema and avoids building entity resolution.

### 6. Project identity still has edge cases that will affect recall quality

The design fixes SuperBrain's late project-slug bug by deriving authoritative project scope at distill/index time. But the derivation rule itself is not yet defined.

Edge cases matter: basename collisions, renamed directories, monorepos, linked worktrees, no-git folders, forks with the same basename, and local-only projects.

Recommendation: specify scope matching before implementation. Prefer `git_remote` or normalized `git_root` as the primary match key and treat `project_slug` as display or fallback. Slug-only matching will eventually fail.

### 7. Diagnostics should record what the model actually saw

Injection traces record query, candidates, scores, cuts, shipped records, indexed-through, and config. That is strong. But if the renderer changes, a trace may not reproduce the exact injected text.

Recommendation: store either the final rendered injected block or a hash plus renderer version/config. Since diagnostics are deletable and structurally isolated from memory, storing the rendered block is acceptable and makes `librarian why` much more useful.

### 8. Collector ownership of all rendering is slightly overloaded

The spec says the collector owns the prompt renderer. That is fine for v1, but rendering now covers distill prompts, injection blocks, MCP results, and possible future task-specific shapes. This can turn the collector into a god module.

Recommendation: keep the implementation simple but name the renderers as concrete functions or modules: `renderDistillPrompt`, `renderInjectionBlock`, and `renderMcpResult`. They can live in the collector package without making the collector conceptually responsible for every future LLM-facing serialization.

### 9. `ContentEvent` deferral is reasonable, but the event union may harden too early

The design reserves `ContentEvent` for non-agent sources and defers the shape until the first concrete integration. That is the right KISS decision.

The risk is that `CanonicalEvent = PromptEvent | ToolEvent | SessionEvent` becomes too agent-centric and later email, web, or document ingestion feels bolted on.

Recommendation: in `schema/event.md`, explicitly state that v1 validators reject unknown `type`s but the schema reserves `content` as a future top-level event type. Do not implement it yet.

### 10. Token budget needs a deterministic v1 rule

The injection budget is intentionally approximate at 300-700 tokens. Implementation still needs deterministic truncation. Exact provider tokenization varies and adding tokenizer dependencies early is unnecessary.

Recommendation: define v1 budgeting as approximate character budgeting, not exact token counting. Example: `max_chars = target_tokens * 4`, with hard truncation by note boundary first, then field elision. Add a tokenizer only if evidence says the approximation hurts.

## Strong Choices To Keep

- Two append-only logs plus independent consumers are justified.
- Human curated notes bypassing LLM normalization is correct.
- Diagnostics as structurally isolated poison-pill records is excellent.
- BM25-only v1 is the right KISS call.
- Re-ranking before vectors is the right future trigger.
- Stable-prefix and volatile-suffix injection layout is well-grounded.
- The roadmap order is now correct: schemas, then walking skeleton.

## Recommended Additions Before Coding

1. Add an emergency purge rule to durability and safety.
2. Add precise `project_slug` and scope matching rules.
3. Add redaction fixtures and minimum redactor behavior.
4. Decide whether v1 provenance drill-down shows only prompts and commands or must include tool results and diffs.
5. Store the rendered injected block, or at least renderer version plus hash, in injection diagnostics.
6. Define recall suppression for `links.relation = "supersedes"`, or explicitly defer it.

## Implementation Guidance

Do not keep polishing the consolidated design much further. Create `schema/event.md` and `schema/note.md` with golden examples, then build the walking skeleton.

The first real fixture run will reveal more than another review round.
