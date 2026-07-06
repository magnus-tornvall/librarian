/**
 * OpenCode instrumentation adapter — pure mapping module (roadmap item 6, spec §4).
 *
 * Native OpenCode event payload → canonical event(s) (schema/event.md, spec §10.1).
 *
 * PURITY CONTRACT (verified by inspection per the Definition of Done): this module
 * imports NOTHING that touches I/O — no `node:fs`, no `node:child_process`, no
 * `node:crypto`, no clock, no process spawning. Everything the mapper cannot derive
 * from the native payload alone (the machine-specific `resource` facts, the ULID
 * `event_id`, the `ts` timestamp) is INJECTED by the caller (the plugin shell, which
 * owns the I/O). That is what makes the mapping testable without an OpenCode runtime:
 * a fixture injects fixed stamps and resource facts, and the output is deterministic.
 *
 * Per §4 the instrumentation is dumb: it maps native events → canonical schema, stamps
 * Resource facts, emits cheap non-authoritative salience hints, and hands off. Zero
 * domain logic — no salience authority, no project-slug derivation, no redaction, no
 * filtering beyond mapping. The collector and distiller own judgment.
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
// Native OpenCode payload shape (the adapter's view of what the plugin observes).
//
// The plugin shell normalizes OpenCode's native hook arguments into these terse
// payloads before calling `map()`. The exact OpenCode hook names are NOT the
// contract (they drift across versions); this payload shape and the mapping table
// below ARE. See plugin.ts for how live hooks are lowered onto these.
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

export interface PromptPayload {
  kind: 'prompt';
  /** Raw user prompt text — shipped raw; redaction is the collector's job (§5). */
  text: string;
}

export interface ToolPayload {
  kind: 'tool';
  /** OpenCode's tool name, e.g. "read", "write", "edit", "bash", "grep", "glob". */
  tool: string;
  /** The bash command line, when the tool is a shell tool. Shipped raw (§5). */
  command?: string;
  /** File paths the tool touched, when it is a file tool. */
  files?: Array<{ path: string; action?: FileAction }>;
}

export interface SessionPayload {
  kind: 'session';
  action: SessionAction;
}

export type NativePayload = PromptPayload | ToolPayload | SessionPayload;

// ---------------------------------------------------------------------------
// Tool classification (§10.1). Native OpenCode tool name → canonical_name/category.
// ---------------------------------------------------------------------------

/**
 * OpenCode's built-in tool names, lowercased, mapped to the canonical vocabulary.
 * A name we do not recognize falls through to `unknown`/`other` — dumb by design:
 * the collector and distiller, not the adapter, decide what an unknown tool means.
 */
const TOOL_TABLE: Record<string, { canonical_name: CanonicalName; category: ToolCategory }> = {
  read: { canonical_name: 'read', category: 'file_read' },
  write: { canonical_name: 'write', category: 'file_write' },
  edit: { canonical_name: 'edit', category: 'file_write' },
  patch: { canonical_name: 'edit', category: 'file_write' },
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

function mapPrompt(payload: PromptPayload, env: MapEnv): PromptEvent {
  // Prompt text is shipped RAW — redaction is the collector's, at the append
  // boundary (§5). The adapter must not pre-redact.
  return { ...base(env), type: 'prompt', prompt: payload.text };
}

function mapTool(payload: ToolPayload, env: MapEnv): ToolEvent {
  const { canonical_name, category } = classifyTool(payload.tool, payload.command);

  const event: ToolEvent = {
    ...base(env),
    type: 'tool',
    tool: { native_name: payload.tool, canonical_name, category },
  };

  if (payload.command !== undefined) {
    // Raw command line — the collector redacts secrets at append (§5).
    event.command = payload.command;
  }

  if (payload.files && payload.files.length > 0) {
    // Default a file tool's action from its category when the payload omits it, so
    // a `read`/`write`/`edit` tool yields the matching per-file action.
    const defaultAction: FileAction =
      category === 'file_read' ? 'read' : canonical_name === 'edit' ? 'edit' : 'write';
    event.files = payload.files.map((f) => ({ path: f.path, action: f.action ?? defaultAction }));
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

function mapSession(payload: SessionPayload, env: MapEnv): SessionEvent {
  return { ...base(env), type: 'session', action: payload.action };
}

/**
 * Map one native OpenCode payload to its canonical event, stamping the injected
 * `event_id`/`ts`/`resource`/`context`. Returns an array so a single native event
 * could fan out to several canonical events in the future; today it is always
 * exactly one. This is the pure function the origin-qualification fixtures test.
 */
export function map(payload: NativePayload, env: MapEnv): CanonicalEvent[] {
  switch (payload.kind) {
    case 'prompt':
      return [mapPrompt(payload, env)];
    case 'tool':
      return [mapTool(payload, env)];
    case 'session':
      return [mapSession(payload, env)];
    default: {
      // Exhaustiveness guard: an unmapped native kind is a programming error, not a
      // runtime input we silently drop.
      const _exhaustive: never = payload;
      throw new Error(`unmapped native OpenCode payload kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
