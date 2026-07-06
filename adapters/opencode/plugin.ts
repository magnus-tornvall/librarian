/**
 * OpenCode instrumentation adapter — the thin plugin shell (roadmap item 6, spec §4).
 *
 * This is the ONLY part of the adapter that does I/O. It subscribes to OpenCode's
 * native hooks, lowers each native payload onto the mapper's `NativePayload` shape,
 * resolves the machine-specific `resource` facts (machine id, git root/remote/branch)
 * and the per-event stamps (`event_id` ULID, `ts`), calls the pure `map()`, and pipes
 * the resulting canonical event as NDJSON into `librarian collect`.
 *
 * Everything with judgment in it lives elsewhere: mapping is `map.ts` (pure, fixture-
 * tested); redaction, validation, and salience authority are the collector's and
 * distiller's (§4, §5). The plugin is dumb plumbing — it maps native → canonical,
 * stamps facts, emits cheap hints (via the mapper), and hands off. Nothing more.
 *
 * OpenCode plugin API: https://opencode.ai/docs/plugins — a plugin is an async
 * function returning a hooks object. The relevant hooks here are `event` (session
 * lifecycle + user messages) and `tool.execute.after` (tool invocations). The hook
 * NAMES are not the contract (they drift across OpenCode versions); the mapping in
 * `map.ts` is. When a hook name changes, only the lowering below changes.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import {
  map,
  type CanonicalEvent,
  type Context,
  type FileAction,
  type NativePayload,
  type Resource,
} from './map.ts';

// ---------------------------------------------------------------------------
// Resource-fact resolution (I/O — deliberately kept out of the pure mapper).
// ---------------------------------------------------------------------------

/** Run a command and return trimmed stdout, or undefined on any failure. Facts are
 *  best-effort: a missing git remote or an un-init'd repo yields `undefined`, never a
 *  throw — the adapter must not break the agent's session over a missing fact. */
function tryRun(command: string, args: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return undefined;
    }
    const out = result.stdout.trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the machine id the way the spec mandates (§10.1, §11): a generated,
 * persisted id — never the hostname. Prefer `MACHINE_ID_PATH` when it is set and the
 * file exists (the collector's own path constant); otherwise ask the CLI
 * (`librarian machine-id`), which generates-and-persists on first call. If both fail
 * (librarian not on PATH — a misconfiguration the README calls out), fall back to a
 * random UUID so an event still carries a non-empty machine_id and the pipeline does
 * not wedge; a warning is logged so the operator can fix PATH.
 */
function resolveMachineId(): string {
  const fromEnv = process.env.MACHINE_ID_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    const id = fs.readFileSync(fromEnv, 'utf8').trim();
    if (id.length > 0) {
      return id;
    }
  }

  const fromCli = tryRun('librarian', ['machine-id'], process.cwd());
  if (fromCli) {
    return fromCli;
  }

  process.stderr.write(
    'librarian-opencode: could not resolve machine id (is `librarian` on PATH?); ' +
      'falling back to an ephemeral id for this run\n',
  );
  return randomUUID();
}

/** Resolve the git facts for a directory, all best-effort (§10.1: facts, not identity). */
function resolveGitFacts(cwd: string): Pick<Resource, 'git_root' | 'git_remote' | 'git_branch'> {
  const git_root = tryRun('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!git_root) {
    return {}; // not a git repo — omit all three, don't guess
  }
  return {
    git_root,
    git_remote: tryRun('git', ['remote', 'get-url', 'origin'], cwd),
    git_branch: tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
  };
}

/**
 * Build the `resource` block once per session. `machine_id` and git facts are stable
 * for the life of a session, so we resolve them at plugin init and reuse them —
 * spawning `git`/`librarian` per event would be wasteful.
 *
 * ponytail: `agent_version` is left unset here — OpenCode does not surface its own
 * version to a plugin through the documented context. When a version becomes
 * available on the plugin context, stamp it; the schema already carries the optional
 * field. Facts we cannot resolve are omitted, never faked.
 */
