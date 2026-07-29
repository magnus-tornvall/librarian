/**
 * Claude Code instrumentation — the I/O shell behind `librarian hook claude-code` (roadmap
 * item 6, spec §4; §12: "Claude Code second"; §14 amendment: thin plugin routed through the
 * installed bin). This is the ONLY part of the Claude Code integration that does I/O; the
 * mapping is the pure `claudeCodeMap.ts`.
 *
 * The `.claude-plugin` manifest declares four `command` hooks, each running `librarian hook
 * claude-code`; Claude Code writes the event's JSON payload to that process's stdin
 * (docs.claude.com/en/docs/claude-code/hooks). `runClaudeCodeHook()` then:
 *   1. reads the whole stdin payload,
 *   2. lowers it onto the mapper's NativePayload,
 *   3. resolves the machine-specific `resource` facts (machine id, git root/remote/
 *      branch) and the per-event stamps (`event_id` ULID, `ts`),
 *   4. calls the pure `map()`,
 *   5. pipes the resulting canonical event as NDJSON into `librarian collect`.
 *
 * Everything with judgment in it lives elsewhere: mapping is `map.ts` (pure, fixture-
 * tested); redaction, validation, and salience authority are the collector's and
 * distiller's (§4, §5). The hook is dumb plumbing — map native → canonical, stamp
 * facts, emit cheap hints (via the mapper), hand off. Nothing more.
 *
 * HOOK-SAFETY CONTRACT (§14 "Dogfooding", issue Definition of done): instrumentation
 * MUST NOT break the instrumented agent. Whatever happens inside this script — a
 * malformed payload, a missing `librarian` on PATH, a git command that throws — the
 * process exits 0 and never writes to stdout (Claude Code interprets some hook stdout
 * as decision control / added context; a dumb recorder must stay silent there). Loud
 * failure belongs to `librarian collect`'s own stderr, which we capture and re-log to
 * THIS process's stderr where an operator can find it. `runHook()` is wrapped so that no
 * throw escapes `runClaudeCodeHook()`; the `librarian hook claude-code` subcommand
 * hard-guarantees exit 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { map, type CanonicalEvent, type Context, type NativePayload } from './claudeCodeMap.ts';
import { resolveLibrarianCommand, runLibrarian as spawnLibrarian } from './librarianBin.ts';
import { buildResource as buildSharedResource, type Resource } from './resource.ts';

// A namespaced tag so operators can grep the host session's hook logs for our lines.
const LOG_TAG = 'librarian-claude-code';
const INJECT_TIMEOUT_MS = 8_000;

const librarian = resolveLibrarianCommand();

function runLibrarian(args: string[], options: Parameters<typeof spawnLibrarian>[2] = {}) {
  return spawnLibrarian(librarian, args, options);
}

function logError(message: string): void {
  // stderr only — never stdout (Claude Code may treat hook stdout as decision/context).
  process.stderr.write(`${LOG_TAG}: ${message}\n`);
}

/**
 * Build the `resource` block for this hook invocation (facts resolved in `resource.ts`,
 * shared with the OpenCode shell). `agent` is always "claude-code" (issue §10.1).
 * `agent_version` is left unset: Claude Code's hook payloads do not carry the CLI version,
 * and the spec forbids faking a fact we cannot resolve.
 */
function buildResource(cwd: string): Resource {
  return buildSharedResource('claude-code', cwd, logError, librarian);
}

// ---------------------------------------------------------------------------
// Delivery seam: pipe one canonical event to `librarian collect` as NDJSON.
// ---------------------------------------------------------------------------

/**
 * Hand a mapped event off to the collector.
 *
 * ponytail (v1 ceiling): each Claude Code hook is already its own short-lived process,
 * and this spawns `librarian collect` once per event within it. That is fine for v1 —
 * correctness over throughput, and it keeps the hook stateless. The ceiling is set by the
 * manifest's `PostToolUse` matcher `*`: two processes per tool call (the hook, then
 * `collect`), so a tool-heavy turn pays that per tool. When it bites, the fix is a single
 * long-lived `collect` child or a batching buffer flushed on idle — not more logic here.
 * A collector rejection (fail-loud, §9) is surfaced to THIS process's
 * stderr but never rethrown — instrumentation must not break the session (hook-safety).
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

function injectForPayload(payload: NativePayload, cwd: string, gitRoot?: string): string | undefined {
  if (payload.hook_event_name !== 'UserPromptSubmit' && payload.hook_event_name !== 'SessionStart') {
    return undefined;
  }

  const args = ['inject', '--global', '--session', payload.session_id];
  const slug = projectSlug(gitRoot);
  if (slug !== undefined) {
    args.push('--project', slug);
  }
  if (payload.hook_event_name === 'SessionStart') {
    args.push('--session-start');
  }

  try {
    const result = runLibrarian(args, {
      cwd,
      input: payload.hook_event_name === 'UserPromptSubmit' ? payload.prompt : '',
      encoding: 'utf8',
      timeout: INJECT_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) {
      return undefined;
    }
    return result.stdout;
  } catch {
    return undefined;
  }
}

function emitAdditionalContext(hookEventName: 'UserPromptSubmit' | 'SessionStart', block: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: block,
      },
    }) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Lowering: raw Claude Code hook JSON → the mapper's NativePayload.
//
// Claude Code's payload IS the mapper's native shape (the mapper keys on
// `hook_event_name`), so lowering is mostly validation: confirm it is an object with a
// string `hook_event_name`, and hand the recognized events through. An unrecognized or
// malformed payload lowers to `undefined` and the hook emits nothing.
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function asRecord(v: unknown): Loose | undefined {
  return typeof v === 'object' && v !== null ? (v as Loose) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The four hook events this adapter maps; anything else is intentionally ignored. */
