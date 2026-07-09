import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../../src/log/lock.ts';

// Integration tests for the single-writer lock (spec §5, issue #59). Real temp
// dirs, real files — the lock's whole job is on-disk atomicity and recovery, so
// nothing here is mocked.

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function lockPath(dir: string): string {
  return path.join(dir, 'locks', 'distiller.lock');
}

function readLock(p: string): { pid: number; token: string; acquired_at: string } {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** A PID guaranteed dead: spawn a trivial process, wait for it, reuse its pid. */
function deadPid(): number {
  const r = spawnSync('node', ['-e', 'process.exit(0)']);
  return r.pid!;
}

const STALE_MS = 60_000;

test('lock: exclusive acquisition — a second acquire on a fresh live lock returns null', () => {
  const dir = tempDir('lock-exclusive-');
  const p = lockPath(dir);

  const first = acquireLock(p, { staleMs: STALE_MS });
  assert.ok(first, 'the first acquire should succeed');

  const second = acquireLock(p, { staleMs: STALE_MS });
  assert.equal(second, null, 'a second acquire on a fresh live lock must return null');

  // The file still belongs to the first holder — untouched by the failed second.
  assert.equal(readLock(p).token, first!.token, 'the lock body must still carry the first token');
});

test('lock: the on-disk body records pid, a ULID token, and acquired_at', () => {
  const dir = tempDir('lock-body-');
  const p = lockPath(dir);

  const lock = acquireLock(p, { staleMs: STALE_MS });
  assert.ok(lock);
  const body = readLock(p);
  assert.equal(body.pid, process.pid, 'pid must be the acquiring process');
  assert.equal(body.token, lock!.token, 'the returned token must match the file');
  assert.match(body.token, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'token must be a ULID');
  assert.ok(!Number.isNaN(Date.parse(body.acquired_at)), 'acquired_at must be an ISO timestamp');
});

test('lock: a stale lock with a dead PID is recovered — acquire succeeds with a new token', () => {
  const dir = tempDir('lock-deadpid-');
  const p = lockPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  // A held lock whose owner PID is dead but whose acquired_at is RECENT: only the
  // PID check can classify it stale, isolating that branch from the timeout one.
  const dead = deadPid();
  const staleToken = 'STALE00000000000000000000A';
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: dead, token: staleToken, acquired_at: new Date().toISOString() }),
  );

  const lock = acquireLock(p, { staleMs: STALE_MS });
  assert.ok(lock, 'a dead-PID lock must be recovered');
  assert.notEqual(lock!.token, staleToken, 'recovery must mint a fresh token');
  assert.equal(readLock(p).token, lock!.token, 'the file must now carry the new token');
});

test('lock: a timeout-stale lock (old acquired_at, any PID) is recovered', () => {
  const dir = tempDir('lock-timeout-');
  const p = lockPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  // acquired_at older than staleMs, but PID is THIS live process — so only the
  // timeout branch can classify it stale, isolating it from the dead-PID branch.
  const old = new Date(Date.now() - STALE_MS - 1_000).toISOString();
  const staleToken = 'STALE00000000000000000000B';
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, token: staleToken, acquired_at: old }));

  const lock = acquireLock(p, { staleMs: STALE_MS });
  assert.ok(lock, 'a timed-out lock must be recovered even when its PID is live');
  assert.notEqual(lock!.token, staleToken, 'recovery must mint a fresh token');
});

test('lock: release() refuses a foreign token — the file is left untouched', () => {
  const dir = tempDir('lock-foreign-');
  const p = lockPath(dir);

  // Holder A owns the lock. Forge a release with a token that isn't A's.
  const a = acquireLock(p, { staleMs: STALE_MS });
  assert.ok(a);
  const before = fs.readFileSync(p, 'utf8');

  // Simulate a foreign releaser by acquiring a second (failing) lock object is
  // not possible; instead assert A's release only fires on A's token. First,
  // prove a mismatched token is a no-op by hand-writing a different body then
  // calling A.release() — A's token no longer matches, so the file must survive.
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: process.pid, token: 'OTHER0000000000000000000ZZ', acquired_at: new Date().toISOString() }),
  );
  a!.release();
  assert.ok(fs.existsSync(p), 'release must not delete a lock carrying a foreign token');

  // And A releasing its OWN token deletes the file. Restore A's body, release.
  fs.writeFileSync(p, before);
  a!.release();
  assert.equal(fs.existsSync(p), false, 'release must delete the file when the token matches');
});

test('lock: release is idempotent and safe when the file is already gone', () => {
  const dir = tempDir('lock-gone-');
  const p = lockPath(dir);
  const lock = acquireLock(p, { staleMs: STALE_MS });
  assert.ok(lock);
  lock!.release();
  assert.doesNotThrow(() => lock!.release(), 'a second release must be a no-op, not a throw');
});
