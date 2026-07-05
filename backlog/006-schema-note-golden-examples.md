# 006 — schema/examples/note/*.json (5 golden examples)

**Phase:** 1 — Schemas
**Dependencies:** 005 (types + example filenames in `schema/note.md`).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §10.2 (golden-example list) and §14 ("Golden examples: extracted")
**Do not relitigate:** same extraction convention as task 004. Revision chaining (rev1 → rev2) must actually use matching `note_id` and `previous_revision_id` — this is the one place the V1 revision rule (§5) becomes concrete data, get it right rather than approximate.

## Context

Depends on 005 (needs the types and example names/links in `schema/note.md`). Like task 004, these double as fixtures for later tests (§9) — valid JSON matching the `NoteRecord` union, not illustrative text.

## Task

Create 5 files under `schema/examples/note/`, matching the names from task 005:

1. `01-episodic-decision-llm-opencode.json` — `NoteRevision`, `identity.mode: "episodic"`, `source.distiller: "llm"`, `source.origin: "opencode"`, `note_type: "decision"`.
2. `02-deterministic-project-summary-rev1.json` — `NoteRevision`, `identity.mode: "deterministic"`, `identity.key: "project:librarian:summary"`, `note_type: "project_summary"`, no `previous_revision_id`.
3. `03-deterministic-project-summary-rev2.json` — same `note_id` as file 2, new `revision_id`, `previous_revision_id` pointing at file 2's `revision_id`, `note_type: "project_summary"`.
4. `04-curated-note-human-explicit-id.json` — `NoteRevision`, `source.distiller: "human"`, `note_type: "curated"`, an explicit `note_id` in a form a human would plausibly choose (per §5 curated frontmatter, e.g. `curated:author-context`), `body.details` holding verbatim Markdown-ish text (not LLM-summarized).
5. `05-tombstone-via-cli.json` — `NoteTombstone`, `source.kind: "cli"`, `previous_revision_id` referencing any plausible prior revision id, a `reason` string.

Every `NoteRevision` needs the full shape from §10.2: `identity`, `source`, `note_type`, `title`, `scope`, `provenance`, `links` (can be `[]`), `body.summary`.

## Done-check

```
for f in schema/examples/note/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f OK"; done
node -e "
const a = require('./schema/examples/note/02-deterministic-project-summary-rev1.json');
const b = require('./schema/examples/note/03-deterministic-project-summary-rev2.json');
if (a.note_id !== b.note_id) throw new Error('note_id mismatch');
if (b.previous_revision_id !== a.revision_id) throw new Error('revision chain broken');
console.log('revision chain OK');
"
```
Expect: 5 files parse OK, and the revision-chain check prints `revision chain OK`.
