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

- `src/` — pipeline stages (`collector`, `distill`, `embedding`, `recall`, `render`, `export`, `index`, `mcp`) + CLI entry `cli.ts`
- `adapters/` — vendor-agnostic integration points
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
- **GitHub issues** — every unit of work. Typed by label (`epic` / `story` /
  `task`), nested via native **sub-issues** (Epic → Story → Task), linked via
  **blocked-by** — set the native GitHub issue **relationship** field (`blocked by`),
  and mirror it with a `**Blocked by #N**` line in the body as a human-readable
  cue. Holds status, dependencies, per-unit why/why-not, and the agent
  instructions. This is what agents read to act; the spec is what you read to
  understand the mind. Open the body with a **What / Why couplet** — one line for
  the observable change this ships, one for the pain/value that justifies it (no
  user-story persona; the user never varies). Use a job story
  (`When <situation>, <capability>, so <outcome>`) only when the trigger is the
  point. Every issue states its **success signal(s)** — one or more observable,
  checkable conditions that tell an agent the work is done (a command that
  passes, a behavior you can drive, an artifact that exists). No fuzzy "works
  well"; if you can't name what to check, the issue isn't ready.
- **GitHub Project v2** — the view engine over the issues (roadmap = helicopter,
  board/table grouped by epic = mid, open issue = zoom). Auto-add workflow, so new
  issues appear with no bookkeeping. Read-only lens — never hand-edited.

## The routing test (what to touch when we discuss things)

> **Does this fact outlive the unit it describes?**
> Outlives it (a decision, an invariant, why the ordering is what it is) → **spec**.
> Dies with it (status, deps, why *this* story exists, why *this* approach was
> rejected, agent instructions) → **issue**.

The question routes most cases on its own. The three that carry a mechanism it
can't tell you:

| When we decide…                      | Do this (not what the rule already implies)                            |
|--------------------------------------|------------------------------------------------------------------------|
| A dependency emerges                 | Set the native GitHub **relationship** field (`blocked by`) on the issue; mirror with a `**Blocked by #N**` body line. Not prose-only. |
| A decision is revoked/superseded     | Spec: mark superseded, keep old text + why. Then reconcile affected issues. |
| A decision is challenged, unresolved | Spec open-items as a live question. No issue until it becomes work.    |

## Commits

Conventional commits (`feat|fix|refactor|docs|test|chore|perf|ci`). No AI attribution.

## Design tenets

Judge every proposal against the project's standing commitments — file-over-app,
vendor-agnostic, minimal abstraction, deliberate coupling (full reasoning in the
spec's decisions register).
