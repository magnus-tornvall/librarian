# Librarian

## Testing

**Iron law: write integration tests. No unit tests for backend code.**
Black-box/integration only, through each pipeline stage's input/output contract
(§14 of the spec). `node --test`, TypeScript, plain-file fixtures, no mocking
framework. If there is no test setup, stop and ask before proceeding.

## Project tracking — where things live

Three homes, no fourth. Never invent a tracking file.

- **Spec** (`docs/specs/librarian-design-consolidated.md`) — durable reasoning
  only: vision, decisions register (§5), invariants, why-not, the amendment log
  (why reasoning *changed*), and cross-cutting sequencing rationale. **No status
  lines. No `→ issue #NN` mapping ledger.** Those are friction and they move out.
- **GitHub issues** — every unit of work. Typed by label (`saga` / `story` /
  `task`), nested via native **sub-issues** (Saga → Story → Task), linked via
  **blocked-by**. Holds status, dependencies, per-unit why/why-not, and the agent
  instructions. This is what agents read to act; the spec is what you read to
  understand the mind.
- **GitHub Project v2** — the view engine over the issues (roadmap = helicopter,
  board/table grouped by saga = mid, open issue = zoom). Auto-add workflow, so new
  issues appear with no bookkeeping. Read-only lens — never hand-edited.

## The routing test (what to touch when we discuss things)

> **Does this fact outlive the unit it describes?**
> Outlives it (a decision, an invariant, why the ordering is what it is) → **spec**.
> Dies with it (status, deps, why *this* story exists, why *this* approach was
> rejected, agent instructions) → **issue**.

| When we discuss / decide…            | Touch…                                                                 |
|--------------------------------------|------------------------------------------------------------------------|
| New task/story/saga surfaces         | Create issue, label type, nest under parent, set blocked-by. Spec untouched. |
| Work status changes                  | Issue state only. Never the spec.                                      |
| A dependency emerges                 | blocked-by on the issue. Not prose.                                    |
| Per-unit why / why-not               | Issue body.                                                            |
| A new decision is made               | Spec decisions register (§5). No issue.                                |
| A decision is revoked/superseded     | Spec: mark superseded, keep old text + why. Then reconcile affected issues. |
| A decision is challenged, unresolved | Spec open-items (§15) as a live question. No issue until it becomes work. |

Author values (from the spec): experienced .NET/PHP dev, strong KISS —
file-over-app, vendor-agnostic, minimal abstraction, deliberate coupling.
Judge proposals against these.
