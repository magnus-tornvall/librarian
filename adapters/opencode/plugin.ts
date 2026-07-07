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
 * function returning a hooks object. Hook shapes below track the pinned SDK
 * (@opencode-ai/plugin + @opencode-ai/sdk). The hooks this adapter subscribes to:
 *
 *   - `chat.message`                    — a new user message → PromptEvent
 *   - `tool.execute.after`              — a tool invocation → ToolEvent
 *   - `experimental.session.compacting` — pre-compaction → SessionEvent(compact)
 *   - `event` (session.created/deleted) — session lifecycle → SessionEvent(start/stop)
 *
 * The hook NAMES are not the canonical contract (they drift across OpenCode versions);
 * the mapping in `map.ts` is. When a hook name or payload changes, only the lowering
 * below changes — the mapper and its fixtures are untouched.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import {
  map,
  type CanonicalEvent,
  type Context,
  type FileAction,
  type NativePayload,
  type Resource,
  type SessionPayload,
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

// ---------------------------------------------------------------------------
// CLI resolution: find the `librarian` executable without trusting $PATH.
//
// OpenCode is a native (Bun) binary; the PATH its plugin child inherits depends on
// how OpenCode was launched (terminal, desktop app, login service, package manager)
// and need not contain the dir a bare `librarian` was linked into. nvm/asdf/Homebrew/
// npm-global-bins/GUI launches all make bare-name lookup unreliable, and a shell rc
// (.zshrc) is not guaranteed to have run. So bare-name PATH lookup is a *convenience
// fallback*, never the contract. Resolution order (first hit wins):
//
//   1. LIBRARIAN_BIN env var — explicit override (dev, smoke tests).
//   2. ~/.librarian/config.json `{ "bin": "…" }` — written at install time. This is the
//      production mechanism: it is read from disk at runtime, so it survives whatever
//      launch environment OpenCode came from (unlike an env var or a shell PATH).
//   3. The built dist/cli.js resolved relative to THIS file — the zero-config default
//      for a repo checkout. No PATH, and no `#!/usr/bin/env node` shebang lookup either.
//   4. Bare `librarian` on PATH — last-resort convenience.
//
// A resolved `.js` path is run with `process.execPath` (the same runtime already running
// this plugin) so we never depend on the shebang finding `node`; an executable (no .js)
// is spawned directly. The result is an argv PREFIX; the subcommand + args are appended.
// ---------------------------------------------------------------------------

/** The config file the collector already owns (src/paths.ts CONFIG_PATH). We do not
 *  import it — the adapter stays dependency-free of `src/` (§4) — so we recompute the
 *  same path here. Resolved lazily (at call time, not module load) so it honors the
 *  current home directory. */
function configPath(): string {
  return path.join(os.homedir(), '.librarian', 'config.json');
}

/** The persisted machine-id file the collector owns (src/paths.ts MACHINE_ID_PATH).
 *  As with configPath, we recompute rather than import it (§4) and resolve it lazily so
 *  it honors the current home directory. This is the file `librarian machine-id`
 *  writes on first run, so reading it directly lets the plugin skip spawning the CLI. */
function machineIdPath(): string {
  return path.join(os.homedir(), '.librarian', 'machine-id');
}

/** Turn a resolved CLI location into a spawn argv prefix: a `.js` file runs under the
 *  current runtime (process.execPath) so no shebang/PATH `node` lookup is needed; an
 *  executable is spawned directly. */
function argvFor(bin: string): string[] {
  return bin.endsWith('.js') ? [process.execPath, bin] : [bin];
}

/** Read `bin` out of ~/.librarian/config.json, best-effort: a missing file, malformed
 *  JSON, or an absent/blank `bin` key yields undefined (fall through to the next rung),
 *  never a throw — resolution must not break the session. */
function binFromConfig(): string | undefined {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const bin = (parsed as Record<string, unknown>).bin;
      if (typeof bin === 'string' && bin.trim().length > 0) {
        return bin;
      }
    }
  } catch {
    // absent or unreadable config — fall through
  }
  return undefined;
}

/** The built CLI (dist/cli.js) resolved relative to this source file, if it exists.
 *  This file lives at adapters/opencode/plugin.ts; the built CLI is at dist/cli.js —
 *  two directories up. Returns undefined when the CLI has not been built. */
