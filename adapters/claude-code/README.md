# Claude Code adapter (`origin: claude-code`)

The Claude Code integration ships as a **thin Claude Code plugin**
([`.claude-plugin/plugin.json`](../../.claude-plugin/plugin.json)): the manifest declares
six `command` hooks and a stdio MCP server, all routed through the single installed
`librarian` bin. Each hook runs `librarian hook claude-code`, which maps the native hook
payload onto the canonical event schema ([`schema/event.md`](../../schema/event.md)) and
pipes it into `librarian collect`. For `UserPromptSubmit` and `SessionStart` it also shells
out to `librarian inject` and returns Claude Code `additionalContext` when the recall seam
prints a block. It is **dumb by design**: spawn the seam, emit its output, nothing else. No
domain logic — redaction, validation, salience authority, and push austerity live in the
collector, distiller, and `librarian inject` (§4, §5, §6).

Unlike the OpenCode adapter ([`adapters/opencode/`](../opencode/)), whose plugin file
carries logic in its own runtime, the Claude Code plugin bundles **no code** — the manifest
only names `librarian` subcommands (spec §14 amendment: a thin plugin, not three copies of
`dist/`). The mapping and I/O therefore live **behind the bin**, in `src/`:

## Layout

- **[`src/hook/claudeCodeMap.ts`](../../src/hook/claudeCodeMap.ts)** — a *pure* mapping
  module: native Claude Code hook payload → canonical event(s). No I/O, no process spawning,
  no clock, no crypto. Everything machine-specific (the `resource` facts, the `event_id`
  ULID, the `ts`) is **injected** by the caller. This is what the origin-qualification
  fixtures test, and what makes the mapping testable without a Claude Code runtime.
- **[`src/hook/claudeCode.ts`](../../src/hook/claudeCode.ts)** — the I/O shell behind
  `librarian hook claude-code` (the only part that does I/O). Claude Code invokes a
  `command` hook by writing the event's JSON to the process's **stdin**; the shell reads it,
  lowers it onto the mapper's shape, resolves the `resource` facts, stamps `event_id`/`ts`,
  calls `map()`, and pipes the resulting NDJSON to `librarian collect`. For
  `UserPromptSubmit` and `SessionStart`, after collect handoff it spawns `librarian inject`
  and returns the block as `hookSpecificOutput.additionalContext` only when stdout is
  non-empty.
- **[`.claude-plugin/plugin.json`](../../.claude-plugin/plugin.json)** — the plugin manifest:
  the six hooks (`UserPromptSubmit`, `PostToolUse` matcher `*`, `SessionStart`, `Stop`,
  `SessionEnd`, `PreCompact`) each running `librarian hook claude-code`, plus
  `mcpServers.librarian` → `librarian mcp`.
