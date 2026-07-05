# 001 — Bootstrap: package.json + tsconfig.json

**Phase:** 0 — Scaffold
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §14 ("Language & runtime")
**Do not relitigate:** §14 has already decided TypeScript, Node.js LTS (not Bun), npm (not pnpm), `engines.node >= 22`, native `node --test` for TS (no ts-node/tsx). §14 "Repo bootstrap" has already decided license and broader package metadata are **deferred** — do not add a LICENSE file or flesh out `author`/`repository`/etc. beyond the minimum npm requires. Do not introduce any other runtime dependency (no `better-sqlite3`, no `@modelcontextprotocol/sdk` yet — those land in later tasks that actually use them).

## Context

This repo currently has no `package.json` — nothing has been built yet, this is the first code-adjacent task. Every later backlog task assumes `npm install` / `npm test` work from repo root.

## Task

1. Create `package.json` at repo root with:
   - `"name": "librarian"`, `"private": true` (no license field — deferred, see above)
   - `"type": "module"`
   - `"engines": { "node": ">=22" }`
   - `"scripts": { "build": "tsc", "test": "node --test tests/**/*.test.ts" }`
   - `"devDependencies": { "typescript": "^5" }` (install it: `npm install`)
2. Create `tsconfig.json` at repo root:
   - `"target": "ES2022"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`
   - `"outDir": "dist"`, `"rootDir": "src"`
   - `"strict": true`
   - `"include": ["src/**/*.ts"]`
3. Create empty `src/`, `tests/`, `schema/`, `fixtures/` directories (a `.gitkeep` each, or leave them to be created by the first file a later task adds — whichever `git` will actually track; empty dirs aren't tracked, so either add a placeholder file or skip creating dirs with nothing in them yet).

## Done-check

```
npm install && npx tsc --version && node --version
```
Expect: `npm install` succeeds with no errors, `tsc --version` prints a 5.x version, `node --version` prints >=22. `git status` shows `package.json`, `package-lock.json`, and `tsconfig.json` as new files.