function binFromRepo(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '..', '..', 'dist', 'cli.js');
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `librarian` invocation as an argv prefix (see the block comment above for
 * the ordering and rationale). Always returns something: the final rung is the bare
 * name, preserving the pre-hardening behavior so nothing regresses when neither an
 * override, a config, nor a built CLI is present.
 *
 * Exported for the seam test (the only reason this is not module-private).
 */
export function resolveLibrarianArgv(): string[] {
  const fromEnv = process.env.LIBRARIAN_BIN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return argvFor(fromEnv);
  }
  const fromConfig = binFromConfig();
  if (fromConfig) {
    return argvFor(fromConfig);
  }
  const fromRepo = binFromRepo();
  if (fromRepo) {
    return argvFor(fromRepo);
  }
  return ['librarian'];
}

/**
 * Resolve the machine id the way the spec mandates (§10.1, §11): a generated,
 * persisted id — never the hostname. Resolution order (first hit wins):
 *
 *   1. `MACHINE_ID_PATH` env var, when set and the file is non-empty (explicit override).
 *   2. The default persisted file `~/.librarian/machine-id` — the same file the CLI
 *      writes. Reading it directly means the common case needs no subprocess at all,
 *      so the machine id no longer depends on locating/spawning the CLI under whatever
 *      launch environment OpenCode inherited.
 *   3. The CLI (`librarian machine-id`, via `resolveLibrarianArgv`), which generates-and-
 *      persists on first call — the bootstrap path when the file does not yet exist.
 *   4. A random UUID, so an event still carries a non-empty machine_id and the pipeline
 *      does not wedge; a warning is logged so the operator can fix the install.
 *
 * Exported for the seam test (the only reason this is not module-private).
 */
export function resolveMachineId(): string {
  const fromEnvPath = process.env.MACHINE_ID_PATH;
  if (fromEnvPath) {
    const id = readIdFile(fromEnvPath);
    if (id) {
      return id;
    }
  }

  const id = readIdFile(machineIdPath());
  if (id) {
    return id;
  }

  const [cmd, ...prefix] = resolveLibrarianArgv();
  const fromCli = tryRun(cmd, [...prefix, 'machine-id'], process.cwd());
  if (fromCli) {
    return fromCli;
  }

  process.stderr.write(
    'librarian: could not resolve machine id (no persisted id at ~/.librarian/machine-id ' +
      'and could not locate/run the librarian CLI; set LIBRARIAN_BIN or ~/.librarian/config.json ' +
      '"bin", or build the CLI); falling back to an ephemeral id for this run\n',
  );
  return randomUUID();
}

/** Read a persisted id from a file: trimmed non-empty contents, or undefined if the file
 *  is absent, unreadable, or blank. Never throws — id resolution must not break init. */
