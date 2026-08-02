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
| frontier | `frontierMemory` | Triggers on memory quality (T-01, T-02, T-06 – T-09, T-16, T-17) |
| frontier | `frontierScale` | Triggers on scale and distribution (T-03 – T-05, T-10 – T-15, T-18, T-19) |
| flow | `pushFlow` `pullFlow` `distillFlow` | Step-by-step, numbered |

## The scope rule

This model carries **only facts that outlive the unit they describe**: structure,
settled decisions, structural invariants, and the named triggers that gate deferred
work. It carries **no status** — no "in progress", no issue state, no roadmap
position. Status lives on GitHub issues and the Project board (AGENTS.md, "three
homes, no fourth"). This file is a lens on
[`../specs/librarian-design-consolidated.md`](../specs/librarian-design-consolidated.md),
not a fourth tracking home.

## Two kinds of trigger

The word points in opposite directions, so the model uses two element kinds:

- **`runtimeEvent`** (green) — an event that *starts* a flow: session start, user
  prompt, tool use, session end, a model deciding to search.
- **`gate`** (amber) — a named condition the design *waits for*. Each gate mirrors one
  row of the spec's [trigger register](../specs/librarian-design-consolidated.md)
  (§15.1) and carries that row's id (T-01 … T-19) in its title. The register is the
  durable home: **add a trigger there first, then mirror it here.**

So an issue can say *"blocked by T-10"* and the spec, the model, and the issue all mean
the same thing — and `frontierScale` shows exactly which components T-10 touches.

## Keeping it honest

Every `technology` string names a real path under `src/`. If a path moves and the model
doesn't, the model is wrong — that's the intended failure mode, and it is cheaper to
check than prose. `npm run arch` catches syntax and reference drift, not semantic drift;
the model is reviewed like any other doc when a decision changes.
