/**
 * Claude Code instrumentation adapter — pure mapping module (roadmap item 6, spec §4;
 * §12: "OpenCode first … Claude Code second").
 *
 * Native Claude Code hook payload → canonical event(s) (schema/event.md, spec §10.1).
 *
 * PURITY CONTRACT (verified by inspection per the Definition of Done): this module
 * imports NOTHING that touches I/O — no `node:fs`, no `node:child_process`, no
 * `node:crypto`, no clock, no process spawning. Everything the mapper cannot derive
 * from the native payload alone (the machine-specific `resource` facts, the ULID
 * `event_id`, the `ts` timestamp) is INJECTED by the caller (the hook shell, which owns
 * the I/O). That is what makes the mapping testable without a Claude Code runtime: a
 * fixture injects fixed stamps and resource facts, and the output is deterministic.
 *
 * Per §4 the instrumentation is dumb: it maps native events → canonical schema, stamps
 * Resource facts, emits cheap non-authoritative salience hints, and hands off. Zero
 * domain logic — no salience authority, no project-slug derivation, no redaction, no
 * filtering beyond mapping. The collector and distiller own judgment.
 *
 * This mirrors the merged OpenCode adapter's conventions (adapters/opencode/map.ts):
 * a pure `map()` tested by golden fixtures, injected env, dumb classification table. It
 * deviates only where Claude Code's hook model forces it — chiefly the shape of the
 * NATIVE payload, which here is Claude Code's real hook JSON (`hook_event_name`,
 * `tool_name`, `tool_input`, …) rather than OpenCode's SDK-normalized terse payload.
 */

// ---------------------------------------------------------------------------
// Canonical event shape (mirrors schema/event.md — kept structural, not imported,
// so the pure mapper carries no dependency on the collector's runtime modules).
// ---------------------------------------------------------------------------

export type CanonicalName = 'read' | 'write' | 'edit' | 'bash' | 'search' | 'unknown';

export type ToolCategory =
  | 'file_read'
  | 'file_write'
  | 'command'
  | 'search'
  | 'vcs_commit'
  | 'vcs_push'
  | 'other';

export type FileAction = 'read' | 'write' | 'edit' | 'delete';

export type SessionAction = 'start' | 'stop' | 'compact' | 'checkpoint';

export type HintReason =
  | 'file_write'
  | 'vcs_commit'
  | 'cwd_change'
  | 'user_pushback'
  | 'manual';

export interface Resource {
  agent: string;
  agent_version?: string;
  machine_id: string;
  cwd: string;
  git_root?: string;
  git_remote?: string;
  git_branch?: string;
}

export interface Context {
  session_id: string;
  turn?: number;
  cwd: string;
}

export interface Hints {
  possibly_salient?: boolean;
  reason?: HintReason;
}

interface EventBase {
  schema_version: 1;
  event_id: string;
  ts: string;
  resource: Resource;
  context: Context;
  hints?: Hints;
}

export type PromptEvent = EventBase & { type: 'prompt'; prompt: string };

export type ToolEvent = EventBase & {
  type: 'tool';
  tool: { native_name: string; canonical_name: CanonicalName; category: ToolCategory };
  command?: string;
  files?: Array<{ path: string; action: FileAction }>;
};

export type SessionEvent = EventBase & { type: 'session'; action: SessionAction };

export type CanonicalEvent = PromptEvent | ToolEvent | SessionEvent;

// ---------------------------------------------------------------------------
// Native Claude Code hook payload shape (the adapter's view of what a hook receives).
//
// Claude Code hooks receive a JSON object on stdin. Every event carries the common
// fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, and usually
// `permission_mode`); each event adds its own fields. These shapes are RECORDED from
// the current Claude Code hooks reference (docs.claude.com/en/docs/claude-code/hooks)
// and pinned into the golden fixtures. The four events this adapter maps:
//
//   - UserPromptSubmit — `{ …common, prompt }`                        → PromptEvent
//   - PostToolUse      — `{ …common, tool_name, tool_input, … }`      → ToolEvent
//   - SessionStart     — `{ …common, source, model? }`               → SessionEvent(start)
//   - Stop             — `{ …common, stop_hook_active, … }`          → SessionEvent(stop)
//
// The `hook_event_name` string IS the discriminator here (unlike OpenCode, whose hook
// names were deliberately NOT the contract). Claude Code's hook payload is the public,
// documented interface, so keying off `hook_event_name` is the natural, stable choice.
// A payload we do not recognize is not mapped (map() returns []).
// ---------------------------------------------------------------------------

/** Facts + stamps the caller resolves via I/O and injects into the pure mapper. */
export interface MapEnv {
  /** ULID stamped before handoff (§10.1). Caller supplies; mapper never generates. */
  event_id: string;
  /** ISO 8601 timestamp stamped before handoff (§10.1). Caller supplies. */
  ts: string;
  resource: Resource;
  context: Context;
}