- **[`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)** — so
  `/plugin marketplace add magnus-tornvall/librarian` resolves this repo as a marketplace.

## Deviations from the OpenCode adapter

Claude Code's hook model differs from OpenCode's plugin model, so:

- **The native payload is Claude Code's real hook JSON**, not an SDK-normalized terse
  shape. The mapper keys on `hook_event_name` (Claude Code's payload is the public,
  documented interface — a stable contract — unlike OpenCode's drifting hook names).
- **Each hook is a fresh short-lived process** (Claude Code spawns the `command` per
  event), so `librarian hook claude-code` resolves `resource` per invocation rather than
  once at plugin init.
- **`SessionStart` fires repeatedly** (startup, resume, `/clear`, compaction) — unlike
  OpenCode's one-shot `session.created`. Every `SessionStart` maps to `action: "start"`;
  the adapter does not editorialize the source (dumb mapping, §4).
- **Hook-safety is load-bearing.** A `command` hook that fails could break the user's
  Claude Code session, so `librarian hook claude-code` **always exits 0**. It writes stdout
  only for valid `additionalContext`; inject failures, timeouts, empty recall, malformed
  payloads, and ignored events emit no stdout. Loud collect failure is re-logged to stderr;
  inject failure is contained so instrumentation remains unaffected.

  The manifest additionally appends **`|| true`** to each hook command. That is not
  belt-and-braces — Claude Code treats a non-zero `UserPromptSubmit` hook as *blocking*
  (the prompt is erased and the hook's stderr shown in its place), and the command is a
  bare-PATH `librarian`, so it may be a build that predates the `hook` subcommand and exits
  2 printing usage. Nothing in this repo can fix a binary already on a user's PATH, so the
  guard is the only place the contract holds by construction. The exit code inside the bin
  is deliberately *not* uniform: a runtime failure exits 0 (silent, never breaks a session),
  while a bad agent name — reachable only by hand-writing a hook command, never from this
  manifest — exits 2 loudly rather than collecting nothing in silence.

## Install

With `librarian` on PATH (install it via [`scripts/install.sh`](../../scripts/install.sh)),
from inside Claude Code:

```
/plugin marketplace add magnus-tornvall/librarian
/plugin install librarian
```

That wires the six hooks (`UserPromptSubmit`, `PostToolUse`, `SessionStart`, `Stop`,
`SessionEnd`, `PreCompact`) and the
stdio MCP server with **no** `settings.json` edit. Fully restart a running Claude Code
session after install.

Once spawned, the hook resolves the CLI for its own `collect`/`inject` children in this
order: `LIBRARIAN_BIN` (an explicit override, used by the tests) → this checkout's built
`dist/cli.js` when present → bare `librarian` on PATH (the installed-binary case).

That order applies only *inside* the hook. The manifest itself can only name a bare
`librarian` — a declarative JSON manifest has no way to express a resolution order — so
**whatever `librarian` is first on PATH is what the plugin runs.** A dev `npm link` shim
(`~/.nvm/.../bin/librarian` → a checkout's `dist/cli.js`) shadows the installed
`~/.librarian/bin/librarian` on a typical dev PATH, and if that checkout predates the `hook`
subcommand the plugin collects nothing. Symptom: `claude` works normally (the `|| true`
guard) but no events appear under `~/.librarian/data/events`. Check with
`command -v librarian` and confirm `echo '{}' | librarian hook claude-code; echo $?` is 0,
not 2.

### Dogfooding from a checkout

The authenticated, token-consuming end-to-end check is developer-machine tooling, not part of
`npm test` or CI. It drives the plugin through a real `claude -p` session, so `librarian`
must resolve to this checkout's build (e.g. `LIBRARIAN_BIN`, or install a binary built from
this checkout):

```sh
./scripts/opencode-setup.sh   # only if verifying OpenCode too
./scripts/dogfood-verify.sh claude-code
```

The verifier checks both agents by default; pass `claude-code` or `opencode` to verify only
one. Collected data under `~/.librarian` is left untouched.

There is no `claude-code-setup.sh`; the plugin replaced it. To exercise a checkout's manifest
without installing it, Claude Code loads a plugin for one session from a directory:

```sh
claude --plugin-dir "$PWD" -p 'hello'
```

That is also how to verify the plugin *is* the sole wiring — a leftover
`.claude/settings.local.json` from the retired setup script would instrument the session too,
and `dogfood-verify.sh` is agnostic to which one did the work, so a PASS with both present
proves nothing about the plugin. Remove the legacy hooks first.

## What gets emitted (mapping rules, §10.1)

| Native Claude Code hook              | Canonical event | `boundary` | Notes |
| ------------------------------------ | --------------- | ---------- | ----- |
| `UserPromptSubmit`                   | `PromptEvent`   | — | `prompt` shipped **raw** (collector redacts). |
| `PostToolUse`                        | `ToolEvent`     | — | `tool.native_name` = Claude Code's `tool_name` (capitalized, e.g. `Bash`); `canonical_name` ∈ read/write/edit/bash/search/unknown; `category` ∈ file_read/file_write/command/search/vcs_commit/vcs_push/other. |
| `PostToolUse` `Write`/`Edit`         | `ToolEvent`     | — | canonical write/edit + `category: file_write` + `files[]` (from `tool_input.file_path`); file writes get `hints.possibly_salient` (`reason: file_write`). |
| `PostToolUse` `Read`                 | `ToolEvent`     | — | read / file_read; `files[]` action `read`; no hint. **No `outcome`** — its `tool_response` is the file's contents. |
| `PostToolUse` `Grep`/`Glob`          | `ToolEvent`     | — | search / search. No `outcome` — a search is re-runnable in a second. |
| `PostToolUse` `Bash`                 | `ToolEvent`     | `{semantic, git_commit}` on a `vcs_commit` that did **not** fail | bash / command, `command` populated from `tool_input.command`; `git commit` / `git push` detection sharpens the category to `vcs_commit` / `vcs_push`. `outcome` (`stdout`/`stderr`/`interrupted`) is lifted from `tool_response`, empty streams elided. `interrupted` — and only `interrupted` — sets `hints.possibly_salient` (`reason: command_failed`), which outranks the file_write/vcs_commit hints. **stderr is not a failure signal:** over 1217 real Bash results the payload had no exit code, never set `is_error`, and all 266 non-empty `stderr` values were Claude Code's own "Shell cwd was reset to …" notice while real failures printed to stdout. The distiller reads the captured output and judges for itself. Note the asymmetry: the **OpenCode** adapter lifts a real `metadata.exit` and does fire this hint. |
| `PostToolUse` `TodoWrite`            | `ToolEvent`     | `{semantic, todos_complete}` when **every** todo is `completed` | unknown / other like any untabled tool; only `tool_input.todos` is read, and strictly — an empty list is no completion, and `cancelled` means dropped, not finished. |
| `PostToolUse` (any other tool)       | `ToolEvent`     | — | unknown / other. |
| `SessionStart`                       | `SessionEvent`  | — | `action: "start"` (every source). |
| `Stop`                               | `SessionEvent`  | — | `action: "stop"`. Deliberately **no** boundary: `Stop` fires once per assistant turn, not once per session. |
| `SessionEnd`                         | `SessionEvent`  | `{terminal, session_end}` | `action: "end"`. The genuine one-shot session boundary; `reason` (clear/logout/prompt_input_exit/other) is not remapped. |
| `PreCompact`                         | `SessionEvent`  | `{compaction, compact}` | `action: "compact"`. Recorded landmark only — see below. |

`boundary` marks the events where an arc actually **closed**, so a distill trigger has
something better than a clock to act on ([`schema/event.md`](../../schema/event.md)). The
adapter reports it and never decides what to do with it — firing is the trigger's call (§4).
Two rules are load-bearing here: a `compaction` boundary must **not** fire a distill (the
context window filled, which is not the work finishing, and librarian's own durable event log
means compaction destroys nothing it needs), and a hard-killed terminal fires no `SessionEnd`
at all — boundaries are an optimisation on top of the trigger's timeout and scheduled net,
never the guarantee.

`resource` carries `agent: "claude-code"`, `machine_id` (via `librarian machine-id` or
`MACHINE_ID_PATH`), `cwd` (from the hook payload), and `git_root`/`git_remote`/`git_branch`
when resolvable — **facts, not identity**. `agent_version` is left unset (Claude Code's hook
payloads do not carry the CLI version, and the spec forbids faking an unresolvable fact).
There is deliberately no `project_slug` on events (§10.1). `context.session_id` comes from
the payload's `session_id`. The adapter stamps `event_id` (ULID) and `ts` before handoff.
`hints` are non-authoritative and optional; the collector and distiller own judgment. There
is no `turn` concept in Claude Code hook payloads, so `context.turn` is left unset (the
schema allows it to be absent).

## What gets injected (§6)

| Native Claude Code hook | Recall command | Claude Code layout |
| ----------------------- | -------------- | ------------------ |
| `SessionStart` | `librarian inject --global --project <git-root-basename> --session-start` | Stable turn-1 prefix: project brief + curated startup context. |
| `UserPromptSubmit` | `librarian inject --global --project <git-root-basename>` with the prompt on stdin | Per-prompt volatile suffix adjacent to that user prompt. |

`--global` is always passed. `--project` uses the git root basename when the hook runs in a
repo; outside a repo the adapter sends only global scope. If `librarian inject` prints
nothing, the hook prints nothing — no empty `additionalContext` wrapper. If inject fails or
times out, the hook still exits 0 and instrumentation collect is unaffected.

Claude Code re-fires `SessionStart` on startup, resume, `/clear`, and compaction, so the
stable brief is recomputed at those session-boundary mutation points. That is the Claude
Code parity answer to OpenCode's compaction handling; the adapter does not inspect or
editorialize the source. To explain why a pushed block appeared, run `librarian why
<injection_id>` using the id in the `<librarian-memory ...>` tag.

## v1 ceiling

`librarian hook claude-code` spawns `librarian collect` once per event and, for
injection-capable hooks, `librarian inject` once per invocation. That is intentional for v1 (correctness over
throughput, no long-lived child to supervise; each Claude Code hook is already its own
short-lived process). The throughput ceiling is set by the `PostToolUse` matcher `*`: two
processes per tool call (the hook, then `collect`), paid on every tool call of every turn.
The collect ceiling and project-slug heuristic are marked with
`ponytail:` comments in the source; when throughput bites, the fix is a batching buffer,
not more logic in the hook.

## Tests

- Pure-mapping + pipeline coverage lives in
  [`tests/adapters/claudeCode.test.ts`](../../tests/adapters/claudeCode.test.ts).
- Origin-qualification fixtures (§9) live in
  [`fixtures/claude-code/`](../../fixtures/claude-code/); see that directory's `README.md`.
  Adding a fixture pair requires **no** test-code edits — fixtures are auto-discovered.
- The test suite also proves the end-to-end pipe through the real `librarian collect`, that
  a secret-bearing Bash command lands **redacted**, that hook injection matches `librarian
  inject` output modulo `injection_id`, and that malformed payloads or inject failures
  **exit 0** without breaking instrumentation.
