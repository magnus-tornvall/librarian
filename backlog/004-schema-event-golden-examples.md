# 004 — schema/examples/event/*.json (5 golden examples)

**Phase:** 1 — Schemas
**Dependencies:** 003 (types + example filenames in `schema/event.md`).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §10.1 (golden-example list) and §14 ("Golden examples: extracted")
**Do not relitigate:** §14 already decided examples are extracted JSON files, not inline code fences — that's this task's whole point, don't second-guess it. Field shapes must match the types in `schema/event.md` (task 003) exactly; don't add fields the type doesn't have.

## Context

Depends on 003 (needs the types and the 5 example names/links already written into `schema/event.md`). These files are dual-purpose: documentation examples *and* fixture input for task 007's test and later qualification fixtures (§9) — so they must be valid, parseable JSON that actually matches the `CanonicalEvent` union, not illustrative pseudo-JSON.

## Task

Create 5 files under `schema/examples/event/`, one JSON object each, matching the names from task 003:

1. `01-prompt-in-git-repo.json` — a `PromptEvent` with a realistic `resource` (including `git_root`/`git_remote`/`git_branch`) and `context`.
2. `02-file-edit-write.json` — a `ToolEvent` with `tool.category: "file_write"`, `files: [{ path, action: "write" }]`.
3. `03-git-commit-vcs-commit.json` — a `ToolEvent` with `tool.category: "vcs_commit"`, a `command` field (a `git commit -m "..."` string), and `hints: { possibly_salient: true, reason: "vcs_commit" }`.
4. `04-redacted-command-with-token.json` — a `ToolEvent` whose `command` field contains a `[REDACTED:token:sha256:...]` placeholder (§5 redaction shape) instead of a real secret — this is what a command *looks like after* redaction, not before.
5. `05-session-checkpoint.json` — a `SessionEvent` with `action: "checkpoint"`.

Every file must include `schema_version: 1`, a plausible ULID-shaped `event_id` (26-char Crockford base32 string is fine, doesn't need to be cryptographically real), an ISO 8601 `ts`, and the full `resource`/`context` shape from the type.

## Done-check

```
for f in schema/examples/event/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f OK"; done
```
Expect: 5 files, each printed `OK` with no `JSON.parse` error. Manually confirm each file's `type` field matches its filename's variant (prompt/tool/session).
