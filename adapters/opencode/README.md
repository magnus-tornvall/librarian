# OpenCode instrumentation adapter (`origin: opencode`)

The first real instrumentation for librarian (roadmap item 6, spec §4). It maps native
OpenCode events onto the canonical event schema ([`schema/event.md`](../../schema/event.md))
and pipes them into `librarian collect`. It is **dumb by design**: map native → canonical,
stamp Resource facts, emit cheap non-authoritative salience hints, hand off. No domain
logic — redaction, validation, and salience authority all live in the collector and
distiller (§4, §5).

## Layout

- **`map.ts`** — a *pure* mapping module: native OpenCode payload → canonical event(s).
  No I/O, no process spawning, no clock, no crypto. Everything machine-specific (the
  `resource` facts, the `event_id` ULID, the `ts`) is **injected** by the caller. This is
  what the origin-qualification fixtures test, and it is what makes the mapping testable
  without an OpenCode runtime.
- **`plugin.ts`** — the thin OpenCode plugin shell (the only part that does I/O): it
  subscribes to OpenCode hooks, lowers each native payload onto the mapper's shape,
  resolves the `resource` facts, stamps `event_id`/`ts`, calls `map()`, and pipes the
  resulting NDJSON to `librarian collect` (one spawn per event for v1 — see the ceiling
  note below).

## Install

The fastest path for a per-project smoke test is the repo scripts (they build the CLI,
record its absolute path in `~/.librarian/config.json`, and symlink this plugin into the
repo-root `.opencode/plugins/`):

```sh
./scripts/opencode-setup.sh      # build + write config bin/runtime + symlink plugin into .opencode/plugins/
./scripts/opencode-teardown.sh   # remove the symlink + drop the config bin/runtime
```

