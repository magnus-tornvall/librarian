# Canonical event

A canonical event is the normalized, redacted-before-append record an instrumentation emits
for one thing that happened in an agent session — a prompt, a tool call, or a session
lifecycle transition. Events are the event log's unit of storage: append-only, replayable,
never deleted. There are three variants today: `PromptEvent` (a user prompt), `ToolEvent`
(a tool invocation — read, write, edit, bash, search, commit, push), and `SessionEvent` (a
session-level transition — start, stop, compact, checkpoint, end). A fourth variant,
`ContentEvent`, is reserved for non-agent sources (email, documents, …) but deferred until a
concrete non-agent source exists.

## Types

```ts
type CanonicalEvent = PromptEvent | ToolEvent | SessionEvent;
// ContentEvent reserved for non-agent sources — rule settled, shape deferred (§5)

type EventBase = {
  schema_version: 1;
  event_id: string;          // ULID, generated before append, never changes
  ts: string;                // ISO 8601
  resource: {
    agent: string; agent_version?: string;
    machine_id: string;      // generated ID persisted at ~/.librarian/machine-id (NOT hostname)
    cwd: string; git_root?: string; git_remote?: string; git_branch?: string;
  };
  context: { session_id: string; turn?: number; cwd: string };
  hints?: { possibly_salient?: boolean;
            reason?: "file_write" | "vcs_commit" | "command_failed" | "cwd_change"
                   | "user_pushback" | "manual" };
  boundary?: { kind: "terminal" | "semantic" | "compaction";       // an arc closed here
               signal: "session_end" | "compact" | "git_commit" | "todos_complete" };
};

type PromptEvent = EventBase & { type: "prompt"; prompt: string };

type ToolEvent = EventBase & {
  type: "tool";
  tool: { native_name: string;
          canonical_name: "read" | "write" | "edit" | "bash" | "search" | "unknown";
          category: "file_read" | "file_write" | "command" | "search"
                  | "vcs_commit" | "vcs_push" | "other" };
  command?: string;                                  // redacted before append
  outcome?: { stdout?: string; stderr?: string; exit?: number; interrupted?: boolean };
                                                     // shell/VCS categories only; empty streams
                                                     // elided (exit kept even at 0); redacted
                                                     // and 64 KB head+tail capped before append
  files?: Array<{ path: string; action: "read" | "write" | "edit" | "delete" }>;
};

type SessionEvent = EventBase & { type: "session";
                                  action: "start" | "stop" | "compact" | "checkpoint" | "end" };
```

## Boundary markers

`boundary` marks the events where an arc actually **closed**, so a distill trigger has
something better than a clock to act on. It is present only on those events, carries the same
vocabulary for every agent (a consumer switches on one field; `resource.agent` still says which
agent it was), and the adapter never decides what to do with it — firing is the trigger's call
(§4: dumb instrumentation).

| `kind` | `signal` | Emitted on | Strength |
| ------ | -------- | ---------- | -------- |
| `terminal` | `session_end` | Claude Code `SessionEnd`, OpenCode `session.deleted` | The session is over; nothing more is coming. |
| `semantic` | `git_commit` | a `vcs_commit` tool call that did **not** fail | An arc closed; the session may continue. |
| `semantic` | `todos_complete` | a todo-write tool call leaving **every** todo `completed` | Same. |
| `compaction` | `compact` | Claude Code `PreCompact`, OpenCode `experimental.session.compacting` | Recorded landmark only — **never** a completion signal. |

`compaction` is recorded but must **not** fire a distill: compaction means "the context window
filled up", not "the work is finished", so acting on it would distill an unfinished arc. Tools
that read the transcript treat `PreCompact` as a data-preservation deadline; librarian writes its
own durable event log through the hooks, so compaction destroys nothing it needs.

A per-turn signal is not a boundary: Claude Code's `Stop` and OpenCode's `session.idle` fire once
per assistant turn, so treating either as an end-of-arc marker would distill mid-session on every
turn. And a hard-killed terminal fires no `SessionEnd` at all — boundaries are an optimisation on
top of the trigger's timeout and scheduled net, never the guarantee.

## Rules

Redaction before append: `<private>...</private>` spans in prompt and command fields become
`[PRIVATE]` without a hash; injected `<librarian-memory>...</librarian-memory>` blocks are
removed; and `outcome.stdout`/`outcome.stderr` are pattern-redacted like any other captured
text (machine-generated output carries no `<private>` markup, so the patterns are its only
guard, and an unclosed `<private>` in machine output does NOT fail closed — nothing was
declared, so nothing is destroyed). `outcome` is captured for `command` / `vcs_commit` /
`vcs_push` only: their output is a function of machine state at that instant and is gone,
whereas a `file_read`'s result is a copy of a file on disk and a `search`'s is re-runnable.
Streams are stored as the harness handed them over — itself already bounded, Claude Code
hard-truncates at 30,000 characters — up to a further 64 KB head+tail cap per stream that
names what it elided; the *render* truncates far harder (§7). **What earns
`hints.reason: "command_failed"` is adapter-dependent, because the payloads differ**, and
hints are non-authoritative precisely so this is allowed: OpenCode lifts a real exit code
(`output.metadata.exit`, present on 3639 of 3673 real bash calls) and fires on non-zero;
Claude Code has no exit code, never sets `is_error`, and its non-empty `stderr` is a harness
notice rather than a failure (266 of 266 measured), so it can only honour `interrupted`.
`exit` is recorded whatever its value — a zero is the "the remedy worked" half of the chain. `resource` stores facts, not authoritative identity; `project_slug` not on events;
hints non-authoritative; partial lines ignored/quarantined; cursors advance after success;
validators hard-reject `record_class: diagnostic`. **Provenance is
collector-stamped, never LLM-authored:** the renderer presents events with ordinal indexes;
the LLM cites indexes; the collector maps indexes → ULIDs. Mechanical fields belong to code.

## Golden examples

1. [`01-prompt-in-git-repo.json`](schema/examples/event/01-prompt-in-git-repo.json) — a prompt sent from inside a git repo, with a full `resource` (`git_root`/`git_remote`/`git_branch`) and `context`.
2. [`02-file-edit-write.json`](schema/examples/event/02-file-edit-write.json) — a file write tool call (`tool.category: "file_write"`).
3. [`03-git-commit-vcs-commit.json`](schema/examples/event/03-git-commit-vcs-commit.json) — a `git commit` run via bash, categorized `vcs_commit`, hinted salient.
4. [`04-redacted-command-with-token.json`](schema/examples/event/04-redacted-command-with-token.json) — a command whose token has already been redacted before append.
5. [`05-session-checkpoint.json`](schema/examples/event/05-session-checkpoint.json) — a session checkpoint event.
