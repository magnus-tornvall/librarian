import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { appendRecord, readAll } from '../log/ndjson.ts';

/**
 * Injection trace (§8): one record per `recall()`/injection, capturing what the
 * ranker decided — the query, every candidate with its raw and post-weight
 * scores plus any cut reason, which records actually shipped, how far the index
 * was current (`indexed_through`), and a snapshot of the scoring config.
 *
 * Structural isolation (§8, task 008): these records live under
 * `~/.librarian/diagnostics/` (via `paths.ts`, task 009) — NEVER the vault, NEVER
 * the note/event log. Diagnostics are deletable; memory is sacred. That boundary
 * is enforced by which directory this function writes to, not by policy.
 *
 * Poison-pill property (§8): `record_class: "diagnostic"` is deliberately a shape
 * that `validateEvent()` (task 014) HARD-REJECTS. If a trace ever leaked into the
 * collector, it would be quarantined by construction — self-observation cannot
 * silently re-enter memory. `tests/diagnostics/injectionTrace.test.ts` proves
 * this cross-module (feeds a real trace to `validateEvent` and asserts it throws),
 * so the invariant is verified, not merely documented.
 */
export type InjectionTrace = {
  record_class: 'diagnostic';
  injection_id: string;
  path?: 'pull' | 'push';
  ts: string;
  query: string;
  candidates: Array<{
    note_id: string;
    raw_score: number;
    post_weight_score: number;
    cut_reason?: 'below_floor' | 'budget' | 'scope_mismatch' | 'superseded' | 'ttl_expired';
  }>;
  shipped_note_ids: string[];
  indexed_through: string;
  embedding: 'ok' | 'timeout' | 'error' | 'disabled';
  config_snapshot: unknown;
};

/** Monthly segment path, mirroring the note log (task 019): diagnostics reuse
 * "the same NDJSON/cursor machinery" per §8, so a trace lands in the file for
 * the month of its `ts`. */
function segmentPath(diagnosticsDir: string, trace: InjectionTrace): string {
  const yearMonth = trace.ts.slice(0, 7);
  return path.join(diagnosticsDir, 'injections', `${yearMonth}.ndjson`);
}

/**
 * Append an injection trace to `<diagnosticsDir>/injections/<yyyy-mm>.ndjson`
 * using the shared append machinery (task 011). No return value: fire-and-forget
 * diagnostic write.
 */
export function writeInjectionTrace(diagnosticsDir: string, trace: InjectionTrace): void {
  appendRecord(segmentPath(diagnosticsDir, trace), trace);
}

export function readInjectionTraces(diagnosticsDir: string): InjectionTrace[] {
  const injectionsDir = path.join(diagnosticsDir, 'injections');
  if (!fs.existsSync(injectionsDir)) {
    return [];
  }
  // ponytail: O(n) scan is fine for deletable diagnostics segments; add an id index only if this gets slow.
  return fs
    .readdirSync(injectionsDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .flatMap((name) => readAll(path.join(injectionsDir, name)) as InjectionTrace[]);
}

/**
 * Mint an `injection_id`. Reuses the `ulid` package task 018 settled on — one
 * ULID helper for the whole codebase, not a second hand-rolled generator.
 */
export function makeInjectionId(): string {
  return ulid();
}