/** Fields present on every Claude Code hook payload (the "common input fields"). */
export interface CommonHookFields {
  /** Claude Code's session identifier — the routing key (→ context.session_id). */
  session_id: string;
  /** Path to the conversation transcript JSONL. Recorded, not currently mapped. */
  transcript_path?: string;
  /** Working directory when the hook fired. */
  cwd?: string;
  /** Current permission mode (default/plan/acceptEdits/…). Not all events carry it. */
  permission_mode?: string;
  /** The event that fired — the discriminator this adapter maps on. */
  hook_event_name: string;
}

/** UserPromptSubmit → PromptEvent. Carries the raw user prompt. */
export interface UserPromptSubmitPayload extends CommonHookFields {
  hook_event_name: 'UserPromptSubmit';
  /** Raw user prompt text — shipped raw; redaction is the collector's job (§5). */
  prompt: string;
}

/** The Bash tool's `tool_input` (the only per-tool shape whose command we lift). */
export interface BashToolInput {
  command?: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

/** File-tool `tool_input` shapes all carry `file_path` (Write/Edit/Read). */
export interface FileToolInput {
  file_path?: string;
  [key: string]: unknown;
}

/** PostToolUse → ToolEvent. `tool_name` + `tool_input` drive classification. */
export interface PostToolUsePayload extends CommonHookFields {
  hook_event_name: 'PostToolUse';
  /** Claude Code's tool name, e.g. "Bash", "Write", "Edit", "Read", "Grep", "Glob". */
  tool_name: string;
  /** The tool's arguments; per-tool shape (Bash→command, Write/Edit/Read→file_path…). */
  tool_input?: Record<string, unknown>;
  /** The tool's result. Recorded for completeness; the dumb adapter does not read it. */
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
}

/** SessionStart → SessionEvent(start). `source` says how the session started. */
export interface SessionStartPayload extends CommonHookFields {
  hook_event_name: 'SessionStart';
  /** startup | resume | clear | compact (recorded, not remapped — always → start). */
  source?: string;
  /** Active model identifier (may be absent, e.g. after /clear). */
  model?: string;
}

/** Stop → SessionEvent(stop). Fires once per turn when Claude finishes responding. */
export interface StopPayload extends CommonHookFields {
  hook_event_name: 'Stop';
  /** true when Claude Code is already continuing due to a prior Stop hook. */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export type NativePayload =
  | UserPromptSubmitPayload
  | PostToolUsePayload
  | SessionStartPayload
  | StopPayload;

// ---------------------------------------------------------------------------
// Tool classification (§10.1). Native Claude Code tool name → canonical_name/category.
// ---------------------------------------------------------------------------

/**
 * Claude Code's built-in tool names (as they appear in `tool_name`), mapped to the
 * canonical vocabulary. Claude Code capitalizes its tool names (Bash, Write, …), so the
 * table is keyed by the lowercased name to stay forgiving. A name we do not recognize
 * falls through to `unknown`/`other` — dumb by design: the collector and distiller, not
 * the adapter, decide what an unknown tool means.
 *
 * `MultiEdit` and `NotebookEdit` are Claude Code edit variants; both map to edit/file_write.
 */
const TOOL_TABLE: Record<string, { canonical_name: CanonicalName; category: ToolCategory }> = {
  read: { canonical_name: 'read', category: 'file_read' },
  write: { canonical_name: 'write', category: 'file_write' },
  edit: { canonical_name: 'edit', category: 'file_write' },
  multiedit: { canonical_name: 'edit', category: 'file_write' },
  notebookedit: { canonical_name: 'edit', category: 'file_write' },
  bash: { canonical_name: 'bash', category: 'command' },
  grep: { canonical_name: 'search', category: 'search' },
  glob: { canonical_name: 'search', category: 'search' },
};

/**
 * Recognize a `git commit` / `git push` invocation inside a bash command line so a
 * shell tool can be recategorized to `vcs_commit` / `vcs_push` (§10.1). Deliberately
 * conservative: matches `git` (optionally with a leading path or env assignments and
 * global `-c key=val` / `-C dir` flags) followed by the `commit`/`push` subcommand.
 * The subcommand must be a whole token — followed by whitespace, a shell terminator,
 * or end of string — so `git commit-tree` is NOT misread as a commit. A false
 * negative just leaves the event a plain `command`; the distiller still sees the raw
 * command line, and this is a cheap hint, not an authority (§5).
 *
 * Kept identical to the OpenCode adapter's regex — the git-subcommand shape does not
 * depend on which agent ran the bash tool, so the classification is shared verbatim.
 */
const GIT_SUBCOMMAND =
  /(?:^|[;&|]|&&|\|\|)\s*(?:\w+=\S+\s+)*(?:[^\s;|&]*\/)?git(?:\s+-[cC]\s+\S+)*\s+(commit|push)(?=\s|$|[;&|])/;

function gitSubcommand(command: string): 'commit' | 'push' | undefined {
  const match = GIT_SUBCOMMAND.exec(command);
  if (!match) {
    return undefined;
  }
  return match[1] as 'commit' | 'push';
}

function classifyTool(
  toolName: string,
  command: string | undefined,
): { canonical_name: CanonicalName; category: ToolCategory } {
  const base = TOOL_TABLE[toolName.toLowerCase()] ?? {
    canonical_name: 'unknown' as CanonicalName,
    category: 'other' as ToolCategory,
  };

  // A bash command that is a git commit/push is recategorized; the canonical_name
  // stays `bash` (it is still the bash tool) but the category sharpens to vcs_*.
  if (base.canonical_name === 'bash' && command !== undefined) {
    const sub = gitSubcommand(command);
    if (sub === 'commit') {
      return { canonical_name: 'bash', category: 'vcs_commit' };
    }
    if (sub === 'push') {
      return { canonical_name: 'bash', category: 'vcs_push' };
    }
  }

  return base;
}

/**
 * Lift the touched file path out of a tool's `tool_input`. Claude Code's file tools
 * (Read/Write/Edit/MultiEdit) name it `file_path`; NotebookEdit uses `notebook_path`.
 * Anything else yields no file. Dumb: we do not parse Bash for redirects, etc.
 */
function extractFilePath(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) {
    return undefined;
  }
  const filePath = toolInput.file_path ?? toolInput.notebook_path;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
}

/** Lift the shell command out of a Bash tool's `tool_input`. */
function extractCommand(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) {
    return undefined;
  }
  const command = toolInput.command;
  return typeof command === 'string' && command.length > 0 ? command : undefined;
}

