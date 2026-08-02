# Librarian — agent guide

Node per `.nvmrc` (the authoritative pin — run `nvm use`; `package.json` `engines` is only a floor). TypeScript, ESM.

## Commands

```bash
npm run build      # tsc → dist/ (strict; the typecheck gate)
npm test           # node --test over tests/**/*.test.ts
npm run lint       # eslint src — type-aware correctness only
npm run qualify    # provider qualification suite only
npm run arch       # validate docs/architecture/librarian.c4
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

Flow: `collector → distill (narrow waist) → note log → embedding/index → recall → render → export`.
`src/` mirrors those stage names, plus CLI entry `cli.ts` and `src/hook/` (the host
plugins' I/O shell behind `librarian hook <agent>`, with the per-host mappers).

`adapters/` is vendor-agnostic integration points — thin plugins routed through the one
bin, never a second copy of `dist/`. `schema/` and `fixtures/` are plain-file test inputs.

Before touching the pipeline, read `docs/specs/structural-invariants.md` — those
rules hold by construction; don't route around them.

## Project tracking — the invariants

**Three homes, no fourth: specs (`docs/specs/`) · GitHub issues · Project v2.
Never invent a tracking file.**

- **Routing test.** Does this fact outlive the unit it describes? Outlives it → spec.
  Dies with it (status, deps, agent instructions) → issue.
- **No status in specs.** No status lines, no `→ issue #NN` ledger.
- **Durable ids.** Rulings are `D-nn` ([`docs/specs/decisions.md`](docs/specs/decisions.md)),
  the named conditions gating deferred work are `T-nn`
  ([`docs/specs/triggers.md`](docs/specs/triggers.md)). Register first, then reference.
  Never renumber, never reuse.
- **Break the spec monolith up as you touch it.** Substantively edited a section? Lift it
  into its own file, leave a stub, change nothing else about the text.
- **The architecture model is a lens, not a home.**
  [`docs/architecture/librarian.c4`](docs/architecture/README.md) holds no status.
- **References run one way:** issue → view → spec entry (`D-nn` / `T-nn`) → reasoning.
  Nothing durable ever links forward to an issue — the issue closes and the link rots.
- **Ids are an API.** View ids, `D-nn`, `T-nn`: add freely, rename never.

**Before writing an issue body, editing `docs/specs/**`, or adding a view — read
[`docs/conventions.md`](docs/conventions.md).** It carries the templates and the
step-by-step. The rules above are the part you must not get wrong without reading
anything.

## Commits

Conventional commits (`feat|fix|refactor|docs|test|chore|perf|ci`). No AI attribution.

## Design tenets

Judge every proposal against the project's standing commitments — file-over-app,
vendor-agnostic, minimal abstraction, deliberate coupling (full reasoning in
[`docs/specs/decisions.md`](docs/specs/decisions.md)).
