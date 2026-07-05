# Canonical event

A canonical event is the normalized, redacted-before-append record an instrumentation emits
for one thing that happened in an agent session — a prompt, a tool call, or a session
lifecycle transition. Events are the event log's unit of storage: append-only, replayable,
never deleted. There are three variants today: `PromptEvent` (a user prompt), `ToolEvent`
(a tool invocation — read, write, edit, bash, search, commit, push), and `SessionEvent` (a
session-level transition — start, stop, compact, checkpoint). A fourth variant,
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
            reason?: "file_write" | "vcs_commit" | "cwd_change" | "user_pushback" | "manual" };
};

type PromptEvent = EventBase & { type: "prompt"; prompt: string };

type ToolEvent = EventBase & {
  type: "tool";
  tool: { native_name: string;
          canonical_name: "read" | "write" | "edit" | "bash" | "search" | "unknown";
          category: "file_read" | "file_write" | "command" | "search"
                  | "vcs_commit" | "vcs_push" | "other" };
  command?: string;                                  // redacted before append
  files?: Array<{ path: string; action: "read" | "write" | "edit" | "delete" }>;
};

type SessionEvent = EventBase & { type: "session"; action: "start" | "stop" | "compact" | "checkpoint" };
```

## Rules

Redaction before append; `resource` stores facts, not authoritative identity; `project_slug`
not on events; hints non-authoritative; partial lines ignored/quarantined; cursors advance
after success; validators hard-reject `record_class: diagnostic`. **Provenance is
collector-stamped, never LLM-authored:** the renderer presents events with ordinal indexes;
the LLM cites indexes; the collector maps indexes → ULIDs. Mechanical fields belong to code.

## Golden examples

1. [`01-prompt-in-git-repo.json`](schema/examples/event/01-prompt-in-git-repo.json) — a prompt sent from inside a git repo, with a full `resource` (`git_root`/`git_remote`/`git_branch`) and `context`.
2. [`02-file-edit-write.json`](schema/examples/event/02-file-edit-write.json) — a file write tool call (`tool.category: "file_write"`).
3. [`03-git-commit-vcs-commit.json`](schema/examples/event/03-git-commit-vcs-commit.json) — a `git commit` run via bash, categorized `vcs_commit`, hinted salient.
4. [`04-redacted-command-with-token.json`](schema/examples/event/04-redacted-command-with-token.json) — a command whose token has already been redacted before append.
5. [`05-session-checkpoint.json`](schema/examples/event/05-session-checkpoint.json) — a session checkpoint event.
