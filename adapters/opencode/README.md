# OpenCode instrumentation adapter (`origin: opencode`)

The first real instrumentation for librarian (roadmap item 6, spec §4). It maps native
OpenCode events onto the canonical event schema ([`schema/event.md`](../../schema/event.md))
and pipes them into `librarian collect`. It is **dumb by design**: map native → canonical,
stamp Resource facts, emit cheap non-authoritative salience hints, hand off. No domain
logic — redaction, validation, and salience authority all live in the collector and
distiller (§4, §5).

## Where the code lives

OpenCode is the only host librarian supports that loads **executable JS in-process**, so
exactly one file has to land inside it. Everything else lives behind the installed binary
(spec §14 amendment):

```
plugin (in OpenCode's process)  ── {hook, cwd, input, output} ─▶  librarian hook opencode
                                ◀─ {brief, recall}                (lower → map → collect → inject)
```

- **`plugin.ts`** — the whole in-host integration, and **the file the wizard installs**. It
  imports nothing but node builtins: no `ulid`, no `better-sqlite3`, no MCP SDK, nothing for
  OpenCode to resolve. Its only jobs are the three the binary cannot do from outside the host
  process: locate the binary, hold the per-session brief/recall cache (a hook process lives
  for one event), and splice the cached blocks into the outgoing message array.
- **`librarian hook opencode`** ([`src/hook/opencode.ts`](../../src/hook/opencode.ts)) — the
  I/O shell: lower the raw native payload, resolve the `resource` facts, stamp `event_id`/`ts`,
  call the mapper, pipe to `librarian collect`, and print the injection blocks back.
- **[`src/hook/opencodeMap.ts`](../../src/hook/opencodeMap.ts)** — the *pure* mapper: native
  payload → canonical event(s). No I/O, no spawning, no clock, no crypto; everything
  machine-specific is **injected** by the shell. This is what the origin-qualification
  fixtures test, and what makes the mapping testable without an OpenCode runtime. It lives
  under `src/` because `tsc` compiles only `src/` (`rootDir=src`) and rewrites `.ts`→`.js`,
  so a `src/ → adapters/` import would diverge between the dev build and the SEA bundle.

Why the plugin ships *any* code: Claude Code hands `additionalContext` back over stdout from
a spawned command; OpenCode has no such channel. Recall is spliced in
`experimental.chat.messages.transform`, which mutates OpenCode's own outgoing array — that
has to run in-process.

## Install (the supported path)

```sh
librarian init
```

The wizard's OpenCode step writes `plugin.ts` to `~/.config/opencode/plugins/librarian.ts`
and records `bin` in `~/.librarian/config.json` pointing at the installed binary
(`~/.librarian/bin/librarian` — see [`scripts/install.sh`](../../scripts/install.sh)). The
installed binary carries the plugin as an embedded build asset, so this works with no
checkout on the machine. Plugins load only at startup — **restart OpenCode**. Re-running
`librarian init` overwrites the file, which is how an update lands.

No npm package, no release ref, no second repo: one file is a complete delivery mechanism
for one file. The why-nots are recorded in the spec's §14 amendment (2026-07-29).

Nothing is needed for MCP-only hosts (Codex, Cursor, ChatGPT, …) — they take a config entry
pointing at `librarian mcp`, not a plugin.

### How the plugin finds the binary

Resolution order — **it does not require `PATH`**:

1. `LIBRARIAN_BIN` env var (an absolute path to an executable or a `.js`), else
2. `~/.librarian/config.json` `{ "bin": "…" }` — what the wizard writes. This is the
   production mechanism: read from disk at runtime, so it survives whatever launch
   environment OpenCode came from (unlike an env var or a shell `PATH`), else
3. the built `dist/cli.js` two dirs above the plugin file — the zero-config default for a
   repo checkout (the dev inner loop below), else
4. a bare `librarian` on `PATH` (last-resort convenience).

Why not rely on `PATH`: OpenCode is a native binary, and the `PATH` its plugin child inherits
depends on how OpenCode was launched (terminal vs desktop app vs login service vs package
manager) — nvm/asdf/Homebrew/GUI launches routinely leave a bare `librarian` unresolvable.

When the resolved target is a `.js` it needs a JS runtime, and the plugin **cannot** assume
its own `process.execPath` is one: inside OpenCode that is the compiled `opencode` binary,
which, handed a `.js`, re-invokes itself and prints its help — nothing collects. So a `.js` is
paired with a runtime resolved as: `LIBRARIAN_RUNTIME` env / config `{ "runtime": "…" }`, else
`process.execPath` only when it looks like `node`/`bun`/`deno`, else a `node`/`bun` discovered
from `NVM_BIN`/`BUN_INSTALL`, else the `.js` is spawned directly via its shebang. The
supported install points `bin` at a real executable, so none of this applies to it.

