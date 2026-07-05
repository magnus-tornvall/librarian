# 013 — src/redact.ts

**Phase:** 3 — Walking skeleton
**Dependencies:** 004 (its test reproduces golden example `04-redacted-command-with-token.json`).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §5 ("Redaction preserves correlation without the secret: `[REDACTED:token:sha256:abc123]`. Applies to prompts as well as commands.")
**Do not relitigate:** the redaction placeholder format is fixed — `[REDACTED:token:sha256:<hash>]` — don't invent a different tag scheme. This module must be called **before** any event reaches `appendRecord` (011) once task 015 wires the collector; this task only builds the function, it doesn't wire the pipeline order yet.

## Context

Depends on 002 only (pure string function, no filesystem). §5 states redaction must happen "before durable append — non-retrofittable," which is why it's its own module rather than folded into the collector: it needs to be independently testable against exact secret-shaped strings, since getting this wrong means secrets become immortal in an append-only log.

## Task

Create `src/redact.ts` exporting:
```ts
export function redact(text: string): string
```
Detect and replace secret-shaped substrings with `[REDACTED:token:sha256:<hex>]` where `<hex>` is `crypto.createHash('sha256').update(matchedSecret).digest('hex').slice(0, 8)` (short hash preserves correlation — same secret redacts to the same tag twice — without keeping the secret recoverable).

Cover at minimum these patterns (keep the regex list short and explicit, not a giant pattern library — this is v1, not a secrets-scanning product):
- `AWS`-style: `AKIA[0-9A-Z]{16}`
- Generic bearer/API token: `(?:token|api[_-]?key|secret)[=: ]["']?[A-Za-z0-9_\-\.]{16,}`
- GitHub PAT shape: `ghp_[A-Za-z0-9]{36}`

Create `tests/redact.test.ts`: each pattern above gets redacted correctly; plain text with no secret-shaped substring passes through unchanged; the same input secret redacts to the same tag on two separate calls (correlation-preserving); a redacted command from `schema/examples/event/04-redacted-command-with-token.json` (task 004) is reproducible by running `redact()` on a plausible pre-redaction version of that command.

## Done-check

```
npm test
```
Expect: `tests/redact.test.ts` passes, including the correlation-preserving check (two calls, same tag).
