# librarian

A personal context layer for AI coding agents. Design: `docs/specs/librarian-design-consolidated.md` — the spec is the source of truth; its §12 roadmap is the live plan.

## MCP Server

`librarian mcp` starts the local stdio MCP server with `search` and `get_note` tools. See [`docs/mcp.md`](docs/mcp.md) for Claude Code registration and tool behavior.

## OpenCode plugin (local smoke test)

The OpenCode instrumentation adapter lives in [`adapters/opencode/`](adapters/opencode/).
Two scripts stand it up against a real OpenCode session in this repo and tear it back
down. Both are idempotent (safe to re-run) and resolve the repo root themselves, so they
work from any directory.

```sh
./scripts/opencode-setup.sh      # build, record the CLI path in config, install the plugin
./scripts/opencode-teardown.sh   # remove the plugin symlink, drop the config entry
```

**`opencode-setup.sh`** does four things:

1. `npm run build` — produces `dist/cli.js` (the `librarian` CLI).
2. Writes `~/.librarian/config.json` with an absolute `bin` pointing at `dist/cli.js`,
   then verifies it runs. The plugin reads this at runtime to locate the CLI, so it works
   no matter how OpenCode was launched — no `PATH` setup required. (Resolution order:
   `LIBRARIAN_BIN` → config `bin` → the built `dist/cli.js` next to the plugin → bare
   `librarian` on `PATH` as a last resort.)
3. Symlinks the adapter — `adapters/opencode/plugin.ts` — into the repo-root
   `.opencode/plugins/` as `librarian.ts`, which OpenCode auto-loads per-project. Using a
   symlink means edits to the adapter are picked up on the next session with no re-copy.
   (`map.ts` is not symlinked; the plugin imports it via the symlink's real location.)
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

**`opencode-teardown.sh`** removes the plugin symlink (and the now-empty
`.opencode/plugins/` dir) and drops the `bin` entry it wrote to `~/.librarian/config.json`.
Collected events under `~/.librarian` are left untouched.

`.opencode/plugins/` is git-ignored, so the per-project install never shows up as a repo
change. See [`adapters/opencode/README.md`](adapters/opencode/README.md) for a manual
install (including the global `~/.config/opencode/plugins/` layout) and the full mapping
contract.
