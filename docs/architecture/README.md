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

Which links are legal, and in which direction, is in
[`../conventions.md`](../conventions.md) — the short version is that **view ids are an
API** (add freely, rename never) and a view never links back at an issue.

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

## The three annotation kinds, and how they're drawn

The model is a lens: it holds structure, and it holds no status. What each annotation
*means* — and the register-first rule — is in [`../conventions.md`](../conventions.md);
what differs here is how they are drawn, because the shapes carry the distinction.

| Kind | Drawn as | Means | Defined in |
|---|---|---|---|
| `event` | green queue | Part of a *flow*: something happens and the pipeline runs. Fires every session, so it lives in the value-path and flow views | this model |
| `decision` | grey document | Settled reasoning pinned to a place: *why it is shaped this way* | [`../specs/decisions.md`](../specs/decisions.md), `D-01` … `D-16` |
| `trigger` | amber document | The same annotation in the other tense: *what would enable, change, or block this*. Fires once in the project's life, if ever | [`../specs/triggers.md`](../specs/triggers.md), `T-01` … `T-19` |

Decisions and triggers share a shape deliberately — they differ in state, not category.
An event is neither, and giving it a queue rather than a document is the whole point:
an event is part of the machine, an annotation is a note about the machine.

Every decision and trigger element carries a `link` back to its register entry, clickable
in the generated site. So an issue can say *"blocked by T-10"* and the spec, the model,
and the issue all mean the same thing — and `triggersScale` shows exactly which
components T-10 touches.

## Keeping it honest

Every `technology` string names a real path under `src/`. If a path moves and the model
doesn't, the model is wrong — that's the intended failure mode, and it is cheaper to
check than prose. `npm run arch` catches syntax and reference drift, not semantic drift;
the model is reviewed like any other doc when a decision changes.
