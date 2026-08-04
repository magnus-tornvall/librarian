/**
 * OpenCode instrumentation — the I/O shell behind `librarian hook opencode` (roadmap item
 * 6, spec §4; §14 amendment: thin plugin routed through the installed bin). This is the
 * ONLY part of the OpenCode integration that does I/O in librarian's own process; the
 * mapping is the pure `opencodeMap.ts`.
 *
 * OpenCode loads *executable JS* in-process (unlike Claude Code, which spawns `command`
 * hooks), so a small plugin file always lands in the host — `adapters/opencode/plugin.ts`,
 * installed by `librarian init`. That file is deliberately dumb: it subscribes to OpenCode's
 * hooks and pipes the RAW native payload here, wrapped in a one-key envelope naming which
 * hook fired. Everything with judgment in it — lowering the native shapes, resolving the
 * machine-specific `resource` facts, stamping `event_id`/`ts`, mapping, delivery, and
 * recall — happens in this process, behind the installed binary.
 *
 *   plugin  ── {hook, cwd, input, output}  ─▶  librarian hook opencode
 *           ◀─ {brief, recall} (chat.message only)
 *
 * The plugin needs the injection blocks BACK (it must splice them into the outgoing message
 * array inside OpenCode's own process — there is no `additionalContext` channel like Claude
 * Code's), so for `chat.message` this shell prints a small JSON result on stdout. Its
 * per-session caching and the splice itself stay in the plugin, which is the only thing that
 * lives long enough to hold them.
 *
 * HOOK-SAFETY CONTRACT (§14 "Dogfooding"): instrumentation MUST NOT break the instrumented
 * agent. Whatever happens inside this script — a malformed envelope, a missing `librarian`,
 * a git command that throws — the process exits 0 and prints nothing on stdout (the plugin
 * reads stdout as JSON; garbage there would be worse than silence). Loud failure goes to
 * stderr, where OpenCode's log surfaces it. `runOpenCodeHook()` swallows every throw; the
 * `librarian hook opencode` subcommand hard-guarantees exit 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import {
  map,
  type CanonicalEvent,
  type Context,
  type FileAction,
  type NativePayload,
  type Outcome,
  type PromptPayload,
  type SessionPayload,
} from './opencodeMap.ts';
import { resolveLibrarianCommand, runLibrarian as spawnLibrarian } from './librarianBin.ts';
import { buildResource as buildSharedResource, type Resource } from './resource.ts';

const LOG_TAG = 'librarian-opencode';

/**
 * Recall must not add perceptible latency to an interactive turn, so each `librarian
 * inject` gets a hard 1s budget — the same budget the plugin enforced before the port.
 * A timeout is reported as "no block", never as an error that could break the turn.
 */
const INJECT_TIMEOUT_MS = 1_000;

const librarian = resolveLibrarianCommand();

function runLibrarian(args: string[], options: Parameters<typeof spawnLibrarian>[2] = {}) {
  return spawnLibrarian(librarian, args, options);
}

function logError(message: string): void {
  // stderr only — stdout is the plugin's JSON channel.
  process.stderr.write(`${LOG_TAG}: ${message}\n`);
}

// ---------------------------------------------------------------------------
// The envelope the plugin sends on stdin.
// ---------------------------------------------------------------------------

/**
 * The plugin's hook name is NOT the canonical contract (OpenCode's hook names drift across
 * versions); the mapping in `opencodeMap.ts` is. When a hook name or payload changes, only
 * the lowering below changes — the mapper and its fixtures are untouched.
 */
export type OpenCodeHook = 'chat.message' | 'tool.execute.after' | 'experimental.session.compacting' | 'event';

export interface OpenCodeEnvelope {
  hook: OpenCodeHook;
  /** The session's working directory (`ctx.worktree ?? ctx.directory`) — OpenCode's native
   *  payloads do not carry it, and only the plugin knows it. */
  cwd?: string;
  /** `Session.version`, which OpenCode surfaces only on `session.created`; the plugin
   *  remembers it and stamps every later envelope with it. */
  agent_version?: string;
  /** `chat.message` only: also fetch the session-start brief (the plugin asks once per
   *  session — it is the only thing that knows whether it already holds one). */
  brief?: boolean;
  input?: unknown;
  output?: unknown;
  event?: unknown;
}

