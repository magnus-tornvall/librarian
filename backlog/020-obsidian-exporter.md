# 020 — src/export/obsidian.ts

**Phase:** 3 — Walking skeleton
**Dependencies:** none hard (its test uses a hand-built note object). Soft: 005 (note shape), 008 (the invariants doc it enforces — spec §5 suffices if 008 is not merged yet).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §4 ("Exporters: note-log consumers; idempotent by `note_id`... Obsidian exporter first"), §5 ("Human curation" vault split), `docs/specs/structural-invariants.md` (task 008)
**Do not relitigate:** this exporter writes **only** to `vault/generated/**`, never to `vault/curated/**` — that boundary is the structural invariant from task 008, not a style choice. Idempotency is by `note_id` (overwrite the same path on re-export), not by content diffing or a "has this changed" check — keep it that simple per §5's minimal-abstraction stance.

## Context

Depends on 011 (reuses nothing directly, but same file-writing idioms) and conceptually on 008 (must respect the generated/curated split it documents) and 019 (the note shape it renders — though this task can be built and tested against a hand-built note object without actually calling `noteLog.ts`). This is the first thing in Phase 3 that produces a human-readable artifact.

## Task

Create `src/export/obsidian.ts` exporting:
```ts
export function exportNoteToVault(vaultDir: string, note: Record<string, unknown>): string // returns the written file path
```
- Deterministic path: `<vaultDir>/generated/<note.note_type>/<note.note_id-with-":" replaced by "-">.md` (colons aren't safe in filenames on all platforms — sanitize).
- File content: YAML frontmatter with `librarian_generated: true`, `note_id`, `note_type`, `origin` (from `note.source.origin`), `created_at`; then `<!-- librarian:generated; do not edit -->`; then `# <note.title>`; then `note.body.summary`; then, if present, `note.body.bullets` as a Markdown list.
- Always overwrite (idempotent by `note_id` mapping to the same path — re-exporting the same note_id at a new revision replaces the file's content, doesn't create a second file).

Create `tests/export/obsidian.test.ts`, using a temp `vaultDir`: export a note built from task 018's example shape, confirm the file exists at the expected path under `generated/`, confirm the frontmatter contains `librarian_generated: true`, confirm exporting a second note with the same `note_id` but different `title` overwrites (still exactly one file for that `note_id`, with the new title).

## Done-check

```
npm test
```
Expect: `tests/export/obsidian.test.ts` passes. Grep the temp vault dir in the test (or manually once) to confirm nothing was ever written under `curated/`.
