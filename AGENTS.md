# Librarian — agent guide

Node per `.nvmrc` (the authoritative pin — run `nvm use`; `package.json` `engines` is only a floor). TypeScript, ESM.

## Commands

```bash
npm run build      # tsc → dist/ (strict; the typecheck gate)
npm test           # node --test over tests/**/*.test.ts
npm run lint       # eslint src — type-aware correctness only
npm run qualify    # provider qualification suite only
```

Run one file: `node --import ./tests/setup-home.ts --test tests/<path>.test.ts`.
The `--import` points HOME at a throwaway dir so the spawned CLI resolves into
isolated storage instead of the developer's real `~/.librarian` — drop it and the
run reads (and wipes) the real index. `npm test`/`npm run qualify` include it.

`better-sqlite3` is a native module compiled for the `.nvmrc` node. `ERR_DLOPEN_FAILED` /
`NODE_MODULE_VERSION` from `npm test` means you're on the wrong node — run `nvm use`.

The bar is green **build + test + lint**. No formatter — don't add Prettier. The
linter (`eslint.config.js`) carries only type-aware rules tsc can't see —
`no-floating-promises` chief among them (a dropped `await` in the pipeline
silently loses a note). Widen it deliberately, not by reaching for the
`recommended` set.

## Testing

**Iron law: write integration tests.**
Black-box/integration only, through each pipeline stage's input/output contract
(§14 of the spec). `node --test`, TypeScript, plain-file fixtures, no mocking
framework. If there is no test setup, stop and ask before proceeding.

## Layout

- `src/` — pipeline stages (`collector`, `distill`, `embedding`, `recall`, `render`, `export`, `index`, `mcp`) + CLI entry `cli.ts`. `src/hook/` is the Claude Code plugin's I/O shell (behind `librarian hook claude-code`) + its pure mapper.
- `adapters/` — vendor-agnostic integration points. Claude Code ships as a thin plugin (`.claude-plugin/`) routed through the bin; its `adapters/claude-code/` is docs + fixtures only.
- `schema/`, `fixtures/` — plain-file test inputs
- `docs/specs/librarian-design-consolidated.md` — the spec (see below)

Flow: `collector → distill (narrow waist) → note log → embedding/index → recall → render → export`.

Before touching the pipeline, read `docs/specs/structural-invariants.md` — those
rules hold by construction; don't route around them.

## Project tracking — where things live

Three homes, no fourth. Never invent a tracking file.

- **Specs** (`docs/specs/`) — durable reasoning only: vision, decisions register,
  invariants, why-not, the amendment log (why reasoning *changed*), and
  cross-cutting sequencing rationale. **No status lines. No `→ issue #NN` mapping
  ledger.** Those are friction and they move out.
- **GitHub issues** — every unit of work. Holds status, dependencies, per-unit
  why/why-not, and the agent instructions. This is what agents read to act; the
  spec is what you read to understand the mind. Shape and bindings below.
- **GitHub Project v2** — the view engine over the issues (roadmap = helicopter,
  board/table grouped by epic = mid, open issue = zoom). Auto-add workflow, so new
  issues appear with no bookkeeping. Read-only lens — never hand-edited.

### Issue shape

Tracker-independent — nothing here depends on GitHub. The mechanisms that do are in
"Tracker bindings" below.

Field order: **Outcome** — the observable change this ships, declarative, no implementation
steps · **Why** — the pain/value in one line (no user-story persona; the user never varies) ·
**Touchpoints** — expected files, `path:line` where known · **Constraints** ≤5 — invariants
and settled decisions *by pointer*, plus the non-goals · **Success signals** ≤5 — runnable,
checkable with no human judgment, ≥1 failing on `main` first (no fuzzy "works well"; if you
can't name what to check, the issue isn't ready) · **Context** — links only.

Body budget **≤400 tokens** for a task, **≤700** for a story: the body is the execution
contract, not the reasoning. Evidence, design forks and superseded approaches go to
`docs/specs/` or `docs/research/` and are linked; issue history goes in a comment (the body
is what an agent reads by default); code becomes a `path:line` pointer, which fetches the
same bytes on demand and doesn't go stale.

Split when touchpoints span more than ~3 files or cross a pipeline-stage seam, when there are
more than 5 success signals, or when a schema change and its consumers both move (schema
first, consumers blocked by it). Sibling touchpoint sets must be **disjoint** — overlap is a
blocking dependency, and that disjointness is what lets siblings run in parallel. A parent may
carry framing, but **a child must be executable without reading its parent** — anything
load-bearing is repeated in the child or linked from it. Full reasoning:
`docs/research/agentic-issue-template.md`.

### Tracker bindings (GitHub)

The shape above is the contract; this is only how it gets expressed here. Rewrite these five
lines to move the procedure to another tracker.

- **Type** → label: `epic` / `story` / `task`.
- **Hierarchy** (Epic → Story → Task) → native **sub-issues**.
- **Blocking dependency** → the native issue **relationship** field (`blocked by`), mirrored
  with a `**Blocked by #N**` body line as a human-readable cue. The relationship field is the
  source of truth.
- **View** → GitHub Project v2 (above). Read-only lens, never hand-edited.
- **Authoring aid** → `.github/ISSUE_TEMPLATE/{task,story}.yml`. **Prefill only** — the forms
  state no rules, and they constrain nothing created through the API, which is the dominant
  authoring path. If a form and this section disagree, this section wins and the form is the bug.

## The routing test (what to touch when we discuss things)

> **Does this fact outlive the unit it describes?**
> Outlives it (a decision, an invariant, why the ordering is what it is) → **spec**.
> Dies with it (status, deps, why *this* story exists, why *this* approach was
> rejected, agent instructions) → **issue**.

The question routes most cases on its own. The three that carry a mechanism it
can't tell you:

| When we decide…                      | Do this (not what the rule already implies)                            |
|--------------------------------------|------------------------------------------------------------------------|
| A dependency emerges                 | Record it as a blocking dependency per "Tracker bindings", not as prose. Then check the sibling touchpoint sets. |
| A decision is revoked/superseded     | Spec: mark superseded, keep old text + why. Then reconcile affected issues. |
| A decision is challenged, unresolved | Spec open-items as a live question. No issue until it becomes work.    |

## Commits

Conventional commits (`feat|fix|refactor|docs|test|chore|perf|ci`). No AI attribution.

## Design tenets

Judge every proposal against the project's standing commitments — file-over-app,
vendor-agnostic, minimal abstraction, deliberate coupling (full reasoning in the
spec's decisions register).
