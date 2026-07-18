# librarian

A personal context layer for AI coding agents. Design: `docs/specs/librarian-design-consolidated.md` — the spec is the source of truth; its §12 roadmap is the live plan.

## Qualifying a provider

`npm run qualify` runs the provider-qualification fixtures offline with canned
responses. Set `QUALIFY_PROVIDER` to exercise the same fixtures against a live
provider; OpenCode also requires its exact model selector in `QUALIFY_MODEL`:

```sh
QUALIFY_PROVIDER=claude npm run qualify
QUALIFY_PROVIDER=opencode QUALIFY_MODEL=anthropic/claude-sonnet-4 npm run qualify
QUALIFY_PROVIDER=opencode QUALIFY_MODEL=ollama/qwen3:8b npm run qualify
```

Each fixture prints its own pass/fail result. Failures name the structural assertion
that degraded, rather than comparing model-generated wording.

## Embeddings (optional)

Librarian works BM25-only with no embedding configuration. To enable the
multilingual embedding seam with Ollama:

```sh
ollama pull qwen3-embedding:0.6b
```

Add this to `~/.librarian/config.json` (alongside any existing settings):

```json
{
  "embedding": {
    "endpoint": "http://127.0.0.1:11434",
    "model": "qwen3-embedding:0.6b",
    "timeoutMs": 400
  }
}
```

`librarian doctor` reports endpoint reachability, the configured model digest
against the index stamp, embedding coverage, and index freshness. If it reports
a digest mismatch, delete the disposable `~/.librarian/index/` directory and
run `librarian drain` to rebuild it. A timeout or endpoint failure keeps recall
BM25-only and records that state in the injection trace.

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
