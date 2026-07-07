# Claude Code origin-qualification fixtures (§9)

Every new integration ships 3–5 golden content-events with expected outcomes (spec §9).
These are that surface for the Claude Code adapter: each file pairs a **native Claude
Code hook payload** with the **expected canonical event** the pure mapper
([`adapters/claude-code/map.ts`](../../adapters/claude-code/map.ts)) must produce. They
are the primary test surface — the mapping is proven here without a Claude Code runtime.

The runner is [`tests/adapters/claudeCode.test.ts`](../../tests/adapters/claudeCode.test.ts).
It **auto-discovers** every `*.json` in this directory: adding a fixture pair requires no
test-code edits (that is part of the Definition of Done). A "guard the guard" test fails
loudly if discovery finds fewer than 3 fixtures, so the suite can never go vacuously green.

## Fixture shape

```jsonc
{
  "name": "human-readable-case-name",        // required, unique
  "description": "what this case proves",     // optional, documents intent
  "native":   { /* the Claude Code hook payload — the map() input */ },
  "env":      { /* MapEnv — injected event_id, ts, resource, context */ },
  "expected": { /* the canonical event map() must return (single event) */ }
}
```

`native` is the JSON Claude Code writes to a `command` hook's stdin — the real, recorded
shape (`session_id`, `cwd`, `hook_event_name`, and per-event fields like `prompt` for
UserPromptSubmit or `tool_name`/`tool_input` for PostToolUse). `env` carries exactly the
facts and stamps the real hook resolves via I/O and injects into the pure mapper — the
ULID `event_id`, the ISO `ts`, the `resource` block, and the `context`. Because the mapper
is pure and the fixture injects fixed values, its output is fully deterministic.

## Volatile fields excluded from comparison

Per §9, volatile fields are **excluded** from the stable-field comparison:

- **`event_id`** — a ULID, generated fresh per event by the live hook.
- **`ts`** — the wall-clock timestamp, different on every real run.
- **machine-specific `resource` values** — chiefly **`resource.machine_id`**, which is a
  per-machine generated id (never the hostname), plus any host-specific path facts.

The runner asserts the mapper does **not invent or alter** these — it checks that
`event_id`/`ts`/`machine_id` in the output are exactly the injected `env` values (the
mapper passes facts through, it does not author them) — and then compares every remaining
**stable** field (`type`, `tool`, `command`, `files`, `hints`, `context`, `action`, and
the non-volatile `resource` facts) by deep equality. So a fixture's `expected` block still
spells out `event_id`/`ts`/`machine_id` for readability, but a change to those alone would
not fail a case; a change to a stable field would.

## Current fixtures

| File | Native signal | Proves |
| ---- | ------------- | ------ |
| `01-user-prompt-submit.json`           | UserPromptSubmit           | `PromptEvent`, raw prompt, full git resource. |
| `02-post-tool-use-write.json`          | PostToolUse `Write`        | `ToolEvent` file_write, `files[]` from `file_path`, file_write hint, capitalized `native_name`. |
| `03-post-tool-use-bash-git-commit.json`| PostToolUse `Bash` `git commit …` | recategorized `vcs_commit`, raw command, vcs_commit hint. |
| `04-post-tool-use-read.json`           | PostToolUse `Read`         | `ToolEvent` file_read, `files[]` action read, no hint. |
| `05-session-start.json`                | SessionStart               | `SessionEvent` action `start`. |

Additional mapping rules (git push → `vcs_push`, Grep/Glob → search, an unrecognized tool
→ `unknown`/`other`, Stop → `stop`) plus the end-to-end pipe, the redaction pass, and the
hook-safety case are covered by explicit assertions in the test runner.