function buildResource(cwd: string): Resource {
  return {
    agent: 'opencode',
    machine_id: resolveMachineId(),
    cwd,
    ...resolveGitFacts(cwd),
  };
}

// ---------------------------------------------------------------------------
// Delivery seam: pipe one canonical event to `librarian collect` as NDJSON.
// ---------------------------------------------------------------------------

/**
 * Hand a mapped event off to the collector.
 *
 * ponytail (v1 ceiling): this spawns `librarian collect` once per event. That is fine
 * for v1 — correctness over throughput, and it keeps the plugin stateless with no
 * long-lived child to supervise. The ceiling is obvious: a chatty session pays a
 * process spawn per event. When that bites, the fix is a single long-lived `collect`
 * child (or a batching buffer flushed on idle), not more logic here. `librarian` must
 * be on PATH (see README). A collector rejection (fail-loud, §9) is surfaced to the
 * OpenCode log but never rethrown — instrumentation must not break the session.
 */
function handOff(event: CanonicalEvent, log: (level: string, message: string) => void): void {
  const line = JSON.stringify(event) + '\n';
  const result = spawnSync('librarian', ['collect'], { input: line, encoding: 'utf8' });
  if (result.error) {
    log('error', `librarian collect failed to spawn: ${result.error.message} (is librarian on PATH?)`);
    return;
  }
  if (result.status !== 0) {
    log('error', `librarian collect rejected an event (exit ${result.status}): ${result.stderr?.trim() ?? ''}`);
  }
}