/** What this shell prints on stdout for `chat.message`. `*_ok` distinguishes "asked and got
 *  nothing" (a below-floor prompt) from "the call failed" — the plugin retries a failed
 *  brief on the next turn but does not re-ask a successful empty one. */
export interface OpenCodeHookResult {
  brief_ok?: boolean;
  brief?: string;
  recall_ok?: boolean;
  recall?: string;
}

// ---------------------------------------------------------------------------
// Lowering: raw OpenCode native payloads → the mapper's terse NativePayload.
//
// Shapes track the pinned SDK (@opencode-ai/sdk types.gen.ts). We read them through
// forgiving accessors rather than importing the SDK types (keeping this repo free of that
// dependency), but the field paths below are the real, version-pinned ones. Anything we
// cannot understand is skipped (returns undefined) rather than mis-mapped.
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
 * Map an OpenCode `event` payload to a session-lifecycle NativePayload — but only the two
 * ONE-SHOT transitions we care about:
 *
 *   - `session.created` → start. Fires EXACTLY ONCE when a session is created (unlike
 *     Claude Code's `SessionStart`, which fires repeatedly across a session's life).
 *   - `session.deleted` → end. Fires once when the session is deleted — the only one-shot
 *     "session ended" signal OpenCode offers (session.idle repeats per turn, so it is
 *     deliberately NOT used here). The mapper turns `end` into the TERMINAL boundary marker,
 *     the same one Claude Code's `SessionEnd` produces (issue #169).
 *
 * Compaction is handled by its own `experimental.session.compacting` hook, not here. Both
 * events carry the full `Session` under `properties.info`.
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
  const action = type === 'session.created' ? 'start' : 'end';
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
 * Map an OpenCode `chat.message` payload → a prompt NativePayload. The hook fires with one
 * message + its parts; we emit only for user messages.
 */
function lowerChatMessage(output: Loose): PromptPayload | undefined {
  const message = asRecord(output.message);
  if (!message || message.role !== 'user') {
    return undefined;
  }
  const text = extractUserText(output.parts);
  if (!text) {
    return undefined;
  }
  // raw prompt — collector redacts (§5)
  return { kind: 'prompt', text };
}

/**
 * Map an OpenCode `tool.execute.after` payload → a tool NativePayload. The tool args
 * (command line, filePath) are on `input.args` — the pinned signature is
 * `input: { tool, sessionID, callID, args }`, `output: { title, output, metadata }` (there
 * is no `output.args`).
 *
 * `output.output` is a single combined string — OpenCode does not split stdout from stderr,
 * and never populates a `stderr` key — so it lowers to `outcome.stdout`.
 *
 * `output.metadata.exit` is the real exit code, and it is the reason OpenCode can honour
 * `command_failed` where Claude Code cannot. Verified two ways: it is present on 3639 of
 * 3673 persisted bash parts, and the hook receives the tool's own return value (opencode
 * triggers `tool.execute.after` with the `{title, metadata, output}` object the tool
 * returned, which is the same object later persisted as `state.metadata`) — so the field is
 * there at hook time, not only after the write.
 */
