# Architecture as code (LikeC4)

`librarian.c4` models the pipeline, the two value paths, the settled decisions that
constrain them, and the named triggers the design is waiting on.

```sh
npm run arch          # validate the model — the gate
npm run arch:dev      # interactive browser view (pan, zoom, click through)
npm run arch:single   # → docs/architecture/librarian.html (one self-contained file)
npm run arch:build    # multi-file static site → build/architecture/
```

PNG export additionally needs a Chromium (`npx playwright install chromium-headless-shell`);
nothing else here does — layout runs on graphviz-wasm.

## Linking a view from an issue

`npm run arch:single` writes **one self-contained HTML file** to
`docs/architecture/librarian.html`. Every view is addressable by id:

```
docs/architecture/librarian.html#/view/<view-id>/
```

The file is generated and **gitignored** — rebuild it after pulling. A link therefore
resolves on a machine that has run `arch:single`, which is the V1 trade: no 4.7 MB blob
committed on every diagram change. Publishing it (GitHub Pages) is the natural V2 and
turns the same fragment into a URL anyone can open.

**View ids are an API.** Renaming a view silently breaks every issue pointing at it.
Add freely; rename never.

| Level | View id | What it answers |
|---|---|---|
| helicopter | `index` | Who talks to librarian, and the one artifact shared with the human |
| helicopter | `map` | Every part of the system, one level deep — the navigation hub |
| mid | `writePath` | Capture → redact → distill → note log → index → export |
| mid | `readPath` | Both value paths side by side, one recall engine |
| mid | `valueStream` | The loop the product sells: explain once, never re-explain |
| mid | `hotPath` | What an injection is allowed to touch |
| mid | `storage` | Sacred / derived / deletable, and what is safe to delete |
| zoom | `zoomWiring` | Three host classes, three integration physics |
| zoom | `zoomCollector` | normalize → redact → validate → append |
| zoom | `admission` | The gate chain, and the red rejection edges that fail closed |
| zoom | `zoomRecall` | Two channels → RRF → scoring → two very different exits |
| decisions | `decisionsWrite` | What holds the ingestion path in place |
| decisions | `decisionsRead` | What holds recall and injection in place |
| decisions | `decisionsDelivery` | Why one bin, no npm package |
| triggers | `triggersMemory` | What would change memory quality (T-01, T-02, T-06 – T-09, T-16, T-17) |
| triggers | `triggersScale` | What would change with scale or distribution (T-03 – T-05, T-10 – T-15, T-18, T-19) |
| flow | `pushFlow` `pullFlow` `distillFlow` | Step-by-step, numbered |

## The scope rule

This model carries **only facts that outlive the unit they describe**: structure,
settled decisions, structural invariants, and the named triggers that gate deferred
work. It carries **no status** — no "in progress", no issue state, no roadmap
position. Status lives on GitHub issues and the Project board (AGENTS.md, "three
homes, no fourth"). This file is a lens on
[`../specs/librarian-design-consolidated.md`](../specs/librarian-design-consolidated.md),
not a fourth tracking home.

## Events, decisions, triggers

Three annotations that are easy to conflate and shouldn't be:

- **`event`** (green, queue) — part of a *flow*. Something happens and the pipeline
  runs: session start, user prompt, tool use, session end, a model deciding to search.
  Events fire every session; they live in the value-path and flow views.
- **`decision`** (grey, document) — settled reasoning pinned to a place in the
  architecture: *why it is shaped this way*. `D-01` … `D-16`.
- **`trigger`** (amber, document) — the same kind of annotation in the other tense:
  *what would enable, change, or block this*, if a named condition came true. `T-01` …
  `T-19`. A trigger fires once in the project's life, if ever.

Decisions and triggers share a shape deliberately — they differ in state, not category.
An event is neither.

Neither annotation is *defined* here. Each mirrors an entry in a spec register and links
back to it:

| Kind | Register | Ids |
|---|---|---|
| decision | [`../specs/decisions.md`](../specs/decisions.md) | D-01 … D-16 |
| trigger | [`../specs/triggers.md`](../specs/triggers.md) | T-01 … T-19 |

**Add the entry to the register first, then mirror it here.** So an issue can say
*"blocked by T-10"* and the spec, the model, and the issue all mean the same thing —
and `triggersScale` shows exactly which components T-10 touches.

## References run one way

```
issue  →  view  →  spec entry (D-nn / T-nn)  →  reasoning
```

An issue links a view to say where its work lands. A view links a register entry. **A
view never links an issue**, and neither does the spec: an issue is a unit of work that
closes, a view and a register entry outlive it, and a link from the durable thing to the
disposable one rots by construction.

## Keeping it honest

Every `technology` string names a real path under `src/`. If a path moves and the model
doesn't, the model is wrong — that's the intended failure mode, and it is cheaper to
check than prose. `npm run arch` catches syntax and reference drift, not semantic drift;
the model is reviewed like any other doc when a decision changes.
