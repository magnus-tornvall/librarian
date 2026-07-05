# Backlog convention

Each file in this directory is one task, sized to be picked up by a coding agent in a **fresh session with no memory of how it was written** (§14 of the spec: "backlog execution: agents"). Read the task file top to bottom before touching code — it is meant to be self-sufficient.

## File format

Every task file has these sections, in this order:

1. **Header** — phase, a **Dependencies** line (see below), spec pointer(s), a "do not relitigate" line naming the settled decisions the task must not re-open.
2. **Context** — 2–4 sentences: what this fits into and why, enough for a reader with zero prior context on this project.
3. **Task** — concrete steps: files to create/edit, what they must contain or do.
4. **Done-check** — one or more exact commands, and what output means "done." Must be runnable in ≤15 minutes total (implementation + verification, per §14's task-size sanity check). If you can't verify it that fast, the task is too big — split it, don't skip verification.

## Ordering and dependencies

Every task file carries a `**Dependencies:**` line in its header. That line is the sole source of truth for whether a task can be started:

- **A task is workable when every task named on its Dependencies line is merged to main** (plus the Phase 0 scaffold, 001–002, which everything assumes). "none" means workable right now.
- **Hard vs. soft:** hard dependencies are imports or files the task's code/tests actually consume — do not start before they're merged. Soft dependencies (marked "Soft:") are references or idioms; the task is workable without them, using the spec section as the fallback source.
- File numbering is publication order, not a dependency chain. Do **not** assume every lower-numbered task is merged — several tasks are deliberately parallel-safe (e.g. 003 and 005; 011, 017, 021, 023), and the Dependencies line says so where it matters.
- Agents working tasks in parallel should each work in their own branch/worktree, run the done-check *after rebasing on latest main*, and merge one at a time — `npm test` runs the whole suite, so a green done-check is only meaningful against current main.

## Do not relitigate

The design spec (`docs/specs/librarian-design-consolidated.md`) is settled per its own §5 and §14. If a task file's "do not relitigate" line names a section, treat that section as a constraint, not a suggestion — if the implementation seems to want something the spec forbids (a generic abstraction, a new storage format, a config location other than `~/.librarian/config.json`, etc.), stop and flag it rather than quietly deviating. The spec's "Deleted / deferred" list (§5) and "Open items" (§15) both exist precisely so agents don't need to re-derive those calls.

## When a task is done

Mark it done by moving it or noting completion however this repo's workflow tracks that (this backlog doesn't mandate a specific mechanism — check for an issue tracker or project board before inventing one). The done-check in the file is the source of truth for "does this task actually work," independent of however completion gets recorded.
