# Documentation conventions

The procedures behind the invariants in [`AGENTS.md`](../AGENTS.md). Read this before
writing an issue body, editing `docs/specs/**`, or adding a view to
`docs/architecture/librarian.c4`.

The split is deliberate: AGENTS.md is loaded into *every* session, so it carries only the
rules an agent must not get wrong without reading anything. This file is the reference you
consult while performing one of those acts — you know when you need it, so it costs no
context until then.

A few rules therefore appear in both, as a one-liner there and a procedure here. That is
the cost of AGENTS.md standing alone, and it is the only duplication allowed. **If the two
ever disagree, AGENTS.md wins** — it is the copy every session actually loads — and the
fix belongs here. Don't add a third copy for a particular agent or host: this file is
vendor-neutral on purpose, and a host-specific restatement drifts the moment paths move.

## Three homes, no fourth

| Home | Holds | Never holds |
|---|---|---|
| **Specs** (`docs/specs/`) | Durable reasoning: vision, decisions, invariants, why-not, the amendment log, sequencing rationale | Status lines, `→ issue #NN` ledgers |
| **GitHub issues** | Every unit of work: status, dependencies, per-unit why/why-not, agent instructions | Reasoning that outlives the unit |
| **Project v2** | The view engine over the issues (roadmap = helicopter, board grouped by epic = mid, open issue = zoom). Auto-add workflow, so new issues appear with no bookkeeping | Anything hand-edited — it is a read-only lens |

The spec is what you read to understand the mind; the issue is what you read to act.

### The routing test

> **Does this fact outlive the unit it describes?**
> Outlives it (a decision, an invariant, why the ordering is what it is) → **spec**.
> Dies with it (status, deps, why *this* story exists, why *this* approach was
> rejected, agent instructions) → **issue**.

The question routes most cases on its own. The three that carry a mechanism it can't
tell you:

| When we decide… | Do this (not what the rule already implies) |
|---|---|
| A dependency emerges | Set the native GitHub **relationship** field (`blocked by`) on the issue; mirror with a `**Blocked by #N**` body line. Not prose-only. |
| A decision is revoked/superseded | Spec: mark superseded, keep old text + why. Then reconcile affected issues. |
| A decision is challenged, unresolved | Spec open-items as a live question. No issue until it becomes work. |

## Working in the spec

### Break the monolith up as you touch it

`librarian-design-consolidated.md` is being decomposed one section at a time. When a
session **substantively** edits a section:

1. Lift that section into its own file under `docs/specs/`.
2. Leave a stub in its place — a heading, a link, and one line saying what moved and when.
3. Change nothing else about the text. A move is a move; rewrite in a separate pass so
   the diff stays reviewable.
4. Keep the old section number working: references to "§5" elsewhere should still land,
   which is what the stub is for.

Already out: [`decisions.md`](specs/decisions.md) (was §5),
[`triggers.md`](specs/triggers.md) (was §15).

Optimise the result **for agents, not for reading start-to-finish**: one subject per
file, an index table at the top, stable ids, greppable. Nobody reads these front to back.

### Durable ids

| Kind | Register | Id |
|---|---|---|
| A settled ruling | [`specs/decisions.md`](specs/decisions.md) | `D-nn` |
| A named condition that gates deferred work | [`specs/triggers.md`](specs/triggers.md) | `T-nn` |

**Register first, then reference.** Add the entry, then point at it from a code comment,
the architecture model, or an issue — never the reverse. An id that exists only in a
diagram or an issue is not durable.

**Never renumber, never reuse.** A superseded ruling keeps its id *and* its text: see
`D-11`, kept so the reasoning stays auditable. Ids are permanent because other things
point at them.

A decision and a trigger are the same kind of thing in different tenses — one says why
the system is shaped this way, the other says what would reshape it. Neither is a task,
and neither records status.

## Writing an issue

Open the body with a **What / Why couplet** — one line for the observable change this
ships, one for the pain or value that justifies it. No user-story persona: the user never
varies. Use a job story (`When <situation>, <capability>, so <outcome>`) only when the
trigger is the point.

Every issue states its **success signal(s)** — one or more observable, checkable
conditions that tell an agent the work is done: a command that passes, a behavior you can
drive, an artifact that exists. No fuzzy "works well". **If you can't name what to check,
the issue isn't ready.**

Mechanics:

- **Type by label** — `epic` / `story` / `task`.
- **Nest via native sub-issues** — Epic → Story → Task.
- **Dependencies** — set the native **relationship** field (`blocked by`), and mirror it
  with a `**Blocked by #N**` line in the body as a human-readable cue.
- **Blocked on a trigger** rather than another issue? Say `Blocked by T-10` and link
  [`specs/triggers.md`](specs/triggers.md). The register entry is the durable half.

## The architecture model is a lens, not a home

[`architecture/librarian.c4`](architecture/README.md) draws the same structure,
decisions, and triggers the spec already holds. It carries **no status**.

### References run one way

```
issue  →  view  →  spec entry (D-nn / T-nn)  →  reasoning
```

An issue links a view to say where its work lands. A view links a register entry. **A
view never links an issue**, and neither does the spec: an issue is a unit of work that
closes, a view and a register entry outlive it, and a link from the durable thing to the
disposable one rots by construction.

### Linking a view

```
docs/architecture/librarian.html#/view/<view-id>/
```

Generated by `npm run arch:single`, gitignored — rebuild after pulling. The view
catalogue and the rest of the model's conventions live in
[`architecture/README.md`](architecture/README.md).

**View ids are an API.** Renaming one silently breaks every issue pointing at it. Add
freely; rename never.
