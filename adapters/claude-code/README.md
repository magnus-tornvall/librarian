# Claude Code instrumentation adapter (`origin: claude-code`)

The second real instrumentation for librarian (roadmap item 6, spec §4; §12: "OpenCode
first … Claude Code second"). It maps native Claude Code hook payloads onto the canonical
event schema ([`schema/event.md`](../../schema/event.md)) and pipes them into `librarian
collect`. It is **dumb by design**: map native → canonical, stamp Resource facts, emit
cheap non-authoritative salience hints, hand off. No domain logic — redaction, validation,
and salience authority all live in the collector and distiller (§4, §5).

This adapter follows the conventions of the merged OpenCode adapter
([`adapters/opencode/`](../opencode/)) — a pure `map.ts` tested by golden fixtures, a thin
delivery shell, fixture auto-discovery — and deviates only where Claude Code's hook model
forces it (see below).

## Layout

- **`map.ts`** — a *pure* mapping module: native Claude Code hook payload → canonical
  event(s). No I/O, no process spawning, no clock, no crypto. Everything machine-specific
  (the `resource` facts, the `event_id` ULID, the `ts`) is **injected** by the caller. This
  is what the origin-qualification fixtures test, and it is what makes the mapping testable
  without a Claude Code runtime.
- **`hook.ts`** — the executable hook entry (the only part that does I/O). Claude Code
  invokes a `command` hook by writing the event's JSON to the script's **stdin**; `hook.ts`
  reads it, lowers it onto the mapper's shape, resolves the `resource` facts, stamps
  `event_id`/`ts`, calls `map()`, and pipes the resulting NDJSON to `librarian collect`
  (one spawn per event for v1 — see the ceiling note below).
- **`settings-snippet.json`** — the `hooks` block to merge into `~/.claude/settings.json`.

## Deviations from the OpenCode adapter

Claude Code's hook model differs from OpenCode's plugin model, so:

- **The native payload is Claude Code's real hook JSON**, not an SDK-normalized terse
  shape. The mapper keys on `hook_event_name` (Claude Code's payload is the public,
  documented interface — a stable contract — unlike OpenCode's drifting hook names).
- **Each hook is a fresh short-lived process** (Claude Code spawns the `command` per
  event), so `hook.ts` resolves `resource` per invocation rather than once at plugin init.
- **`SessionStart` fires repeatedly** (startup, resume, `/clear`, compaction) — unlike
  OpenCode's one-shot `session.created`. Every `SessionStart` maps to `action: "start"`;
  the adapter does not editorialize the source (dumb mapping, §4).
- **Hook-safety is load-bearing.** A `command` hook that fails could break the user's
  Claude Code session, so `hook.ts` **always exits 0** and never writes to stdout (Claude
  Code interprets some hook stdout as decision control / added context). On any internal
  error it logs to stderr and exits 0. Loud failure belongs to `librarian collect`'s own
  stderr, which the hook captures and re-logs.

## Install

1. **`librarian` must be on `PATH`.** The hook shells out to `librarian collect`
   (delivery) and `librarian machine-id` (machine id). Build the CLI (`npm run build` at the
   repo root produces `dist/cli.js`, exposed as the `librarian` bin) and make it resolvable
   — e.g. `npm link` in this repo, or symlink `dist/cli.js` onto your `PATH`.

2. **Node ≥ 22.18 must be on `PATH`.** The hook is a TypeScript file run directly by
   `node adapters/claude-code/hook.ts` (Node runs `.ts` natively at this version — the same
   version the repo's `engines` pins). No build step for the hook itself.

3. **Merge the hooks block into your settings.** Copy the four hook events from
   [`settings-snippet.json`](./settings-snippet.json) into `~/.claude/settings.json`
   (global, all projects) or `.claude/settings.json` (a single project). **Replace the
   placeholder path** `/ABSOLUTE/PATH/TO/librarian/adapters/claude-code/hook.ts` with the
   real absolute path to `hook.ts` in your clone. The snippet wires all four events:

   - `UserPromptSubmit` → `PromptEvent`
   - `PostToolUse` (matcher `"*"`, every tool) → `ToolEvent`
   - `SessionStart` → `SessionEvent(action: "start")`
   - `Stop` → `SessionEvent(action: "stop")`

   If you already have hooks configured, merge these entries into the existing arrays for
   each event rather than replacing the whole `hooks` object.

   > **Future packaging (avoids the manual absolute path).** Claude Code substitutes
   > [`${CLAUDE_PLUGIN_ROOT}`](https://docs.claude.com/en/docs/claude-code/plugins-reference#environment-variables)
   > — the absolute path to a plugin's install directory — into hook `command`/`args`. When
   > this adapter is shipped as a proper Claude Code plugin, the snippet becomes
   > `"args": ["${CLAUDE_PLUGIN_ROOT}/hook.ts"]` (exec form, no quoting), so the hook path
   > resolves with no PATH assumption and no user-edited placeholder. This is the Claude
   > Code analogue of the OpenCode adapter's `~/.librarian/config.json` `bin` resolution;
   > it is deferred packaging work, not part of the current manual install.

4. That's it. New Claude Code sessions on that machine (or in that project) will emit
   canonical events to `~/.librarian/data/events/<session_id>.ndjson` via the collector.
   This is the **dogfooding moment** (§14): once installed, build sessions on this repo get
   recorded. That is configuration, not code — there is deliberately no auto-install magic.

## What gets emitted (mapping rules, §10.1)

| Native Claude Code hook              | Canonical event | Notes |
| ------------------------------------ | --------------- | ----- |
| `UserPromptSubmit`                   | `PromptEvent`   | `prompt` shipped **raw** (collector redacts). |
| `PostToolUse`                        | `ToolEvent`     | `tool.native_name` = Claude Code's `tool_name` (capitalized, e.g. `Bash`); `canonical_name` ∈ read/write/edit/bash/search/unknown; `category` ∈ file_read/file_write/command/search/vcs_commit/vcs_push/other. |
| `PostToolUse` `Write`/`Edit`         | `ToolEvent`     | canonical write/edit + `category: file_write` + `files[]` (from `tool_input.file_path`); file writes get `hints.possibly_salient` (`reason: file_write`). |
| `PostToolUse` `Read`                 | `ToolEvent`     | read / file_read; `files[]` action `read`; no hint. |
| `PostToolUse` `Grep`/`Glob`          | `ToolEvent`     | search / search. |
| `PostToolUse` `Bash`                 | `ToolEvent`     | bash / command, `command` populated from `tool_input.command`; `git commit` / `git push` detection sharpens the category to `vcs_commit` / `vcs_push`. |
| `PostToolUse` (any other tool)       | `ToolEvent`     | unknown / other. |
| `SessionStart`                       | `SessionEvent`  | `action: "start"` (every source). |
| `Stop`                               | `SessionEvent`  | `action: "stop"`. |

`resource` carries `agent: "claude-code"`, `machine_id` (via `librarian machine-id` or
`MACHINE_ID_PATH`), `cwd` (from the hook payload), and `git_root`/`git_remote`/`git_branch`
when resolvable — **facts, not identity**. `agent_version` is left unset (Claude Code's hook
payloads do not carry the CLI version, and the spec forbids faking an unresolvable fact).
There is deliberately no `project_slug` on events (§10.1). `context.session_id` comes from
the payload's `session_id`. The adapter stamps `event_id` (ULID) and `ts` before handoff.
`hints` are non-authoritative and optional; the collector and distiller own judgment. There
is no `turn` concept in Claude Code hook payloads, so `context.turn` is left unset (the
schema allows it to be absent).

## v1 ceiling

`hook.ts` spawns `librarian collect` **once per event**. That is intentional for v1
(correctness over throughput, no long-lived child to supervise; each Claude Code hook is
already its own short-lived process). The ceiling is marked with a `ponytail:` comment in
the source; when it bites, the fix is a batching buffer, not more logic in the hook.

## Tests

- Pure-mapping + pipeline coverage lives in
  [`tests/adapters/claudeCode.test.ts`](../../tests/adapters/claudeCode.test.ts).
- Origin-qualification fixtures (§9) live in
  [`fixtures/claude-code/`](../../fixtures/claude-code/); see that directory's `README.md`.
  Adding a fixture pair requires **no** test-code edits — fixtures are auto-discovered.
- The test suite also proves the end-to-end pipe through the real `librarian collect`, that
  a secret-bearing Bash command lands **redacted**, and that feeding `hook.ts` a malformed
  payload **exits 0** (never breaks the host session) while writing the error to stderr.
