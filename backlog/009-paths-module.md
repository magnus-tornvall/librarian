# 009 — src/paths.ts (directory constants)

**Phase:** 2 — Structural invariants
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §11 (Housekeeping), §14 ("Config file location")
**Do not relitigate:** `~/.librarian/` is the one root — data, diagnostics, machine-id, and config all live under it (§14 explicitly rejected splitting config out to XDG `~/.config/librarian/`). Don't make the root configurable via an env var or a second lookup path — that's exactly the complexity §14 declined to add ("No XDG override; add one later only if a real user asks").

## Context

First code (not doc) task in Phase 2, and the first code anywhere that touches the filesystem layout. Depends on 002 (scaffold). Every later Phase 3 module that reads/writes `~/.librarian/...` should import from here rather than hardcoding paths — this is where the diagnostics-isolation structural invariant (§8, documented in task 008) starts being enforced by code instead of just prose.

## Task

Create `src/paths.ts` exporting:
```ts
export const HOME = os.homedir();
export const LIBRARIAN_ROOT = path.join(HOME, '.librarian');
export const DATA_DIR = path.join(LIBRARIAN_ROOT, 'data');
export const DIAGNOSTICS_DIR = path.join(LIBRARIAN_ROOT, 'diagnostics');
export const MACHINE_ID_PATH = path.join(LIBRARIAN_ROOT, 'machine-id');
export const CONFIG_PATH = path.join(LIBRARIAN_ROOT, 'config.json');
```
(Use `node:os` and `node:path`, exact shape above — types/consts, not a class, not a factory function; §5's "concrete functions over generic abstraction" applies here too even though this is barely more than a constants file.)

Create `tests/paths.test.ts` asserting:
- `DATA_DIR` and `DIAGNOSTICS_DIR` are both under `LIBRARIAN_ROOT` but are not equal to each other and neither is a substring-prefix of a path that would make one nest inside the other's sibling (i.e. literally `DATA_DIR !== DIAGNOSTICS_DIR`, both starting with `LIBRARIAN_ROOT + path.sep`).
- `CONFIG_PATH` ends in `config.json` and lives directly under `LIBRARIAN_ROOT` (not under `DATA_DIR` or `DIAGNOSTICS_DIR`).

## Done-check

```
npm test
```
Expect: `tests/paths.test.ts` passes alongside everything else. This test is the first place "diagnostics isolation" (§8) becomes a machine-checked fact rather than a documentation claim.
