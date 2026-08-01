# Architecture as code (LikeC4)

`librarian.c4` is a LikeC4 model of the pipeline, the two value paths, the settled
decisions that constrain them, and the named triggers the design is waiting on.

```sh
npm run arch          # validate the model — the gate
npm run arch:dev      # interactive browser view (pan, zoom, click through)
npm run arch:build    # static site → build/architecture/
```

PNG export additionally needs a Chromium (`npx playwright install chromium-headless-shell`);
`validate`, `dev`, and `build` don't — layout runs on graphviz-wasm.

## The scope rule

This model carries **only facts that outlive the unit they describe**: structure,
settled decisions, structural invariants, and the named triggers that gate deferred
work. It carries **no status** — no "in progress", no issue state, no roadmap
position. Status lives on GitHub issues and the Project board (AGENTS.md, "three
homes, no fourth"). This file is a lens on
[`../specs/librarian-design-consolidated.md`](../specs/librarian-design-consolidated.md),
not a fourth tracking home.

Concretely: `gSecondMachine` ("waiting: second machine") belongs here, because the
trigger is a durable design fact. "Issue #128 is closed" does not.

## Two kinds of trigger

The word points in opposite directions, so the model uses two element kinds:

- **`runtimeEvent`** (green) — an event that *starts* a flow: session start, user
  prompt, tool use, session end, a model deciding to search.
- **`gate`** (amber) — a named condition the design *waits for* before building
  something (spec §15). Each one is a deliberate stopping point, not a gap.

## Views

| View | What it answers |
|---|---|
| `index` | Who talks to librarian, and the one artifact shared with the human |
| `components` | Every component, named after the code that implements it |
| `writePath` | Capture → redact → distill → note log → index → export |
| `readPath` | Both value paths side by side, one recall engine |
| `admission` | The gate chain, and the red rejection edges that fail closed |
| `hotPath` | What an injection is allowed to touch |
| `storageClasses` | Sacred / derived / deletable, and why each is safe to delete or not |
| `decisionsWrite` `decisionsRead` `decisionsDelivery` | Which ruling holds which code in place |
| `frontier` | Where we are waiting for a trigger |
| `pushFlow` `pullFlow` `distillFlow` | Step-by-step flows |
| `valueStream` | The loop the product actually sells: explain once, never re-explain |

## Keeping it honest

Every `technology` string names a real path under `src/`. If a path moves and the
model doesn't, the model is wrong — that's the intended failure mode, and it is
cheaper to check than prose. `npm run arch` catches syntax and reference drift, not
semantic drift; the model is reviewed like any other doc when a decision changes.
