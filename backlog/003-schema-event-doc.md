# 003 — schema/event.md (prose + types)

**Phase:** 1 — Schemas
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §10.1 (canonical event types + rules + golden-example list)
**Do not relitigate:** §10.1's types are already fully drafted in the spec — copy them, don't redesign them. §14 "Golden examples: extracted" means this file **references** golden JSON files under `schema/examples/event/` (task 004) rather than embedding example JSON inline. §5 "Resource & salience" and "Durability & safety" sections are the source for the prose around `resource`/`hints`/redaction — don't invent new rules.

## Context

This is roadmap item 1 (§12): the first concrete schema artifact. Depends on 002 (scaffold must exist so the repo has somewhere for `schema/` to live as a real, committed thing — though this task is pure Markdown, no code).

## Task

Create `schema/event.md` containing:
1. A short prose intro: what a canonical event is, why three variants (`PromptEvent`/`ToolEvent`/`SessionEvent`), and the one-line note that `ContentEvent` is reserved but deferred (§5, §12 item 11).
2. The full TypeScript type block from spec §10.1 (`CanonicalEvent`, `EventBase`, `PromptEvent`, `ToolEvent`, `SessionEvent`), copied verbatim.
3. The rules paragraph from §10.1 ("redaction before append; `resource` stores facts...").
4. A golden-examples section listing the 5 examples from §10.1 by name and one-line description, each linking to its file under `schema/examples/event/` (files created in task 004 — it's fine for these links to point at files that don't exist yet at the moment this task is done; task 004 fills them in next):
   - `01-prompt-in-git-repo.json`
   - `02-file-edit-write.json`
   - `03-git-commit-vcs-commit.json`
   - `04-redacted-command-with-token.json`
   - `05-session-checkpoint.json`

## Done-check

```
test -f schema/event.md && grep -c '```ts' schema/event.md && grep -c 'schema/examples/event/' schema/event.md
```
Expect: file exists, at least one fenced `ts` block, and 5 references to files under `schema/examples/event/`.