const MAPPED_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'SessionStart', 'Stop']);

/**
 * Validate + narrow raw stdin JSON to a NativePayload for one of the four mapped events.
 * Returns undefined for a non-object, a missing/unknown `hook_event_name`, or a missing
 * `session_id` (the routing key — without it the collector cannot place the event, so we
 * skip rather than emit an unroutable record).
 */
function lower(raw: unknown): NativePayload | undefined {
  const obj = asRecord(raw);
  if (!obj) {
    return undefined;
  }
  const eventName = asString(obj.hook_event_name);
  if (!eventName || !MAPPED_EVENTS.has(eventName)) {
    return undefined;
  }
  if (!asString(obj.session_id)) {
    return undefined;
  }
  // The mapper reads only the fields it needs off each variant and treats the payload
  // structurally; the runtime shape has been validated above for the parts we depend on
  // (event name + session id). The per-event fields (prompt, tool_name, …) are read
  // defensively inside map.ts. Cast is safe given the discriminator check.
  return obj as unknown as NativePayload;
}

/** Build the per-event canonical context from the native payload + resolved cwd. There
 *  is no `turn` concept in Claude Code hook payloads, so `context.turn` is left unset
 *  (the schema allows it to be absent). */
function contextFor(sessionId: string, cwd: string): Context {
  return { session_id: sessionId, cwd };
}

// ---------------------------------------------------------------------------
// The hook body.
// ---------------------------------------------------------------------------

/**
 * Read stdin, map, and hand off. Exposed for the integration tests (they call it with a
 * captured stdin string and a stubbed handoff) — the real entry is `runClaudeCodeHook()`
 * below, which wires stdin/`handOff`; the CLI subcommand guarantees exit 0.
 *
 * `readStdin` and `deliver` are injected so tests can drive the pure control flow (parse
 * → lower → resolve → map → hand off) without a real stdin or a real `librarian`.
 */
export function runHook(
  readStdin: () => string,
  deliver: (event: CanonicalEvent) => void,
  buildResourceFn: (cwd: string) => Resource = buildResource,
  injectFn: (payload: NativePayload, cwd: string, gitRoot?: string) => string | undefined = injectForPayload,
  emitContext: (hookEventName: 'UserPromptSubmit' | 'SessionStart', block: string) => void = emitAdditionalContext,
): void {
  const rawText = readStdin();
  if (rawText.trim().length === 0) {
    // Empty stdin — nothing to record. Not an error; a hook may fire with no payload.
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logError(`ignoring malformed hook payload (not JSON): ${reason}`);
    return;
  }

  const payload = lower(parsed);
  if (!payload) {
    // Unrecognized event, non-object, or missing session_id — a deliberate no-op.
    return;
  }

  const cwd = asString((parsed as Loose).cwd) ?? process.cwd();
  const resource = buildResourceFn(cwd);

  const events = map(payload, {
    event_id: ulid(), // ULID stamped before handoff (§10.1)
    ts: new Date().toISOString(), // ISO 8601 stamp (§10.1)
    resource,
    context: contextFor(payload.session_id, cwd),
  });

  for (const event of events) {
    deliver(event);
  }

  const block = injectFn(payload, cwd, resource.git_root);
  if (block !== undefined && (payload.hook_event_name === 'UserPromptSubmit' || payload.hook_event_name === 'SessionStart')) {
    emitContext(payload.hook_event_name, block);
  }
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
 * The full Claude Code hook run behind `librarian hook claude-code`: read stdin, map, hand
 * off to `librarian collect`, and for UserPromptSubmit/SessionStart emit the injected
 * `additionalContext` on stdout. Swallows every error (§14, Definition of done) — never
 * throws, and never writes to stdout on failure. The CLI subcommand wraps this with the
 * load-bearing `process.exit(0)` so a hook can never break the host Claude Code session.
 */
export function runClaudeCodeHook(): void {
  try {
    runHook(readStdinSync, handOff);
  } catch (err) {
    const reason = err instanceof Error ? err.stack ?? err.message : String(err);
    logError(`unexpected hook error (swallowed to protect the session): ${reason}`);
  }
}
