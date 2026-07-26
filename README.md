# librarian

A personal context layer for AI coding agents. Design: `docs/specs/librarian-design-consolidated.md` — the spec is the source of truth; its §12 roadmap is the live plan.

## Install

Librarian ships as a single self-contained executable — no Node required on the
target machine (spec §14 amendment; npm is dev tooling only). The installer places
it at a **user-writable** `~/.librarian/bin/librarian` (no sudo) and puts that dir
on `PATH`. Re-running is safe: it upgrades the binary in place (atomic replace) and
never duplicates the `PATH` line. Single-platform for now (your OS/arch); Windows
`.ps1` and cross-platform builds are deferred (spec §15).

There is no public release feed yet, so install from a locally built binary (also
the CI/verify path):

```sh
npm run build:binary                                   # → build/sea/librarian
LIBRARIAN_BINARY=build/sea/librarian sh scripts/install.sh
```

Once releases are published, the installer will fetch the binary itself:

```sh
curl -fsSL <release-url>/install.sh | sh   # requires a published release feed
```

Open a new shell afterward, or run the `export PATH=…` line the installer prints.
`librarian --version` reports the installed binary's build.

## Build the binary

```sh
npm run build:binary   # bundle (esbuild ESM→CJS) → SEA blob → single executable
```

Output: `build/sea/librarian`. The version (`git describe`) is stamped in at build
time so `librarian --version` reports it. See
[`docs/research/sea-poc-findings.md`](docs/research/sea-poc-findings.md) for how the
native deps (`better-sqlite3`, `sqlite-vec`) are embedded and extracted.

## Run from source (dev mode)

You don't need the binary to develop against the pipeline — run the CLI straight
from the TypeScript build:

```sh
npm run build          # tsc → dist/cli.js
node dist/cli.js doctor
node dist/cli.js --version   # prints 0.0.0-dev (the binary stamps the real version)
```

This is the resolution path the plugins already use (`LIBRARIAN_BIN` → config
`bin` → `dist/cli.js`); it is **not** a user install path.

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
    "model": "qwen3-embedding:0.6b"
  }
}
```

Two optional timeouts tune the embedding budgets independently. `timeoutMs`
(default `10000`) bounds the background index/drain path, which must tolerate a
cold model load (~1.5s after Ollama's `keep_alive` expiry). `recallTimeoutMs`
(default `400`) bounds the latency-critical recall path, where a slow embed
degrades to BM25-only rather than hanging the query.

Any OpenAI-compatible endpoint can be used for `/v1/embeddings`. Ollama users
can omit `digest`, which Librarian resolves from Ollama's model list. Other
endpoints must set the immutable deployment digest explicitly:

```json
"digest": "your-immutable-model-revision"
```

`librarian doctor` reports endpoint reachability, the configured model digest
against the index stamp, embedding coverage, and index freshness. `unpinned`
means run `librarian drain` after configuring the endpoint. If it reports a
digest mismatch, delete the disposable `~/.librarian/index/` directory and run
`librarian drain` to rebuild it. A timeout or endpoint failure keeps recall
BM25-only and records that state in the injection trace.

## MCP Server

`librarian mcp` starts the local stdio MCP server with `search` and `get_note` tools. See [`docs/mcp.md`](docs/mcp.md) for Claude Code registration and tool behavior.

## OpenCode plugin

The OpenCode instrumentation adapter lives in [`adapters/opencode/`](adapters/opencode/).
The supported install is the setup wizard:

```sh
librarian init      # detects OpenCode → offers to install the plugin globally
```

It bundles the adapter into one self-contained file, writes it to the global plugin dir
`~/.config/opencode/plugins/librarian.ts`, and records the installed binary in
`~/.librarian/config.json` `bin` (so the plugin locates the CLI without `$PATH`). Fully
quit and relaunch OpenCode afterward — plugins load only at startup. Then run a tool in a
session and check the collected events:

```sh
ls ~/.librarian/data/events/
# per-session NDJSON: ~/.librarian/data/events/<session_id>.ndjson
```

See [`adapters/opencode/README.md`](adapters/opencode/README.md) for the mapping contract
and hooks.

### Repo-local dev smoke test (adapter-source iteration only)

When editing the adapter *sources* and you want OpenCode to load them live, two idempotent
repo scripts symlink `plugin.ts` into the repo-root `.opencode/plugins/` and point config
`bin` at the built `dist/cli.js`:

```sh
./scripts/opencode-setup.sh      # build, record the CLI path in config, symlink the plugin
./scripts/opencode-teardown.sh   # remove the plugin symlink, drop the config entry
```

These are dev-only (a repo symlink, not a real install); everyone else uses `librarian
init`. `.opencode/plugins/` is git-ignored, so the per-project dev install never shows up
as a repo change. Collected events under `~/.librarian` are left untouched.
