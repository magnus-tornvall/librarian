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

## Uninstall

```sh
librarian uninstall             # removes the wiring and the bin; your notes stay
librarian uninstall --dry-run   # print what it would remove, change nothing
librarian uninstall --purge     # also delete ~/.librarian (asks first; --yes skips)
```

Removing the tool never removes the memory (spec §14 amendment): `uninstall` takes
out the binary, the installer's `PATH` line, the OpenCode plugin file, the extracted
native/update caches, and the config keys that point at the bin — and leaves your
notes and index alone unless you pass `--purge`.
It prints the two teardowns it cannot do for you, because they live in the host's
own config: `/plugin uninstall librarian` in Claude Code, and `claude mcp remove
librarian` if you registered MCP by hand.

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

## Distill eligibility (settle window)

`librarian distill` / `librarian drain` process *every* pending session, not just the one
you were last in — so a session is only eligible once it has gone quiet. A delta whose
newest event is younger than `distill.settleMs` (default `86400000`, 24 h) is **deferred**:
its cursor is untouched, a `deferred` diagnostic records why, and the next run reconsiders
it. That is what makes a drain safe to fire at any time — it can never distill a session
you are still working in.

```json
{
  "distill": {
    "settleMs": 1800000
  }
}
```

Lower it if you want notes from today's work sooner; `"settleMs": 0` turns the gate off
entirely, which is the escape hatch for a manual drain you know is safe. The exact value is
not load-bearing:
no threshold can stop a long real pause from splitting an arc, so over-waiting is cheap and
under-waiting distills live work.

## Automatic notes (no daemon)

You never have to type `librarian drain`. Two triggers cover it, and neither is a resident
process:

1. **A boundary in the session.** When an adapter records a completion — the session ending, a
   successful commit, a todo list going all-green — the hook spawns a **detached**
   `librarian drain` and returns immediately. It never blocks your agent, never writes to its
   stdout, and a drain that cannot even be spawned is dropped silently rather than breaking the
   session — the timer below is what makes that recoverable. Bursts are
   debounced to one drain a minute (a session end always fires, since it is the one that owes
   you the note), and overlapping drains are safe by construction — the second one finds the
   distiller lock held, skips the distill, renders whatever notes already exist, and exits 0.
2. **An OS timer**, for everything a hook cannot see: a hard-killed terminal, a machine that
   slept mid-run, a provider that was offline when the session ended.

```bash
librarian install-schedule                  # launchd / systemd-user / cron entry, drains hourly
librarian install-schedule --interval 15    # every 15 minutes instead
librarian install-schedule --uninstall      # remove it
```

It prints the unit it wrote, where, and the activation command it ran — nothing is installed
silently — and `librarian uninstall` removes it again.

## Diagnosing a failed run (`debug`)

A failure prints one line: what went wrong, and — for a distill failure — which session,
which attempt, and an excerpt of the offending provider response, which is also recorded in
that session's cursor (`data/cursors/distiller/<session>.json` → `failed_attempts.last_error`)
and in the distill verdicts under `diagnostics/distill/`. That is normally enough.

When it is not, `debug` adds the stack of the failure to stderr:

```json
{
  "debug": true
}
```

It is the *only* debug switch, and it adds only the stack — the one thing an error message
cannot carry. There are no log levels and no log file: the pipeline's diagnosis lives in the
verdict and cursor files it already writes, and those are readable without turning anything on.

## MCP Server

`librarian mcp` starts the local stdio MCP server with `search` and `get_note` tools. See [`docs/mcp.md`](docs/mcp.md) for Claude Code registration and tool behavior.

## OpenCode plugin

The supported install is the wizard:

```sh
librarian init      # answer the "Install the OpenCode plugin?" prompt
```

It writes one dependency-free file to `~/.config/opencode/plugins/librarian.ts` and records
`bin` in `~/.librarian/config.json` pointing at the installed binary
(`~/.librarian/bin/librarian`), which is how the plugin reaches `librarian hook opencode` no
matter how OpenCode was launched. Restart OpenCode — plugins load only at startup. There is
no npm package, no release ref, and no second repo: the plugin is one file, and the binary
carries it as an embedded build asset, so this works with no checkout on the machine.
Re-running `librarian init` overwrites the file, which is how an update lands.

Then send a prompt, run a tool, and check the collected events:

```sh
ls ~/.librarian/data/events/
# per-session NDJSON: ~/.librarian/data/events/<session_id>.ndjson
```

### Dev inner loop (local smoke test)

For iterating on the adapter inside this repo, two scripts stand it up against a real
OpenCode session per-project instead. Both are idempotent and resolve the repo root
themselves, so they work from any directory.

```sh
./scripts/opencode-setup.sh      # build, record the CLI path in config, symlink the plugin
./scripts/opencode-teardown.sh   # remove the plugin symlink, drop the config entry
```

**`opencode-setup.sh`** does four things:

1. `npm run build` — produces `dist/cli.js` (the `librarian` CLI).
2. Writes `~/.librarian/config.json` with an absolute `bin` pointing at `dist/cli.js`,
   then verifies it runs. (Resolution order: `LIBRARIAN_BIN` → config `bin` → the built
   `dist/cli.js` two dirs above the plugin → bare `librarian` on `PATH` as a last resort.)
3. Symlinks the adapter — `adapters/opencode/plugin.ts` — into the repo-root
   `.opencode/plugins/` as `librarian.ts`, which OpenCode auto-loads per-project. Using a
   symlink means edits to the adapter are picked up on the next session with no re-copy.
4. Prints the next steps.

**`opencode-teardown.sh`** removes the plugin symlink (and the now-empty
`.opencode/plugins/` dir) and drops the `bin` entry it wrote to `~/.librarian/config.json`.
Collected events under `~/.librarian` are left untouched.

`.opencode/plugins/` is git-ignored, so the per-project install never shows up as a repo
change. See [`adapters/opencode/README.md`](adapters/opencode/README.md) for the full mapping
contract, the `librarian hook opencode` protocol, and the CLI-resolution rationale.
