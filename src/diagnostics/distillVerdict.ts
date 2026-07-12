import path from 'node:path';
import { ulid } from 'ulid';
import { appendRecord } from '../log/ndjson.ts';

/**
 * Distill verdict (§8 "Distill verdicts"): one record per session delta the
 * `distill` command considered, naming what it decided — distilled, duplicate,
 * skipped, or quarantined (retries exhausted / unparseable line), and why. The counts that
 * drove the skip heuristic (§3) are kept so a verdict is self-explaining without
 * re-reading the event log; a quarantine verdict additionally carries the byte
 * range a human needs to re-attempt.
 *
 * Structural isolation (§8): these records live under the diagnostics dir
 * (`~/.librarian/diagnostics/…` via `paths.ts`), NEVER the data/note log.
 * Diagnostics are deletable; memory is sacred. That boundary is enforced by
 * which directory this function writes to, mirroring `injectionTrace.ts`.
 *
 * Poison-pill property (§8): `record_class: "diagnostic"` is deliberately a
 * shape that `validateEvent()` HARD-REJECTS. If a verdict ever leaked into the
 * collector it would be quarantined by construction — self-observation cannot
 * silently re-enter memory.
 */
export type DistillVerdict = {
  record_class: 'diagnostic';
  verdict_id: string;
  ts: string;
  session_id: string;
  decision: 'distilled' | 'duplicate' | 'skipped' | 'noop' | 'quarantined' | 'rejected';
  reason: string;
  counts: {
    events: number;
    prompts: number;
    write_tools: number;
    salience_hints: number;
  };
  note_id?: string;
  verify?: {
    errors: string[];
    reason: string;
    attempts: 1 | 2;
  };
  /**
   * Quarantine breadcrumb (§5, issue #60): present only on a `quarantined`
   * verdict. Names the exact byte range in the (sacred, untouched) event log a
   * human must reset the cursor to in order to re-attempt, the attempt count
   * that exhausted the retry budget (or `null` for an unparseable line, which
   * gets no retry loop), and the last error that caused the give-up. The bytes
   * themselves are never moved or annotated — this verdict IS the recovery.
   */
  quarantine?: {
    file_path: string;
    byte_start: number;
    byte_end: number;
    attempts: number | null;
    last_error: string;
  };
};

/** Monthly segment path, mirroring the note log and injection trace: a verdict
 * lands in the file for the month of its `ts`. */
function segmentPath(diagnosticsDir: string, verdict: DistillVerdict): string {
  const yearMonth = verdict.ts.slice(0, 7);
  return path.join(diagnosticsDir, 'distill', `${yearMonth}.ndjson`);
}

/**
 * Append a distill verdict to `<diagnosticsDir>/distill/<yyyy-mm>.ndjson` using
 * the shared append machinery. No return value: fire-and-forget diagnostic
 * write.
 */
export function writeDistillVerdict(diagnosticsDir: string, verdict: DistillVerdict): void {
  appendRecord(segmentPath(diagnosticsDir, verdict), verdict);
}

/** Mint a `verdict_id`. Reuses the one `ulid` helper for the whole codebase. */
export function makeVerdictId(): string {
  return ulid();
}
