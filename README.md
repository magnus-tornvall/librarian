# librarian

A personal context layer for AI coding agents. Design: `docs/specs/librarian-design-consolidated.md`. Implementation plan and backlog: `docs/plans/implementation-plan.md`, `backlog/`.

## OpenCode plugin (local smoke test)

The OpenCode instrumentation adapter lives in [`adapters/opencode/`](adapters/opencode/).
Two scripts stand it up against a real OpenCode session in this repo and tear it back
down. Both are idempotent (safe to re-run) and resolve the repo root themselves, so they
work from any directory.

```sh
./scripts/opencode-setup.sh      # build, npm link, install the plugin for this project
./scripts/opencode-teardown.sh   # remove the plugin symlinks, npm unlink
```

**`opencode-setup.sh`** does four things:

1. `npm run build` — produces `dist/cli.js`. It carries a `#!/usr/bin/env node` shebang
   so the bare `librarian` command execs under node.
2. `npm link` — puts `librarian` on `PATH` (the plugin shells out to `librarian collect`
   and `librarian machine-id` by bare name), then verifies it runs.
3. Symlinks the adapter — `adapters/opencode/plugin.ts` and its `map.ts` — into the
   repo-root `.opencode/plugins/librarian/`, which OpenCode auto-loads per-project. Using
   symlinks means edits to the adapter are picked up on the next session with no re-copy.
4. Prints the next steps.

Then, to smoke-test:

1. Run `opencode` from this repo.
2. Send a prompt and run a tool (e.g. a bash `git status`).
3. End/delete the session.
4. Check the collected events:

   ```sh
   ls ~/.librarian/data/events/
   # per-session NDJSON: ~/.librarian/data/events/<session_id>.ndjson
   ```

**`opencode-teardown.sh`** removes the plugin symlinks (and the now-empty
`.opencode/plugins/librarian/` dir) and unlinks the global `librarian`. Collected events
under `~/.librarian` are left untouched.

`.opencode/plugins/` is git-ignored, so the per-project install never shows up as a repo
change. See [`adapters/opencode/README.md`](adapters/opencode/README.md) for a manual
install (including the global `~/.config/opencode/plugins/` layout) and the full mapping
contract.