// ---------------------------------------------------------------------------
// Mapping.
// ---------------------------------------------------------------------------

/** Assemble the fields every canonical event shares from the injected env. */
function base(env: MapEnv): EventBase {
  return {
    schema_version: 1,
    event_id: env.event_id,
    ts: env.ts,
    resource: env.resource,
    context: env.context,
  };
}

function mapPrompt(payload: UserPromptSubmitPayload, env: MapEnv): PromptEvent {
  // Prompt text is shipped RAW — redaction is the collector's, at the append
  // boundary (§5). The adapter must not pre-redact.
  return { ...base(env), type: 'prompt', prompt: payload.prompt };
}

function mapTool(payload: PostToolUsePayload, env: MapEnv): ToolEvent {
  const command = extractCommand(payload.tool_input);
  const { canonical_name, category } = classifyTool(payload.tool_name, command);

  const event: ToolEvent = {
    ...base(env),
    type: 'tool',
    // native_name preserves Claude Code's own capitalization (e.g. "Bash", "Write").
    tool: { native_name: payload.tool_name, canonical_name, category },
  };

  if (command !== undefined) {
    // Raw command line — the collector redacts secrets at append (§5).
    event.command = command;
  }

  const filePath = extractFilePath(payload.tool_input);
  if (filePath !== undefined) {
    // Derive the per-file action from the classification: a read tool reads, an edit
    // tool edits, any other file_write tool writes.
    const action: FileAction =
      category === 'file_read' ? 'read' : canonical_name === 'edit' ? 'edit' : 'write';
    event.files = [{ path: filePath, action }];
  }

  // Non-authoritative salience hint on file writes and commits (§5). Nothing more —
  // this is a cheap flag, not a salience engine (do-not-relitigate).
  if (category === 'file_write') {
    event.hints = { possibly_salient: true, reason: 'file_write' };
  } else if (category === 'vcs_commit') {
    event.hints = { possibly_salient: true, reason: 'vcs_commit' };
  }

  return event;
}

function mapSessionStart(_payload: SessionStartPayload, env: MapEnv): SessionEvent {
  // Every SessionStart (startup/resume/clear/compact source) maps to action "start":
  // the canonical SessionAction vocabulary has no per-source variants, and the adapter
  // does not editorialize (dumb mapping, §4). `source` is recorded on the native
  // payload for the collector/distiller, not remapped here.
  return { ...base(env), type: 'session', action: 'start' };
}

function mapStop(_payload: StopPayload, env: MapEnv): SessionEvent {
  return { ...base(env), type: 'session', action: 'stop' };
}

/**
 * Map one native Claude Code hook payload to its canonical event, stamping the injected
 * `event_id`/`ts`/`resource`/`context`. Returns an array so a single native event could
 * fan out to several canonical events in the future; today it is always exactly one for
 * a recognized event, and empty for an unrecognized `hook_event_name` (the hook shell
 * simply emits nothing — an unrecognized event must not crash the host session).
 *
 * This is the pure function the origin-qualification fixtures test.
 */
export function map(payload: NativePayload, env: MapEnv): CanonicalEvent[] {
  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      return [mapPrompt(payload, env)];
    case 'PostToolUse':
      return [mapTool(payload, env)];
    case 'SessionStart':
      return [mapSessionStart(payload, env)];
    case 'Stop':
      return [mapStop(payload, env)];
    default: {
      // Exhaustiveness guard for the four mapped events. An unrecognized event is NOT a
      // programming error the way an unmapped OpenCode kind was — Claude Code has many
      // hook events, and a user may wire one we do not map. We return no events rather
      // than throw, so a stray payload is a no-op, never a crash (hook-safety, §14).
      const _exhaustive: never = payload;
      void _exhaustive;
      return [];
    }
  }
}