## Dev inner loop

For iterating on the adapter inside this repo, the scripts install the plugin per-project
instead (a symlink into the repo-root `.opencode/plugins/`, so edits are picked up on the
next session with no re-copy) and point `bin` at `dist/cli.js`:

```sh
./scripts/opencode-setup.sh      # build + write config bin/runtime + symlink plugin into .opencode/plugins/
./scripts/opencode-teardown.sh   # remove the symlink + drop the config bin/runtime
```

See the top-level [`README.md`](../../README.md#opencode-plugin) for what they do. This is
throw-away smoke-test tooling; `librarian init` is the supported install.

## Recall Injection

On `chat.message` the plugin forwards the raw payload to `librarian hook opencode`, which runs
`librarian inject` with the prompt on stdin — always `--global` plus `--project
<git-root-basename>` when the session is inside a git repo — and returns the block. The plugin
caches it by session; on `experimental.chat.messages.transform` it splices that exact stdout
into the outgoing payload as a synthetic text part, after removing any prior librarian part so
repeated transform fires stay idempotent.

The first user turn also asks for the startup brief (`librarian inject --session-start`); that
brief is pinned to the **first** user message, while per-turn recall stays adjacent to the
**latest** one. The shell distinguishes "ran and had nothing to say" (a below-floor prompt)
from "the call failed", so a failed brief is retried next turn while a successful empty one is
not re-asked. Each `inject` gets a hard 1s budget — recall must not add perceptible latency,
and a timeout is reported as "no block", never as an error.

The adapter deliberately avoids `experimental.chat.system.transform`: that hook lacks the user
message, while `messages.transform` is ephemeral and does not persist injected text to chat
history. If an injected block has an `injection_id`, run `librarian why <injection_id>` to see
why it was selected.

> **The in-place rule — read before touching either transform hook.** OpenCode's hook contract
> is *"mutate `output` in place; return `void`"*. For `messages.transform` that means mutating
> the message **array object**: verified in OpenCode 1.18.9, the call site is
> `trigger('experimental.chat.messages.transform', {}, { messages: ze })` followed by
> `toModelMessagesEffect(ze, …)`, so it converts the array it handed the plugin. Rebinding
> `output.messages = newArray` — or returning `{ ...output, messages }` — is silently dropped
> and **the injection never reaches the model**, with no error anywhere. `messages.splice(0,
> messages.length, ...spliced)` is the fix. `experimental.session.compacting` is the same
> shape: `context` arrives as an array to push onto and `prompt` arrives `undefined`, and the
> object the plugin was handed is the one OpenCode reads back. A test that asserts on a
> returned value cannot see this class of bug — assert through the object you passed in.

## What gets emitted (mapping rules, §10.1)

| Native OpenCode signal            | Canonical event | Notes |
| --------------------------------- | --------------- | ----- |
| User prompt                       | `PromptEvent`   | `prompt` shipped **raw** (collector redacts). |
| Tool execution                    | `ToolEvent`     | `tool.native_name` = OpenCode's tool name; `canonical_name` ∈ read/write/edit/bash/search/unknown; `category` ∈ file_read/file_write/command/search/vcs_commit/vcs_push/other. |
| bash `git commit …`               | `ToolEvent`     | category sharpened to `vcs_commit`; `hints.possibly_salient` (`reason: vcs_commit`). |
| bash `git push …`                 | `ToolEvent`     | category sharpened to `vcs_push`. |
| File tool (read/write/edit)       | `ToolEvent`     | `files[]` populated; file writes get `hints.possibly_salient` (`reason: file_write`). No `outcome` — a read's result is a copy of a file on disk. |
| bash / vcs tool output            | `ToolEvent`     | `outcome.stdout` lifted from `output.output` (a single combined string — OpenCode never splits stderr) and `outcome.exit` from `output.metadata.exit`. A non-zero exit, or `interrupted`, sets `hints.possibly_salient` (`reason: command_failed`). **OpenCode is the adapter that can honour that hint:** its harness reports a real exit code, present on 3639 of 3673 measured bash calls, every non-zero one with `status: "completed"` so the hook fires. Claude Code's payload has no exit code at all. Reading `metadata.exit` stays inside §4 — the adapter reports a verdict its harness reached, it does not derive one. Known false positives (~15%): `grep` with no match, `git config --get` on an unset key, where non-zero is a negative answer rather than a failure. |
| Session start / end / compact     | `SessionEvent`  | `action` ∈ start/end/stop/compact/checkpoint. `session.created` → `start`, `session.deleted` → `end`, `experimental.session.compacting` → `compact`. |
| Arc boundaries (issue #169)       | any event       | `boundary: {kind, signal}` on the events that **close** an arc: `session.deleted` → `{terminal, session_end}`, a `vcs_commit` that did **not** fail → `{semantic, git_commit}`, a `todowrite` leaving every todo `completed` → `{semantic, todos_complete}`, compaction → `{compaction, compact}` (a recorded landmark that must **never** fire a distill). Absent everywhere else. The vocabulary is identical to the Claude Code adapter's on purpose — a consumer switches on one field, and `resource.agent` still says which agent it was. Because OpenCode reports a real `metadata.exit`, a **failed** `git commit` correctly carries no boundary; Claude Code's payload cannot see that. Deciding what to do with a boundary is the trigger's job, not the adapter's (§4). |

`resource` carries `agent: "opencode"`, `machine_id` (read from the persisted
`~/.librarian/machine-id`, or `MACHINE_ID_PATH` when set; the CLI's `machine-id` is only the
bootstrap that first writes that file), `cwd`, and `git_root`/`git_remote`/`git_branch` when
resolvable — **facts, not identity**. `cwd` comes from the plugin (`ctx.worktree ??
ctx.directory`): no OpenCode payload carries it, and the shell resolves the git facts from it.
`agent_version` is captured from `Session.version` when `session.created` is observed (OpenCode
surfaces its version only on the full `Session` object) and stamped onto every envelope from
then on — the shell is one process per event and cannot remember it. There is deliberately no
`project_slug` on events (§10.1). The shell stamps `event_id` (ULID) and `ts` before handoff.
`hints` are non-authoritative and optional; the collector and distiller own judgment.

## OpenCode hooks used

The mapping table above is the canonical contract; the specific OpenCode hooks the plugin
subscribes to (pinned to the `@opencode-ai/plugin`/`sdk` surface) are:

| Hook | Emits | Notes |
| ---- | ----- | ----- |
| `chat.message` | `PromptEvent` (user messages) + the turn's recall | One-shot "new message received". Chosen over `experimental.chat.messages.transform`, which is a whole-history transform firing every round-trip (would duplicate prompts). Prompt is captured at first receipt; **updated/edited messages are deferred** (not re-emitted). Deduped by message id in the plugin. |
| `experimental.chat.messages.transform` | — | The splice. Idempotent by construction (prior librarian parts are stripped first). |
| `tool.execute.after` | `ToolEvent` | Tool args (command line, `filePath`) are read from `input.args`. What the tool printed is read from `output.output` — and the plugin forwards `output` **only when `input.args.command` is set**, so a read never serializes a whole file into the hook's stdin for a field the collector would drop. |
| `experimental.session.compacting` | `SessionEvent` (`compact`, `{compaction, compact}` boundary) + memory re-supply | Fires **before** compaction (distinct from the post-hoc `session.compacted` event); appends the cached startup brief and latest recall when OpenCode exposes a compaction prompt/context. |
| `event` → `session.created` | `SessionEvent` (`start`) | Fires **exactly once** per session (unlike Claude Code's repeated `SessionStart`). Also captures `agent_version`. |
| `event` → `session.deleted` | `SessionEvent` (`end`, `{terminal, session_end}` boundary) | The one-shot "session ended" signal (`session.idle` repeats per turn and is intentionally not used, or every turn would look like an ending). |

The hook **names** are not the canonical contract (they drift across OpenCode versions); the
mapping is. When a hook name or payload changes, only the plugin's subscription list and the
shell's lowering change — the mapper and its fixtures are untouched.

There is no `turn` concept in the OpenCode payloads, so `context.turn` is left unset (the
schema allows it to be absent).

## v1 ceiling

One process spawn per hook event (`librarian hook opencode`), which itself spawns `librarian
collect` and up to two `librarian inject`. Intentional for v1: correctness over throughput, no
long-lived child to supervise. The ceiling is marked with `ponytail:` comments in the source;
when it bites, the fix is a single persistent child speaking the same envelope protocol over a
pipe — not more logic in the plugin.

## Tests

- Pure-mapping + pipeline coverage: [`tests/adapters/opencode.test.ts`](../../tests/adapters/opencode.test.ts).
- The `librarian hook opencode` shell, black-box through the real subcommand:
  [`tests/adapters/opencodeHook.test.ts`](../../tests/adapters/opencodeHook.test.ts).
- The plugin file's own contract (envelopes out, splice in):
  [`tests/adapters/opencode-inject.test.ts`](../../tests/adapters/opencode-inject.test.ts).
- The wizard install, including the "imports nothing outside node builtins" guard:
  [`tests/cli/initOpencode.test.ts`](../../tests/cli/initOpencode.test.ts).
- Origin-qualification fixtures (§9): [`fixtures/opencode/`](../../fixtures/opencode/); see that
  directory's `README.md`. Adding a fixture pair requires **no** test-code edits — fixtures are
  auto-discovered.
