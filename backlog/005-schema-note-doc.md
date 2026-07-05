# 005 — schema/note.md (prose + types)

**Phase:** 1 — Schemas
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §10.2 (note record types + rules + golden-example list)
**Do not relitigate:** §10.2's types are already fully drafted — copy, don't redesign. Note in particular the **V1 revision rule** (§5 "Identity & revisions": only deterministic-ID notes may be revised) and the **distill-only ingestion rule** (§5 "Ingestion: distill-only, two distillers") — this doc explains them, it doesn't get to change them.

## Context

Roadmap item 2 (§12), the note-side counterpart to task 003. Independent of 003/004 — can be done in parallel — but depends on 002 (scaffold).

## Task

Create `schema/note.md` containing:
1. Short prose intro: what a note record is, the two kinds (`NoteRevision`/`NoteTombstone`), and the one-sentence version of the distill-only rule ("nothing enters the note log without a distiller's judgment — `llm` or `human`, no generic import path," §5).
2. The full TypeScript type block from §10.2 (`NoteRecord`, `NoteRevision`, `NoteTombstone`), copied verbatim.
3. The rules paragraph from §10.2 ("`origin` mandatory, denormalized, indexed, fail-closed...").
4. A golden-examples section listing the 5 examples from §10.2, each linking to its file under `schema/examples/note/` (created in task 006):
   - `01-episodic-decision-llm-opencode.json`
   - `02-deterministic-project-summary-rev1.json`
   - `03-deterministic-project-summary-rev2.json`
   - `04-curated-note-human-explicit-id.json`
   - `05-tombstone-via-cli.json`

## Done-check

```
test -f schema/note.md && grep -c '```ts' schema/note.md && grep -c 'schema/examples/note/' schema/note.md
```
Expect: file exists, at least one fenced `ts` block, 5 references to files under `schema/examples/note/`.
