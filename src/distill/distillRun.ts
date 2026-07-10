import fs from 'node:fs';
import path from 'node:path';
import type { InferenceProvider } from './provider.ts';
import { distill } from './llmDistiller.ts';
import { appendNote, readAllNotes } from '../log/noteLog.ts';
import type { NoteRevision } from '../note.ts';
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
 * Bounded retries (§5, issue #60): a delta that fails the provider/parse is
 * retried on the next run up to this many times total. The run that reaches it
 * quarantines the delta (verdict → diagnostics) and advances the cursor past it
 * so the consumer is unstuck by construction. Named constant, not config, until
 * real usage says otherwise ("Do not relitigate").
 */
const MAX_ATTEMPTS = 3;

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

/** A complete NDJSON line that failed to parse — its bytes relative to the
 * start of the buffer passed to `parseComplete`, and the parse error. */
type CorruptLine = { byteStart: number; byteEnd: number; error: string };

/**
 * Parse the complete NDJSON records in `buffer` and report how many bytes were
 * consumed. A partial trailing line (no closing newline yet) is left unparsed
 * and its bytes are NOT counted — the cursor stops before it so a still-being-
 * written line is retried once complete (§5), never treated as an error.
 *
 * A corrupt COMPLETE line (unparseable JSON with a closing newline) is NOT an
 * error either (§5, issue #60): it is skipped, its byte range recorded in
 * `corrupt` so the caller can write a quarantine verdict, and parsing continues
 * with the remaining complete lines. The advancing cursor covers it — there is
 * no retry loop for bytes that will never parse.
 */
function parseComplete(buffer: string): {
  events: Array<Record<string, unknown>>;
  consumedBytes: number;
  corrupt: CorruptLine[];
} {
  const lastNewline = buffer.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No complete line yet — everything is a partial trailing line.
    return { events: [], consumedBytes: 0, corrupt: [] };
  }
  const complete = buffer.slice(0, lastNewline + 1);
  const events: Array<Record<string, unknown>> = [];
  const corrupt: CorruptLine[] = [];
  // Walk lines tracking each one's byte span within the buffer so a quarantine
  // verdict can name the exact range (+startOffset by the caller for absolute).
  let cursor = 0;
  for (const line of complete.split('\n')) {
    const byteStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1; // +1 for the '\n' delimiter
    if (line.length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch (err) {
      corrupt.push({
        byteStart,
        byteEnd: byteStart + Buffer.byteLength(line, 'utf8'),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { events, consumedBytes: Buffer.byteLength(complete, 'utf8'), corrupt };
}

function cursorPathFor(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'cursors', CONSUMER, `${sessionId}.json`);
}

function makeCursor(
  logFilePath: string,
  sessionId: string,
  byteOffset: number,
  lastRecordId: string | undefined,
  failedAttempts?: Cursor['failed_attempts'],
): Cursor {
  return {
    consumer: CONSUMER,
    log_name: `events/${sessionId}.ndjson`,
    file_path: logFilePath,
    byte_offset: byteOffset,
    ...(lastRecordId !== undefined ? { last_record_id: lastRecordId } : {}),
    ...(failedAttempts !== undefined ? { failed_attempts: failedAttempts } : {}),
    updated_at: new Date().toISOString(),
  };
}

/**
 * The [from, to] event-id range a note revision covers, or null if it carries no
 * range-bearing provenance. Prefers the explicit `event_range`; else derives the
 * closed range from the min/max of `event_ids`. Event IDs are ULIDs, so min/max
 * is a lexicographic sort — the same ordering the overlap check relies on.
 */
function provenancedRange(note: NoteRevision): { from: string; to: string } | null {
  const { event_range, event_ids } = note.provenance;
  if (event_range) {
    return { from: event_range.from_event_id, to: event_range.to_event_id };
  }
  if (event_ids && event_ids.length > 0) {
    const sorted = [...event_ids].sort();
    return { from: sorted[0], to: sorted[sorted.length - 1] };
  }
  return null;
}

/** Two closed ranges overlap iff each starts no later than the other ends. */
function rangesOverlap(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/**
 * Re-distill invariant by provenance (§5, roadmap item 9): a note already
 * provenanced over an overlapping event range in this session means this delta
 * was distilled before — a crash between `appendNote` and `advanceCursor`, or a
 * lost/corrupted cursor rewound to 0, is replaying it. Returns true iff such a
 * note exists, so the caller skips the append and just advances past the delta.
 *
 * ponytail: linear provenance scan; index by session_id when note logs get big.
 */
function alreadyProvenanced(
  dataDir: string,
  sessionId: string,
  delta: { from: string; to: string },
): boolean {
  for (const record of readAllNotes(dataDir) as NoteRecordLike[]) {
    if (record.kind !== 'note_revision') continue;
    const note = record as NoteRevision;
    if (note.provenance.session_id !== sessionId) continue;
    const covered = provenancedRange(note);
    if (covered && rangesOverlap(covered, delta)) return true;
  }
  return false;
}

/** Minimal shape for scanning the note log without asserting full NoteRecord. */
type NoteRecordLike = { kind?: string } & Partial<NoteRevision>;

/**
 * Read the distiller cursor, surviving a corrupted/unparseable cursor file. A
 * cursor is a recovery hint, not memory: a garbage cursor must never wedge the
 * pass (§5). On any read/parse failure, warn loudly on stderr and return null so
 * the caller starts from offset 0 and replays — the provenance guard
 * (`alreadyProvenanced`) makes that replay duplicate-free instead of catastrophic.
 */
function readCursorResilient(cursorPath: string): Cursor | null {
  try {
    return readCursor(cursorPath);
  } catch (err) {
    process.stderr.write(
      `librarian: distiller cursor ${cursorPath} is unreadable (${(err as Error).message}); ` +
        `treating as offset 0 and replaying (provenance guard prevents duplicates)\n`,
    );
    return null;
  }
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
 * duplicate note under a fresh id.
 *
 * Bounded retries + quarantine (§5, issue #60): a delta whose provider/parse
 * throws is retried on later runs up to `MAX_ATTEMPTS` total, the attempt count
 * riding on the cursor's `failed_attempts` (offset unmoved, non-zero exit each
 * time). The run that reaches `MAX_ATTEMPTS` writes a quarantine verdict to
 * diagnostics (naming the byte range a human resets the cursor to), advances the
 * cursor past the delta, and continues — the consumer is unstuck by
 * construction, exit 0. A corrupt COMPLETE line is quarantined immediately with
 * no retry loop (unparseable bytes never become parseable): the reader skips it,
 * writes a verdict, and processes the surrounding lines. The event log itself is
 * never rewritten — quarantine is verdict + cursor advance, nothing else (§4).
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

    const cursor = readCursorResilient(cursorPath);
    const startOffset = cursor?.byte_offset ?? 0;

    const fileBytes = fs.readFileSync(logFilePath);
    if (startOffset >= fileBytes.length) {
      // Nothing new since the last successful pass — the idempotent no-op path.
      continue;
    }

    const delta = fileBytes.subarray(startOffset).toString('utf8');
    const { events, consumedBytes, corrupt } = parseComplete(delta);

    // Corrupt complete lines are quarantined once — but ONLY when the cursor
    // actually advances past their bytes (§5): a delta whose valid remainder
    // keeps failing the provider stays at `startOffset` for retry, and writing
    // the corrupt verdict eagerly would re-emit it on every retry (a verdict
    // loop over bytes that will never parse). Deferring to the advance keeps it
    // exactly-once. `advancePast` bundles "write the corrupt verdicts, then
    // advance" so no advance-past-the-delta site can forget one.
    let corruptVerdictsWritten = false;
    const writeCorruptVerdicts = (): void => {
      if (corruptVerdictsWritten) return;
      corruptVerdictsWritten = true;
      for (const bad of corrupt) {
        writeDistillVerdict(diagnosticsDir, {
          record_class: 'diagnostic',
          verdict_id: makeVerdictId(),
          ts: new Date().toISOString(),
          session_id: sessionId,
          decision: 'quarantined',
          reason: `unparseable event line at bytes ${startOffset + bad.byteStart}..${startOffset + bad.byteEnd}: ${bad.error}`,
          counts: { events: 0, prompts: 0, write_tools: 0, salience_hints: 0 },
          quarantine: {
            file_path: logFilePath,
            byte_start: startOffset + bad.byteStart,
            byte_end: startOffset + bad.byteEnd,
            attempts: null,
            last_error: bad.error,
          },
        });
      }
    };
    const advancePast = (offset: number, lastId: string | undefined): void => {
      writeCorruptVerdicts();
      advanceCursor(cursorPath, makeCursor(logFilePath, sessionId, offset, lastId));
    };

    if (events.length === 0) {
      if (corrupt.length > 0) {
        // Only corrupt line(s) in this delta — advance past them so the cursor
        // is not wedged re-reading bytes that will never parse.
        advancePast(startOffset + consumedBytes, undefined);
      }
      // Otherwise only a partial trailing line — leave the cursor put, retry later.
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
      advancePast(newOffset, lastRecordId);
      continue;
    }

    // Re-distill invariant (§5, roadmap item 9): if a note already covers an
    // overlapping event range for this session, this delta was distilled before
    // (crash in the appendNote→advanceCursor window, or a rewound/corrupt cursor
    // replaying from 0). Skip the second note; just advance past the delta.
    const deltaFrom = events[0].event_id as string;
    const deltaTo = lastRecordId ?? deltaFrom;
    if (alreadyProvenanced(dataDir, sessionId, { from: deltaFrom, to: deltaTo })) {
      const verdict: DistillVerdict = {
        record_class: 'diagnostic',
        verdict_id: makeVerdictId(),
        ts: new Date().toISOString(),
        session_id: sessionId,
        decision: 'skipped',
        reason: 'already_provenanced',
        counts,
      };
      writeDistillVerdict(diagnosticsDir, verdict);
      advancePast(newOffset, lastRecordId);
      continue;
    }

    // Eligible: try to distill. Any throw (provider, JSON parse, or the origin
    // guard) is a failure that participates in the bounded-retry budget (§5,
    // issue #60). Prior attempts on THIS same offset carry on the cursor; a
    // fresh offset starts the count at zero.
    try {
      // Origin is denormalized from the events' resource.agent (§5).
      const origin = ((events[0].resource ?? {}) as Record<string, unknown>).agent;
      if (typeof origin !== 'string' || origin.length === 0) {
        throw new Error(`session ${sessionId}: missing resource.agent on first delta event`);
      }

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

      // Advance only after the note is durably appended (§5 advance-after-success),
      // clearing failed_attempts — a fresh range starts its count at zero.
      advancePast(newOffset, lastRecordId);
    } catch (err) {
      const lastError = err instanceof Error ? err.message : String(err);
      const priorCount =
        cursor?.failed_attempts?.byte_offset === startOffset ? cursor.failed_attempts.count : 0;
      const attempt = priorCount + 1;

      if (attempt < MAX_ATTEMPTS) {
        // Under budget: record the attempt on the cursor (offset UNMOVED) and
        // rethrow so the CLI exits non-zero and the next run retries this range.
        // No corrupt-line verdicts here — the cursor does not advance past them,
        // so they are emitted once, on the run that finally advances the delta.
        advanceCursor(
          cursorPath,
          makeCursor(logFilePath, sessionId, startOffset, cursor?.last_record_id, {
            byte_offset: startOffset,
            count: attempt,
            last_error: lastError,
          }),
        );
        throw err;
      }

      // Budget exhausted: quarantine. Write a verdict naming the byte range a
      // human must reset the cursor to, advance PAST the delta (clearing
      // failed_attempts), and continue with remaining sessions — exit 0.
      writeDistillVerdict(diagnosticsDir, {
        record_class: 'diagnostic',
        verdict_id: makeVerdictId(),
        ts: new Date().toISOString(),
        session_id: sessionId,
        decision: 'quarantined',
        reason: `gave up after ${attempt} attempts on bytes ${startOffset}..${newOffset}: ${lastError}`,
        counts,
        quarantine: {
          file_path: logFilePath,
          byte_start: startOffset,
          byte_end: newOffset,
          attempts: attempt,
          last_error: lastError,
        },
      });
      advancePast(newOffset, lastRecordId);
    }
  }
}
