import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';

/**
 * Single-writer lock for log consumers (spec §5 "Durability & safety":
 * "Detached workers: explicit lock ownership, stale-lock recovery (PID/token
 * checks, timeout)"). Two concurrent `librarian distill` runs over one data dir
 * race the same per-session cursors — both read a delta before either advances,
 * both append a note. One lock around the whole run closes that.
 *
 * v1 is acquire/release around an in-process `runDistill`; the PID/token
 * machinery here is the part that survives when a detached child arrives (§3).
 * Deliberately NOT a generic lock manager — one acquire/release pair, one call
 * site today (issue #59 "Do not relitigate").
 */

/** On-disk lock body. `token` proves ownership; only its holder may release. */
type LockFile = {
  pid: number;
  token: string;
  acquired_at: string;
};

export type Lock = {
  /** The ULID minted for this acquisition; matched on release. */
  token: string;
  /** Delete the lock file, but only if it still carries our token. */
  release: () => void;
};

export type AcquireOptions = {
  /** A lock whose `acquired_at` is older than this (ms) is stale — take over. */
  staleMs: number;
};

/**
 * A held lock is stale when its owner is gone or its grip is too old:
 *   - PID dead: `process.kill(pid, 0)` throws `ESRCH` (probe, sends no signal).
 *   - Timeout: `acquired_at` older than `staleMs`, regardless of PID (covers a
 *     wedged-but-live worker and a PID that got recycled to another process).
 * A malformed body counts as stale — a lock we can't reason about is not one
 * worth honouring.
 */
function isStale(raw: string, staleMs: number, now: number): boolean {
  let body: LockFile;
  try {
    body = JSON.parse(raw) as LockFile;
  } catch {
    return true;
  }
  if (typeof body.pid !== 'number' || typeof body.acquired_at !== 'string') {
    return true;
  }

  const acquiredAt = Date.parse(body.acquired_at);
  if (Number.isNaN(acquiredAt) || now - acquiredAt >= staleMs) {
    return true;
  }

  try {
    process.kill(body.pid, 0);
    return false; // live and fresh
  } catch (err) {
    // ESRCH → no such process → stale. EPERM → alive but not ours → fresh.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Try to take `lockPath`. Returns a {@link Lock} on success, or `null` when a
 * live, fresh worker already holds it.
 *
 * Atomicity rests on `fs.writeFileSync(..., { flag: 'wx' })`: an exclusive
 * create that throws `EEXIST` if the file exists, so of N racing acquirers
 * exactly one create wins. On `EEXIST` we inspect the incumbent: fresh → yield
 * (`null`); stale → `unlink` it and retry the exclusive create ONCE. Losing
 * that retry (another worker recovered the same stale lock first) also yields
 * `null` — never two winners.
 */
export function acquireLock(lockPath: string, options: AcquireOptions): Lock | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = ulid();
  const body = JSON.stringify(
    { pid: process.pid, token, acquired_at: new Date().toISOString() } satisfies LockFile,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, body, { flag: 'wx' });
      return { token, release: () => release(lockPath, token) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    // Held. Read the incumbent; a race may have deleted it between the failed
    // create and this read (ENOENT) — treat that as "gone", loop to retry.
    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw err;
    }

    if (!isStale(raw, options.staleMs, Date.now())) {
      return null; // someone live and fresh owns it
    }

    // Stale: drop it and retry the exclusive create. unlink ENOENT means another
    // recoverer beat us to the delete — fine, the retry create will decide.
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  return null;
}

/**
 * Delete the lock file, but ONLY if it still carries `token`. A worker never
 * deletes another worker's lock: if the file is gone, holds a different token
 * (we were declared stale and taken over), or is unreadable, this is a no-op.
 */
function release(lockPath: string, token: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }

  let body: LockFile;
  try {
    body = JSON.parse(raw) as LockFile;
  } catch {
    return; // not a lock we can prove is ours — leave it
  }

  if (body.token !== token) {
    return; // someone else's lock now — never delete it
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}
