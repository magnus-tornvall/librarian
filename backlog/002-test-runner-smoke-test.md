# 002 — Bootstrap: node --test smoke test

**Phase:** 0 — Scaffold
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §14 ("Test convention")
**Do not relitigate:** §14 has decided `node --test`, TypeScript, black-box/integration only — no unit-test framework (no Jest/Vitest/Mocha), no ts-node/tsx. This task exists only to prove that pipeline works before any real module depends on it.

## Context

Depends on 001 (needs `package.json`/`tsconfig.json` to exist). Node's native TypeScript support (type-stripping) is what lets `node --test` run `.ts` files directly per §14 — this task is the one place that assumption gets verified before every subsequent task's done-check relies on it silently.

## Task

1. Create `tests/smoke.test.ts`:
   ```ts
   import { test } from 'node:test';
   import assert from 'node:assert/strict';

   test('node --test runs a .ts file directly', () => {
     assert.equal(1 + 1, 2);
   });
   ```
2. Confirm the `test` script in `package.json` (from 001) actually invokes it — glob expansion in `package.json` scripts isn't shell-expanded on every platform, so if `node --test tests/**/*.test.ts` doesn't pick the file up, change the script to `node --test tests/` (directory form, which `node --test` walks recursively) instead.

## Done-check

```
npm test
```
Expect: test runner output showing 1 pass, 0 fail, exit code 0. If it fails with a syntax/type error rather than a normal test failure, native TS stripping isn't working on this Node version — stop and report it (this is a Phase 0 blocker, not something to work around locally).
