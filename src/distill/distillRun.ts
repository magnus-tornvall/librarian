import fs from 'node:fs';
import path from 'node:path';
import type { InferenceProvider } from './provider.ts';
import { distill } from './llmDistiller.ts';
import { appendNote } from '../log/noteLog.ts';
import { readCursor, advanceCursor, type Cursor } from '../log/cursor.ts';
import { acquireLock } from '../log/lock.ts';
import {
  writeDistillVerdict,
  makeVerdictId,
  type DistillVerdict,
} from '../diagnostics/distillVerdict.ts';

/**
 * `librarian distill` orchestration (spec §4 "Owns distill triggering", §8
 * "Distill verdicts"). Kept out of `cli.ts` so the CLI stays a thin shell: this
 * module scans pending per-session event deltas, applies the skip heuristic,
 * runs the injected distiller on eligible sessions, appends notes, writes
 * verdicts, and advances cursors — advance ONLY after a delta is processed
 * (§5 "Durability & safety").
 */

/** Consumer name stamped on every cursor this command owns (§5). */
const CONSUMER = 'distiller';

/**
 * A distiller lock older than this (ms) is presumed abandoned and recovered,
 * even if its PID is still live — a pass that has run this long is wedged, not
 * working. Ten minutes is far past any real distill pass (a handful of provider
 * calls) yet short enough that a crashed run doesn't block the next trigger for
 * long. Named constant, not config, until real usage says otherwise (§4).
 * ponytail: fixed timeout; make it a flag only if pass durations ever vary enough to matter.
 */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** One distiller lock guards the whole data dir against concurrent passes (§5). */
function lockPathFor(dataDir: string): string {
  return path.join(dataDir, 'locks', 'distiller.lock');
}

/**
 * Skip-heuristic thresholds — the SuperBrain-proven values (§3, endorsed in §5:
 * fewer low-signal notes = fewer future distractors). Named constants, not
 * config, until real usage says otherwise (issue: "Do not relitigate").
 */
const MIN_EVENTS = 10;
const MIN_PROMPTS = 2;

/**
 * Tool categories that count as a "write tool" for the skip heuristic — a
 * session that changed the world is worth remembering even when quiet.
 * Derived from the canonical event categories (`file_write`, `vcs_commit`,
 * `vcs_push`).
 */
const WRITE_TOOL_CATEGORIES: ReadonlySet<string> = new Set([
  'file_write',
  'vcs_commit',
  'vcs_push',
]);

type DeltaMetrics = {
  events: number;
  prompts: number;
  writeTools: number;
  salienceHints: number;
};

function isWriteTool(event: Record<string, unknown>): boolean {
  if (event.type !== 'tool') {
    return false;
  }
  const tool = (event.tool ?? {}) as Record<string, unknown>;
  return typeof tool.category === 'string' && WRITE_TOOL_CATEGORIES.has(tool.category);
}

function hasSalienceHint(event: Record<string, unknown>): boolean {
  const hints = (event.hints ?? {}) as Record<string, unknown>;
  return hints.possibly_salient === true;
}

function measure(events: Array<Record<string, unknown>>): DeltaMetrics {
  let prompts = 0;
  let writeTools = 0;
  let salienceHints = 0;
  for (const event of events) {
    if (event.type === 'prompt') prompts += 1;
    if (isWriteTool(event)) writeTools += 1;
    if (hasSalienceHint(event)) salienceHints += 1;
  }
  return { events: events.length, prompts, writeTools, salienceHints };
}

/**
 * Decide whether a session's pending delta should be skipped. Returns a human
 * skip reason, or `null` when the delta is eligible for distillation.
 *
 * Skip when the delta has 0 salience hints AND 0 write tools AND fewer than 2
 * prompts, OR fewer than 10 events total (§3).
 */
function skipReason(m: DeltaMetrics): string | null {
  if (m.events < MIN_EVENTS) {
    return `fewer than ${MIN_EVENTS} events (${m.events})`;
  }
  if (m.salienceHints === 0 && m.writeTools === 0 && m.prompts < MIN_PROMPTS) {
    return `low signal: ${m.salienceHints} salience hints, ${m.writeTools} write tools, ${m.prompts} prompts`;
  }
  return null;
}

/**
 * Parse the complete NDJSON records in `buffer` and report how many bytes were
 * consumed. A partial trailing line (no closing newline yet) is left unparsed
 * and its bytes are NOT counted — the cursor stops before it so a still-being-
 * written line is retried once complete (§5), never treated as an error.
 */
function parseComplete(buffer: string): {
  events: Array<Record<string, unknown>>;
  consumedBytes: number;
} {
  const lastNewline = buffer.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No complete line yet — everything is a partial trailing line.
    return { events: [], consumedBytes: 0 };
  }
  const complete = buffer.slice(0, lastNewline + 1);
  const events = complete
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { events, consumedBytes: Buffer.byteLength(complete, 'utf8') };
}

function cursorPathFor(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'cursors', CONSUMER, `${sessionId}.json`);
}

function makeCursor(
  logFilePath: string,
  sessionId: string,
  byteOffset: number,
  lastRecordId: string | undefined,
): Cursor {
  return {
    consumer: CONSUMER,
    log_name: `events/${sessionId}.ndjson`,
    file_path: logFilePath,
    byte_offset: byteOffset,
    ...(lastRecordId !== undefined ? { last_record_id: lastRecordId } : {}),
    updated_at: new Date().toISOString(),
  };
}