function lowerTool(input: Loose, output: Loose): NativePayload | undefined {
  const tool = asString(input.tool);
  if (!tool) {
    return undefined;
  }

  const args = asRecord(input.args) ?? {};
  const command = asString(args.command);
  const files = extractFiles(tool, args);
  const printed = asString(output.output);
  const metadata = asRecord(output.metadata) ?? {};

  const payload: NativePayload = { kind: 'tool', tool };
  if (command) {
    payload.command = command; // raw — collector redacts (§5)
  }

  // The mapper drops the outcome for non-shell categories; this only assembles it.
  const outcome: Outcome = {};
  if (printed) {
    outcome.stdout = printed; // raw — collector redacts (§5)
  }
  // 12 of 3673 real calls carried a null exit; only a number is lifted.
  if (typeof metadata.exit === 'number') {
    outcome.exit = metadata.exit;
  }
  if (metadata.interrupted === true) {
    outcome.interrupted = true;
  }
  if (Object.keys(outcome).length > 0) {
    payload.outcome = outcome;
  }

  if (files) {
    payload.files = files;
  }
  // The `todowrite` tool's list, passed through verbatim; the mapper decides whether an
  // all-complete list is a semantic boundary (issue #169 — detection stays in the mapper).
  if (Array.isArray(args.todos)) {
    payload.todos = args.todos;
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

/** Lower one envelope to the payload to map plus the session it belongs to. Returns
 *  undefined for anything unrecognized — a deliberate no-op, never a throw. */
function lower(envelope: OpenCodeEnvelope): { payload: NativePayload; sessionId?: string } | undefined {
  const input = asRecord(envelope.input) ?? {};
  const output = asRecord(envelope.output) ?? {};

  switch (envelope.hook) {
    case 'chat.message': {
      const payload = lowerChatMessage(output);
      if (!payload) return undefined;
      return { payload, sessionId: asString(input.sessionID) ?? asString((asRecord(output.message) ?? {}).sessionID) };
    }
    case 'tool.execute.after': {
      const payload = lowerTool(input, output);
      return payload ? { payload, sessionId: asString(input.sessionID) } : undefined;
    }
    case 'experimental.session.compacting':
      return { payload: { kind: 'session', action: 'compact' }, sessionId: asString(input.sessionID) };
    case 'event': {
      const lowered = lowerSessionEvent(asRecord(envelope.event) ?? {});
      return lowered ? { payload: lowered.payload, sessionId: lowered.session.id } : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Delivery + recall seams.
// ---------------------------------------------------------------------------

/**
 * Hand a mapped event off to the collector.
 *
 * ponytail (v1 ceiling): this spawns `librarian collect` once per event, inside a hook
 * process that is itself one spawn per event. Fine for v1 — correctness over throughput,
 * and it keeps the shell stateless. When it bites, the fix is a single long-lived `collect`
 * child or a batching buffer flushed on idle — not more logic here. A collector rejection
 * (fail-loud, §9) is surfaced on stderr but never rethrown (hook-safety).
 */
function handOff(event: CanonicalEvent): void {
  const line = JSON.stringify(event) + '\n';
  const result = runLibrarian(['collect'], { input: line, encoding: 'utf8' });
  if (result.error) {
    logError(`librarian collect failed to spawn: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    logError(`librarian collect rejected an event (exit ${result.status}): ${String(result.stderr ?? '').trim()}`);
  }
}

function projectSlug(gitRoot: string | undefined): string | undefined {
  // ponytail: basename is v1 project attribution; replace when §5 grows real project identity.
  return gitRoot === undefined ? undefined : path.basename(gitRoot);
}

type InjectOutcome = { ok: boolean; block?: string };

/**
 * Run one `librarian inject`. `ok: false` means the call itself failed (spawn error,
 * non-zero exit, timeout); `ok: true` with no block means it ran and had nothing to say
 * (a below-floor prompt). The distinction is what lets the plugin retry a failed brief
 * without re-asking a successful empty one.
 *
 * ponytail: the brief and the recall run sequentially rather than in parallel. The brief is
 * fetched once per session, so the extra 1s worst case lands on turn 1 only — not worth a
 * concurrent-spawn dance in a process whose whole job is "run two commands".
 */
function runInject(resource: Resource, query: string, sessionStart: boolean, sessionId?: string): InjectOutcome {
  const args = ['inject', '--global'];
  const slug = projectSlug(resource.git_root);
  if (slug !== undefined) args.push('--project', slug);
  if (sessionStart) args.push('--session-start');
  if (sessionId !== undefined) args.push('--session', sessionId);

  try {
    const result = runLibrarian(args, {
      cwd: resource.cwd,
      input: sessionStart ? '' : query,
      encoding: 'utf8',
      timeout: INJECT_TIMEOUT_MS,
    });
    if (result.error) {
      logError(`librarian inject failed: ${result.error.message}; skipping recall injection`);
      return { ok: false };
    }
    if (result.status !== 0) {
      logError(`librarian inject exited ${result.status}; skipping recall injection`);
      return { ok: false };
    }
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    return { ok: true, block: stdout.length > 0 ? stdout : undefined };
  } catch (err) {
    logError(`librarian inject threw: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// The hook body.
// ---------------------------------------------------------------------------

/** Build the per-event canonical context. There is no `turn` concept in the OpenCode
 *  payloads, so `context.turn` is deliberately left unset (the schema allows it absent). */
function contextFor(sessionId: string | undefined, cwd: string): Context {
  return { session_id: sessionId && sessionId.length > 0 ? sessionId : 'unknown', cwd };
}

/**
 * Read the envelope, map, hand off, and return the injection result the plugin needs back.
 * Exposed for the integration tests (they call it with a captured stdin string and a stubbed
 * handoff) — the real entry is `runOpenCodeHook()` below, which wires stdin/`handOff`/stdout;
 * the CLI subcommand guarantees exit 0.
 */
export function runHook(
  readStdin: () => string,
  deliver: (event: CanonicalEvent) => void,
  buildResourceFn: (cwd: string, agentVersion?: string) => Resource = buildResource,
  injectFn: (resource: Resource, query: string, sessionStart: boolean, sessionId?: string) => InjectOutcome = runInject,
): OpenCodeHookResult | undefined {
  const rawText = readStdin();
  if (rawText.trim().length === 0) {
    // Empty stdin — nothing to record. Not an error; a hook may fire with no payload.
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logError(`ignoring malformed hook payload (not JSON): ${reason}`);
    return undefined;
  }

  const envelope = asRecord(parsed) as OpenCodeEnvelope | undefined;
  if (!envelope || asString(envelope.hook) === undefined) {
    logError('ignoring hook payload with no "hook" field');
    return undefined;
  }

  const lowered = lower(envelope);
  if (!lowered) {
    // Unrecognized hook, non-user message, or unparseable payload — a deliberate no-op.
    return undefined;
  }

  const cwd = asString(envelope.cwd) ?? process.cwd();
  const resource = buildResourceFn(cwd, asString(envelope.agent_version));

  const events = map(lowered.payload, {
    event_id: ulid(), // ULID stamped before handoff (§10.1)
    ts: new Date().toISOString(), // ISO 8601 stamp (§10.1)
    resource,
    context: contextFor(lowered.sessionId, cwd),
  });
  for (const event of events) {
    deliver(event);
  }

  if (envelope.hook !== 'chat.message' || lowered.payload.kind !== 'prompt') {
    return undefined;
  }

  const result: OpenCodeHookResult = {};
  if (envelope.brief === true) {
    const brief = injectFn(resource, '', true, lowered.sessionId);
    result.brief_ok = brief.ok;
    if (brief.block !== undefined) result.brief = brief.block;
  }
  const recall = injectFn(resource, lowered.payload.text, false, lowered.sessionId);
  result.recall_ok = recall.ok;
  if (recall.block !== undefined) result.recall = recall.block;
  return result;
}

function buildResource(cwd: string, agentVersion?: string): Resource {
  return buildSharedResource('opencode', cwd, logError, librarian, agentVersion);
}

/** Read all of stdin (fd 0) synchronously. A hook's payload is small and finite. */
function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    // No stdin attached (e.g. a manual invocation) — treat as empty, not an error.
    return '';
  }
}

/**
 * The full OpenCode hook run behind `librarian hook opencode`: read the envelope, map, hand
 * off to `librarian collect`, and for `chat.message` print the injection result the plugin
 * splices. Swallows every error — never throws, and never prints partial JSON on stdout.
 * The CLI subcommand wraps this with the load-bearing `process.exit(0)`.
 */
export function runOpenCodeHook(): void {
  try {
    const result = runHook(readStdinSync, handOff);
    if (result !== undefined) {
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  } catch (err) {
    const reason = err instanceof Error ? err.stack ?? err.message : String(err);
    logError(`unexpected hook error (swallowed to protect the session): ${reason}`);
  }
}
