# Backlog convention

Each file in this directory is one task, sized to be picked up by a coding agent in a **fresh session with no memory of how it was written** (§14 of the spec: "backlog execution: agents"). Read the task file top to bottom before touching code — it is meant to be self-sufficient.

## File format

Every task file has these sections, in this order:

1. **Header** — phase, spec pointer(s), a "do not relitigate" line naming the settled decisions the task must not re-open.
2. **Context** — 2–4 sentences: what this fits into and why, enough for a reader with zero prior context on this project.
3. **Task** — concrete steps: files to create/edit, what they must contain or do.
4. **Done-check** — one or more exact commands, and what output means "done." Must be runnable in ≤15 minutes total (implementation + verification, per §14's task-size sanity check). If you can't verify it that fast, the task is too big — split it, don't skip verification.

## Ordering and dependencies

Files are numbered (`001`, `002`, …) in dependency order within a phase. A task may assume every lower-numbered task in its own phase is already merged. Phase 3 (walking skeleton) assumes Phases 0–2 are merged — it imports from `src/paths.ts` (009) and consumes the golden examples (004, 006) as fixture shape references.

Phases can't run out of order: Phase 1 (schemas) and Phase 2 (structural invariants) both need Phase 0's scaffold; Phase 3 needs both, since it implements the pipeline the schemas and invariants describe.

## Do not relitigate

The design spec (`docs/specs/librarian-design-consolidated.md`) is settled per its own §5 and §14. If a task file's "do not relitigate" line names a section, treat that section as a constraint, not a suggestion — if the implementation seems to want something the spec forbids (a generic abstraction, a new storage format, a config location other than `~/.librarian/config.json`, etc.), stop and flag it rather than quietly deviating. The spec's "Deleted / deferred" list (§5) and "Open items" (§15) both exist precisely so agents don't need to re-derive those calls.

## When a task is done

Mark it done by moving it or noting completion however this repo's workflow tracks that (this backlog doesn't mandate a specific mechanism — check for an issue tracker or project board before inventing one). The done-check in the file is the source of truth for "does this task actually work," independent of however completion gets recorded.