See the top-level [`README.md`](../../README.md#opencode-plugin-local-smoke-test) for
what they do. To install by hand instead:

1. **Make the `librarian` CLI locatable.** The plugin shells out to `librarian collect`
   (delivery) and `librarian machine-id` (machine id). Build the CLI (`npm run build` at
   the repo root produces `dist/cli.js`), then let the plugin find it. It resolves the CLI
   in this order — **it does not require `PATH`**:

   1. `LIBRARIAN_BIN` env var (an absolute path to `cli.js` or an executable), else
   2. `~/.librarian/config.json` `{ "bin": "/abs/path/to/dist/cli.js" }` — the durable
      choice, read from disk at runtime so it works regardless of how OpenCode was
      launched (the setup script writes this for you), else
   3. the built `dist/cli.js` located relative to this plugin file (the zero-config
      default for a repo checkout), else
   4. a bare `librarian` on `PATH` (last-resort convenience).

   When the resolved CLI is a `.js` file it needs a JS runtime to run it, and the plugin
   **cannot** assume its own `process.execPath` is one: inside OpenCode that is the compiled
   `opencode` binary, which, handed a `.js`, just re-invokes itself and prints its help —
   the collector never runs and no events are written. So a `.js` is paired with a runtime
   resolved as: `LIBRARIAN_RUNTIME` env / config `{ "runtime": "/abs/path/to/node" }` (the
   setup script records the `node` it validated with, making this deterministic), else
   `process.execPath` only when it looks like `node`/`bun`/`deno`, else a `node`/`bun`
   discovered from `NVM_BIN`/`BUN_INSTALL`, else the `.js` is spawned directly via its
   `#!/usr/bin/env node` shebang (the setup script sets its exec bit). Why not rely on
   `PATH`: OpenCode is a native binary, and the `PATH` its plugin child inherits depends on
   how OpenCode was launched (terminal vs desktop app vs login service vs package manager) —
   nvm/asdf/Homebrew/GUI launches routinely leave a bare `librarian` unresolvable.

2. **Drop the plugin file where OpenCode loads plugins from:**
   - `~/.config/opencode/plugins/` — global (all projects), or
   - `.opencode/plugins/` — per-project.

   Copy (or symlink) `plugin.ts` there, keeping `map.ts` alongside it (the plugin imports
   `./map.ts`). For example:

   ```sh
   mkdir -p ~/.config/opencode/plugins/librarian
   cp adapters/opencode/map.ts adapters/opencode/plugin.ts \
      ~/.config/opencode/plugins/librarian/
   ```

   OpenCode loads TypeScript plugin files directly; no build step for the plugin itself.

3. That's it. New OpenCode sessions will emit canonical events to
   `~/.librarian/data/events/<session_id>.ndjson` via the collector.

## What gets emitted (mapping rules, §10.1)

| Native OpenCode signal            | Canonical event | Notes |
| --------------------------------- | --------------- | ----- |
| User prompt                       | `PromptEvent`   | `prompt` shipped **raw** (collector redacts). |
| Tool execution                    | `ToolEvent`     | `tool.native_name` = OpenCode's tool name; `canonical_name` ∈ read/write/edit/bash/search/unknown; `category` ∈ file_read/file_write/command/search/vcs_commit/vcs_push/other. |
| bash `git commit …`               | `ToolEvent`     | category sharpened to `vcs_commit`; `hints.possibly_salient` (`reason: vcs_commit`). |
| bash `git push …`                 | `ToolEvent`     | category sharpened to `vcs_push`. |
| File tool (read/write/edit)       | `ToolEvent`     | `files[]` populated; file writes get `hints.possibly_salient` (`reason: file_write`). |
| Session start / stop / compact    | `SessionEvent`  | `action` ∈ start/stop/compact/checkpoint. |

`resource` carries `agent: "opencode"`, `machine_id` (read from the persisted
`~/.librarian/machine-id`, or `MACHINE_ID_PATH` when set; the CLI's `machine-id` is only
the bootstrap that first writes that file), `cwd`, and `git_root`/`git_remote`/`git_branch`
when resolvable —
**facts, not identity**. `agent_version` is back-filled from `Session.version` once
`session.created` is observed (OpenCode surfaces its version only on the full `Session`
object), after which every later event in the session carries it. There is deliberately
no `project_slug` on events (§10.1). The adapter stamps `event_id` (ULID) and `ts` before
handoff. `hints` are non-authoritative and optional; the collector and distiller own
judgment.

## OpenCode hooks used

The mapping table above is the canonical contract; the specific OpenCode hooks the plugin
subscribes to (pinned to the `@opencode-ai/plugin`/`sdk` surface) are:

| Hook | Emits | Notes |
| ---- | ----- | ----- |
| `chat.message` | `PromptEvent` (user messages) | One-shot "new message received". Chosen over `experimental.chat.messages.transform`, which is a whole-history transform firing every round-trip (would duplicate prompts). Prompt is captured at first receipt; **updated/edited messages are deferred** (not re-emitted). Deduped by message id. |
| `tool.execute.after` | `ToolEvent` | Tool args (command line, `filePath`) are read from `input.args`. |
| `experimental.session.compacting` | `SessionEvent` (`compact`) | Fires **before** compaction (distinct from the post-hoc `session.compacted` event); the plugin is a pure observer and does not modify the compaction prompt. |
| `event` → `session.created` | `SessionEvent` (`start`) | Fires **exactly once** per session (unlike Claude Code's repeated `SessionStart`). Also back-fills `agent_version`. |
| `event` → `session.deleted` | `SessionEvent` (`stop`) | The one-shot "session ended" signal (`session.idle` repeats per turn and is intentionally not used). |

There is no `turn` concept in the OpenCode payloads, so `context.turn` is left unset
(the schema allows it to be absent).

## v1 ceiling

`plugin.ts` spawns `librarian collect` **once per event**. That is intentional for v1
(correctness over throughput, no long-lived child to supervise). The ceiling is marked
with a `ponytail:` comment in the source; when it bites, the fix is a single long-lived
`collect` child or an idle-flushed batch buffer — not more logic in the plugin.

## Tests

- Pure-mapping + pipeline coverage lives in
  [`tests/adapters/opencode.test.ts`](../../tests/adapters/opencode.test.ts).
- Origin-qualification fixtures (§9) live in [`fixtures/opencode/`](../../fixtures/opencode/);
  see that directory's `README.md`. Adding a fixture pair requires **no** test-code edits —
  fixtures are auto-discovered.