export type DistillRunOptions = {
  dataDir: string;
  diagnosticsDir: string;
  provider: InferenceProvider;
};

/**
 * Run one foreground distill pass over every per-session event log under
 * `<dataDir>/events/*.ndjson`.
 *
 * Idempotency (§5): only bytes past the distiller cursor's `byte_offset` are
 * ever read, and the cursor advances on BOTH a distill and a skip (a skipped
 * delta is processed, not pending forever). So a clean re-run over an unchanged
 * log reads a zero-length delta and mints nothing.
 *
 * Exactly-once-ish rests on advance-after-success, NOT on provenance dedup
 * (§5 line 91 pairs the two; only the first half lives here). A crash in the
 * window between `appendNote` and `advanceCursor`, or a lost/corrupted cursor
 * file (→ offset 0), re-distills the delta on the next run and mints a
 * duplicate note under a fresh id. Provenance-based dedup and bounded
 * retries/quarantine are roadmap item 9 (hardening), not here.
 *
 * Fail loud (§9): if the provider or JSON parse throws for an eligible session,
 * this rethrows WITHOUT advancing that session's cursor and without writing a
 * success verdict, so the CLI exits non-zero and the next run retries the same
 * range (bounded retries/quarantine are roadmap item 9, not here).
 *
 * Single-writer (§5): the whole pass runs under one lock at
 * `<dataDir>/locks/distiller.lock`. A live, fresh holder means another run is
 * already draining the same backlog — a normal outcome under lazy triggering,
 * not an error — so we print a notice to stderr and return (the CLI exits 0).
 * The lock is released in `finally`, so no lock file survives a clean run; a
 * crashed holder is recovered by the next run's stale check (dead PID or
 * timeout). This guards concurrent invocations only — it does not create a
 * resident worker or watch loop (§4, "Do not relitigate").
 */
export async function runDistill(options: DistillRunOptions): Promise<void> {
  const lock = acquireLock(lockPathFor(options.dataDir), { staleMs: LOCK_STALE_MS });
  if (lock === null) {
    // Someone live and fresh is already draining this backlog — not an error.
    process.stderr.write('librarian: distill already running (lock held); nothing to do\n');
    return;
  }
  try {
    await runDistillPass(options);
  } finally {
    lock.release();
  }
}

async function runDistillPass(options: DistillRunOptions): Promise<void> {
  const { dataDir, diagnosticsDir, provider } = options;
  const eventsDir = path.join(dataDir, 'events');
  if (!fs.existsSync(eventsDir)) {
    return;
  }

  const logNames = fs
    .readdirSync(eventsDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort();

  for (const logName of logNames) {
    const sessionId = logName.slice(0, -'.ndjson'.length);
    const logFilePath = path.join(eventsDir, logName);
    const cursorPath = cursorPathFor(dataDir, sessionId);

    const cursor = readCursor(cursorPath);
    const startOffset = cursor?.byte_offset ?? 0;

    const fileBytes = fs.readFileSync(logFilePath);
    if (startOffset >= fileBytes.length) {
      // Nothing new since the last successful pass — the idempotent no-op path.
      continue;
    }

    const delta = fileBytes.subarray(startOffset).toString('utf8');
    const { events, consumedBytes } = parseComplete(delta);
    if (events.length === 0) {
      // Only a partial trailing line so far — leave the cursor put, retry later.
      continue;
    }

    const newOffset = startOffset + consumedBytes;
    const lastRecordId = events[events.length - 1].event_id as string | undefined;
    const metrics = measure(events);
    const counts: DistillVerdict['counts'] = {
      events: metrics.events,
      prompts: metrics.prompts,
      write_tools: metrics.writeTools,
      salience_hints: metrics.salienceHints,
    };

    const skip = skipReason(metrics);
    if (skip !== null) {
      const verdict: DistillVerdict = {
        record_class: 'diagnostic',
        verdict_id: makeVerdictId(),
        ts: new Date().toISOString(),
        session_id: sessionId,
        decision: 'skipped',
        reason: skip,
        counts,
      };
      writeDistillVerdict(diagnosticsDir, verdict);
      advanceCursor(cursorPath, makeCursor(logFilePath, sessionId, newOffset, lastRecordId));
      continue;
    }

    // Eligible: origin is denormalized from the events' resource.agent (§5).
    const origin = ((events[0].resource ?? {}) as Record<string, unknown>).agent;
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new Error(`session ${sessionId}: missing resource.agent on first delta event`);
    }

    // If distill()/JSON parse throws, it propagates here: cursor NOT advanced,
    // no success verdict written, non-zero exit, next run retries (§5).
    const note = await distill(events, sessionId, provider, origin);
    appendNote(dataDir, note);

    const verdict: DistillVerdict = {
      record_class: 'diagnostic',
      verdict_id: makeVerdictId(),
      ts: new Date().toISOString(),
      session_id: sessionId,
      decision: 'distilled',
      reason: `distilled ${metrics.events} events into ${note.note_id}`,
      counts,
      note_id: note.note_id,
    };
    writeDistillVerdict(diagnosticsDir, verdict);

    // Advance only after the note is durably appended (§5 advance-after-success).
    advanceCursor(cursorPath, makeCursor(logFilePath, sessionId, newOffset, lastRecordId));
  }
}