// ---------------------------------------------------------------------------
// Lowering: OpenCode native hook args → the mapper's terse NativePayload.
//
// These are intentionally forgiving readers over loosely-typed hook arguments — the
// plugin API surface is JS objects, not a versioned type we can import here. Anything
// we cannot understand is skipped (returns undefined) rather than mis-mapped.
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function asRecord(v: unknown): Loose | undefined {
  return typeof v === 'object' && v !== null ? (v as Loose) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Map an OpenCode `event` payload (session lifecycle + user messages) → NativePayload. */
function lowerEvent(evt: Loose): NativePayload | undefined {
  const type = asString(evt.type);
  if (!type) {
    return undefined;
  }

  // Session lifecycle. OpenCode fires session.created / session.compacted /
  // session.deleted; map them onto start / compact / stop respectively.
  if (type === 'session.created') {
    return { kind: 'session', action: 'start' };
  }
  if (type === 'session.compacted') {
    return { kind: 'session', action: 'compact' };
  }
  if (type === 'session.deleted' || type === 'session.idle') {
    return { kind: 'session', action: 'stop' };
  }

  // A user message becoming available is the prompt signal. The exact envelope has
  // shifted across versions (message.updated with a nested part, or a dedicated
  // message part event); read defensively for the user's text.
  if (type === 'message.updated' || type === 'message.part.updated') {
    const props = asRecord(evt.properties) ?? evt;
    const info = asRecord(props.info) ?? asRecord(props.message) ?? props;
    const role = asString(info.role);
    const text = extractMessageText(props);
    if (role === 'user' && text) {
      return { kind: 'prompt', text };
    }
  }

  return undefined;
}

/** Pull the user-visible text out of a message-ish payload, tolerating shapes. */
function extractMessageText(props: Loose): string | undefined {
  const direct = asString(props.text);
  if (direct) {
    return direct;
  }
  const part = asRecord(props.part);
  if (part) {
    const partText = asString(part.text);
    if (part.type === 'text' && partText) {
      return partText;
    }
  }
  const parts = props.parts;
  if (Array.isArray(parts)) {
    const texts = parts
      .map((p) => {
        const rec = asRecord(p);
        return rec && rec.type === 'text' ? asString(rec.text) : undefined;
      })
      .filter((t): t is string => t !== undefined);
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }
  return undefined;
}

/** Map an OpenCode `tool.execute.after` payload → NativePayload. */
function lowerTool(input: Loose, output: Loose): NativePayload | undefined {
  const tool = asString(input.tool);
  if (!tool) {
    return undefined;
  }

  const args = asRecord(output.args) ?? asRecord(input.args) ?? {};
  const command = asString(args.command);
  const files = extractFiles(tool, args);

  const payload: NativePayload = { kind: 'tool', tool };
  if (command) {
    payload.command = command; // raw — collector redacts (§5)
  }
  if (files) {
    payload.files = files;
  }
  return payload;
}

/** Derive the touched files from a tool's args (file tools carry a filePath/path). */
function extractFiles(tool: string, args: Loose): Array<{ path: string; action?: FileAction }> | undefined {
  const filePath = asString(args.filePath) ?? asString(args.path);
  if (!filePath) {
    return undefined;
  }
  const lower = tool.toLowerCase();
  const action: FileAction | undefined =
    lower === 'read' ? 'read' : lower === 'write' ? 'write' : lower === 'edit' || lower === 'patch' ? 'edit' : undefined;
  return [{ path: filePath, action }];
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

/** Minimal structural view of what OpenCode passes a plugin (see plugin docs). We do
 *  not depend on `@opencode-ai/plugin` types so this repo stays free of that dep; the
 *  shapes below are the documented context and hook signatures. */
interface PluginContext {
  directory?: string;
  worktree?: string;
  client?: { app?: { log?: (opts: { body: Loose }) => unknown } };
}

/**
 * The OpenCode plugin entry point. Installed as `~/.config/opencode/plugins/` (global)
 * or `.opencode/plugins/` (per-project) — see README. Resolves the session `resource`
 * once, then on each hook: lower native → NativePayload, `map()` → canonical event
 * (stamping a fresh ULID + ISO ts), and `handOff()` to `librarian collect`.
 */
export const LibrarianOpenCodePlugin = async (ctx: PluginContext) => {
  const cwd = ctx.worktree ?? ctx.directory ?? process.cwd();
  const resource = buildResource(cwd);
  const sessionCwd = cwd;

  const log = (level: string, message: string): void => {
    // Prefer structured logging through the SDK; fall back to stderr.
    const sink = ctx.client?.app?.log;
    if (sink) {
      void sink({ body: { service: 'librarian-opencode', level, message } });
    } else {
      process.stderr.write(`librarian-opencode [${level}]: ${message}\n`);
    }
  };

  /** Turn a lowered payload into a stamped canonical event and hand it off. */
  const emit = (payload: NativePayload, context: Context): void => {
    const events = map(payload, {
      event_id: ulid(), // ULID stamped before handoff (§10.1)
      ts: new Date().toISOString(), // ISO 8601 stamp (§10.1)
      resource,
      context,
    });
    for (const event of events) {
      handOff(event, log);
    }
  };

  /** Best-effort session id + turn from a loose hook payload; cwd is the session cwd. */
  const contextFrom = (source: Loose): Context => {
    const props = asRecord(source.properties) ?? source;
    const info = asRecord(props.info) ?? asRecord(props.sessionInfo) ?? props;
    const session_id =
      asString(props.sessionID) ??
      asString(info.sessionID) ??
      asString(info.sessionId) ??
      asString(info.id) ??
      'unknown';
    const turnRaw = props.turn ?? info.turn;
    const context: Context = { session_id, cwd: sessionCwd };
    if (typeof turnRaw === 'number') {
      context.turn = turnRaw;
    }
    return context;
  };

  return {
    event: async ({ event }: { event: Loose }) => {
      const payload = lowerEvent(event);
      if (payload) {
        emit(payload, contextFrom(event));
      }
    },
    'tool.execute.after': async (input: Loose, output: Loose) => {
      const payload = lowerTool(input, output);
      if (payload) {
        emit(payload, contextFrom(input));
      }
    },
  };
};

export default LibrarianOpenCodePlugin;
