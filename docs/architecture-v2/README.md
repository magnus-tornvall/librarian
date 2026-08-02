# Architecture as code — v2 (draft)

A navigation model, not a reference model. `librarian.c4` next door tried to be both and
became a wall; this one answers one question per view and reaches detail by zooming.

```sh
npm run arch:v2          # validate — the gate
npm run arch:dev:v2      # interactive: pan, zoom, click through
npm run arch:single:v2   # → docs/architecture-v2/librarian_v2.html (one self-contained file)
```

| Level | View id | What it answers |
|---|---|---|
| helicopter | `index` | Who is involved, and what librarian sits between |
| inside | `librarianInside` | What librarian can do: capture, distill, recall, export |
| detail | `distillInside` | The two ways a note gets written, and what a drafted one has to pass |

Clicking an element navigates into its view — automatic for any element a view is declared
`of`. Capture, Recall, and Export have no view yet, so zoom stops on them; each is one
`view of <element>` away, added when a question needs it rather than for symmetry.

Externals appear, vanish, and come back as you descend: `index` shows everyone,
`librarianInside` hides all of them because "which capability" is the only question there,
and `distillInside` shows the models and the vault again because at that depth what a step
calls out to *is* the answer.

Deep links work the same as v1: `docs/architecture-v2/librarian_v2.html#/view/<view-id>/`.
The HTML is generated and gitignored. **View ids are an API** — add freely, rename never.
