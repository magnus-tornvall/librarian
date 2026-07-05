# 010 — fixtures/events/session-001.ndjson

**Phase:** 3 — Walking skeleton
**Dependencies:** 003 (event types to shape against). Soft: 004 (golden examples as reference only).
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §10.1 (event shape), §12 roadmap item 4
**Do not relitigate:** this fixture must be shaped exactly like `schema/event.md`'s types (task 003) — it is not a new example, it's the input data the rest of Phase 3 processes end-to-end. Don't invent new event types or fields.

## Context

First Phase 3 task; depends on 003 (event types must exist to shape this against) and 009 (scaffold/paths convention, though this task doesn't import `paths.ts` directly). This is the "ugly internals, real data" input the walking skeleton (§12 item 4) runs on — a small, human-plausible session: someone asks for a bug fix, an edit happens, a commit happens.

## Task

Create `fixtures/events/session-001.ndjson` — one JSON object per line (NDJSON, no wrapping array), 4 events sharing one `context.session_id`:
1. `PromptEvent`: `"fix the login redirect bug, it loops on expired tokens"` (matches the renderer example in §7 — reuse that flavor deliberately so task 016's test has an obvious expected output to assert against).
2. `ToolEvent`: `file_write` on `src/auth/session.ts`.
3. `ToolEvent`: `vcs_commit` via bash, `command: "git commit -m \"fix: expire check before redirect\""`, `hints: { possibly_salient: true, reason: "vcs_commit" }`.
4. `SessionEvent`: `action: "stop"`.

Events must be in chronological order (ascending `ts`), each with a distinct ULID-shaped `event_id`, and identical `resource.machine_id` / `context.session_id` across all 4 lines (same session).

## Done-check

```
node -e "
const fs = require('fs');
const lines = fs.readFileSync('fixtures/events/session-001.ndjson', 'utf8').trim().split('\n');
if (lines.length !== 4) throw new Error('expected 4 lines, got ' + lines.length);
const events = lines.map(l => JSON.parse(l));
const sids = new Set(events.map(e => e.context.session_id));
if (sids.size !== 1) throw new Error('events must share one session_id');
console.log('OK: 4 events, 1 session');
"
```
Expect: prints `OK: 4 events, 1 session`.