function readIdFile(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const id = fs.readFileSync(file, 'utf8').trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
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
 * `agent_version` is filled opportunistically: OpenCode only surfaces its version on
 * the full `Session` object (`session.created`/`session.deleted`), not on the chat/tool
 * hooks. So it is unset at init and back-filled once `session.created` is observed (see
 * the `event` handler), after which every subsequent event in the session carries it.
 * Facts we cannot resolve are omitted, never faked.
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
 * child (or a batching buffer flushed on idle), not more logic here. The CLI is located
 * via `resolveLibrarianArgv` (LIBRARIAN_BIN → config → built dist → bare name), so it does
 * not depend on $PATH. A collector rejection (fail-loud, §9) is surfaced to the OpenCode
 * log but never rethrown — instrumentation must not break the session.
 */
function handOff(event: CanonicalEvent, log: (level: string, message: string) => void): void {
  const line = JSON.stringify(event) + '\n';
  const [cmd, ...prefix] = resolveLibrarianArgv();
  const result = spawnSync(cmd, [...prefix, 'collect'], { input: line, encoding: 'utf8' });
  if (result.error) {
    log(
      'error',
      `librarian collect failed to spawn: ${result.error.message} ` +
        '(could not locate/run the librarian CLI; set LIBRARIAN_BIN or ~/.librarian/config.json "bin", or build the CLI)',
    );
    return;
  }
  if (result.status !== 0) {
    log('error', `librarian collect rejected an event (exit ${result.status}): ${result.stderr?.trim() ?? ''}`);
  }
}

// ---------------------------------------------------------------------------
// Lowering: OpenCode native hook args → the mapper's terse NativePayload.
//
// Shapes track the pinned SDK (@opencode-ai/sdk types.gen.ts). We read them through
// forgiving accessors rather than importing the SDK types (keeping this repo free of
// that dependency), but the field paths below are the real, version-pinned ones.
// Anything we cannot understand is skipped (returns undefined) rather than mis-mapped.
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function asRecord(v: unknown): Loose | undefined {
  return typeof v === 'object' && v !== null ? (v as Loose) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** A parsed `Session` object (present on session.created/deleted under properties.info). */
interface SessionInfo {
  id: string;
  version?: string;
}

/** Read the `Session` under an `event`'s `properties.info`, if present and well-formed. */
function readSessionInfo(evt: Loose): SessionInfo | undefined {
  const props = asRecord(evt.properties);
  const info = props && asRecord(props.info);
  const id = info && asString(info.id);
  if (!id) {
    return undefined;
  }
  return { id, version: asString(info.version) };
}

/**
 * Map an OpenCode `event` payload to a session-lifecycle NativePayload — but only the
 * two ONE-SHOT transitions we care about:
 *
 *   - `session.created` → start. Fires EXACTLY ONCE when a session is created (unlike
 *     Claude Code's `SessionStart`, which fires repeatedly across a session's life).
 *   - `session.deleted` → stop. Fires once when the session is deleted — the only
 *     one-shot "session ended" signal OpenCode offers (session.idle repeats per turn,
 *     so it is deliberately NOT used here).
 *
 * Compaction is handled by its own `experimental.session.compacting` hook, not here.
 * Both events carry the full `Session` under `properties.info` (so the session id, and
 * for `created` the version, come from there).
 */
function lowerSessionEvent(evt: Loose): { payload: SessionPayload; session: SessionInfo } | undefined {
  const type = asString(evt.type);
  if (type !== 'session.created' && type !== 'session.deleted') {
    return undefined;
  }
  const session = readSessionInfo(evt);
  if (!session) {
    return undefined;
  }
  const action = type === 'session.created' ? 'start' : 'stop';
  return { payload: { kind: 'session', action }, session };
}

/** Concatenate the user-visible text out of a message's `parts[]` (TextPart.text),
 *  skipping synthetic/ignored parts and anything that is not a text part. */
function extractUserText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const texts = parts
    .map((p) => {
      const rec = asRecord(p);
      if (!rec || rec.type !== 'text' || rec.synthetic === true || rec.ignored === true) {
        return undefined;
      }
      return asString(rec.text);
    })
    .filter((t): t is string => t !== undefined);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Map an OpenCode `chat.message` payload → a prompt NativePayload. The hook fires with
 * one message + its parts; we emit only for user messages. Returns the message id too
 * so the caller can dedup (the same message can be delivered more than once).
 */
function lowerChatMessage(output: Loose): { payload: NativePayload; messageId: string | undefined } | undefined {
  const message = asRecord(output.message);
  if (!message || message.role !== 'user') {
    return undefined;
  }
  const text = extractUserText(output.parts);
  if (!text) {
    return undefined;
  }
  // raw prompt — collector redacts (§5)
  return { payload: { kind: 'prompt', text }, messageId: asString(message.id) };
}

/**
 * Map an OpenCode `tool.execute.after` payload → a tool NativePayload. The tool args
 * (command line, filePath) are on `input.args` — the pinned signature is
 * `input: { tool, sessionID, callID, args }`, `output: { title, output, metadata }`
 * (there is no `output.args`).
 */
function lowerTool(input: Loose): NativePayload | undefined {
  const tool = asString(input.tool);
  if (!tool) {
    return undefined;
  }

  const args = asRecord(input.args) ?? {};
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
export const LibrarianPlugin = async (ctx: PluginContext) => {
  const cwd = ctx.worktree ?? ctx.directory ?? process.cwd();
  // Mutable so `session.created` can back-fill `agent_version` (Session.version) into
  // the shared facts, after which every subsequent event in the session carries it.
  let resource = buildResource(cwd);
  const sessionCwd = cwd;

  // Prompt dedup: `chat.message` is a one-shot "new message received" signal, but the
  // same UserMessage.id can still be delivered more than once — remember the ids we
  // have already emitted a PromptEvent for and skip repeats. In-memory only, so a
  // plugin restart resets it (at-least-once; an occasional post-restart dup is fine,
  // the collector has no id-dedup today and instrumentation stays dumb).
  const seenMessageIds = new Set<string>();

  const log = (level: string, message: string): void => {
    try {
      // Prefer structured logging through the SDK; fall back to stderr.
      // Call .log() directly on the app object to preserve `this` (§4).
      if (ctx.client?.app?.log) {
        void ctx.client.app.log({ body: { service: 'librarian', level, message } });
      } else {
        process.stderr.write(`librarian [${level}]: ${message}\n`);
      }
    } catch {
      // Instrumentation must never break the session (§4).
      process.stderr.write(`librarian [${level}]: ${message}\n`);
    }
  };

  /** Build the per-event context. There is no `turn` concept in the OpenCode payloads,
   *  so `context.turn` is deliberately left unset (schema allows it to be absent). */
  const contextFor = (sessionId: string | undefined): Context => ({
    session_id: sessionId && sessionId.length > 0 ? sessionId : 'unknown',
    cwd: sessionCwd,
  });

  /** Turn a lowered payload into a stamped canonical event and hand it off. */
  const emit = (payload: NativePayload, sessionId: string | undefined): void => {
    const events = map(payload, {
      event_id: ulid(), // ULID stamped before handoff (§10.1)
      ts: new Date().toISOString(), // ISO 8601 stamp (§10.1)
      resource,
      context: contextFor(sessionId),
    });
    for (const event of events) {
      handOff(event, log);
    }
  };

  return {
    /**
     * A new message was received. We emit a PromptEvent for user messages only.
     *
     * Why `chat.message` and not `experimental.chat.messages.transform`: the latter is a
     * transform over the ENTIRE message history that fires on every chat round-trip, so
     * emitting per user message there would re-emit every prior prompt each turn.
     * `chat.message` is the one-shot "message received" signal — the natural fit.
     *
     * We capture the prompt at first receipt only; later edits to a message (message
     * updates) are deliberately NOT re-emitted — handling updated/edited messages is
     * deferred. Dedup by message id guards against a repeated delivery of the same id.
     */
    'chat.message': async (input: Loose, output: Loose) => {
      const lowered = lowerChatMessage(output);
      if (!lowered) {
        return;
      }
      if (lowered.messageId) {
        if (seenMessageIds.has(lowered.messageId)) {
          return;
        }
        seenMessageIds.add(lowered.messageId);
      }
      emit(lowered.payload, asString(input.sessionID) ?? asString((asRecord(output.message) ?? {}).sessionID));
    },

    /** A tool finished executing → ToolEvent. Args (command/filePath) are on input.args. */
    'tool.execute.after': async (input: Loose, _output: Loose) => {
      const payload = lowerTool(input);
      if (payload) {
        emit(payload, asString(input.sessionID));
      }
    },

    /**
     * Fired BEFORE session compaction runs (hook is "compacting", distinct from the
     * post-hoc `session.compacted` event) → SessionEvent(compact). We are a pure
     * observer here: we do not touch `output.context`/`output.prompt`.
     */
    'experimental.session.compacting': async (input: Loose, _output: Loose) => {
      emit({ kind: 'session', action: 'compact' }, asString(input.sessionID));
    },

    /** Session lifecycle: only the one-shot session.created (start) / session.deleted
     *  (stop). session.created also back-fills `agent_version` from Session.version. */
    event: async ({ event }: { event: Loose }) => {
      const lowered = lowerSessionEvent(event);
      if (!lowered) {
        return;
      }
      if (lowered.payload.action === 'start' && lowered.session.version && !resource.agent_version) {
        resource = { ...resource, agent_version: lowered.session.version };
      }
      emit(lowered.payload, lowered.session.id);
    },
  };
};

export default LibrarianPlugin;
