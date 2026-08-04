import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Integration tests for the automatic drain trigger (#170): drive the real
// `librarian hook claude-code` entry with real boundary payloads and observe the
// child it spawns. The `librarian` the hook resolves is a bash stub that logs its
// own invocation, so what is asserted here is the TRIGGER's behavior — fires on a
// boundary, detaches, debounces, stays silent — not drain's, which has its own
// tests (`tests/cli/drain.test.ts`).
//
// HOME is redirected per test so the debounce stamp lands in a throwaway
// `~/.librarian/cache` and never in the developer's real one.

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'claude-code');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The native payload half of a mapper fixture — the same JSON Claude Code writes to stdin. */
function fixturePayload(name: string): Record<string, unknown> {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as { native: Record<string, unknown> };
  return fixture.native;
}

type Stub = { bin: string; log: string };

/**
 * A `librarian` stub. `collect` is a silent no-op (this suite asserts on the drain
 * spawn, not on collection) and `drain` appends one line to the log after sleeping
 * `sleepSeconds` — the sleep is what makes detachment observable: if the hook waited
 * on its child, the line would exist by the time spawnSync returns.
 */
function makeStub(sleepSeconds = 0): Stub {
  const dir = tempDir('auto-drain-bin-');
  const log = path.join(dir, 'invocations.log');
  const script = path.join(dir, 'librarian');
  fs.writeFileSync(script, `#!/usr/bin/env bash
if [ "\${1:-}" = "drain" ]; then
  sleep ${sleepSeconds}
  echo "drain $$" >> ${JSON.stringify(log)}
fi
exit 0
`);
  fs.chmodSync(script, 0o755);
  return { bin: script, log };
}

function drainCount(log: string): number {
  try {
    return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // never invoked
  }
}

/** Run the real hook entry with an isolated HOME and a resolved `librarian`. */
function runHook(payload: Record<string, unknown>, home: string, bin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'hook', 'claude-code'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, LIBRARIAN_BIN: bin },
  });
}

/** Block this thread without a child process or a timer callback. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Poll until the predicate holds or the budget runs out — the child is asynchronous by design. */
function waitFor(predicate: () => boolean, budgetMs = 10_000): boolean {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    sleep(100);
  }
  return predicate();
}

/** Plant the debounce stamp the hook reads, as a drain that ran `msAgo` milliseconds ago. */
function writeStamp(home: string, msAgo: number): void {
  const cache = path.join(home, '.librarian', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'last-drain'), String(Date.now() - msAgo));
}

test('auto-drain: a session-end boundary spawns a drain the hook does not wait for', () => {
  const home = tempDir('auto-drain-home-');
  const stub = makeStub(1);

  const result = runHook(fixturePayload('08-session-end.json'), home, stub.bin);

  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'the hook must stay silent on stdout');
  // The stub's drain sleeps a second: the parent has already exited, so nothing
  // is logged yet. This is the detachment assertion — it fails if the hook waits.
  assert.equal(drainCount(stub.log), 0, 'the hook must not block on the drain child');
  assert.ok(waitFor(() => drainCount(stub.log) === 1), 'the detached drain must still complete after the hook exits');
});

test('auto-drain: a non-boundary event spawns nothing', () => {
  const home = tempDir('auto-drain-home-none-');
  const stub = makeStub();

  const result = runHook(fixturePayload('11-post-tool-use-todowrite-partial.json'), home, stub.bin);

  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);
  // A partial todo list closes nothing, so there is no boundary and no reason to drain.
  assert.ok(!waitFor(() => drainCount(stub.log) > 0, 1_500), 'a non-boundary event must not trigger a drain');
});

test('auto-drain: a burst of semantic boundaries is debounced to one drain', () => {
  const home = tempDir('auto-drain-home-burst-');
  const stub = makeStub();
  const complete = fixturePayload('10-post-tool-use-todowrite-complete.json');
  const commit = fixturePayload('03-post-tool-use-bash-git-commit.json');

  for (const payload of [complete, commit, complete, commit]) {
    assert.equal(runHook(payload, home, stub.bin).status, 0);
  }

  assert.ok(waitFor(() => drainCount(stub.log) >= 1), 'the first boundary must trigger a drain');
  // Give any un-debounced sibling time to land before counting.
  sleep(1_000);
  assert.equal(drainCount(stub.log), 1, 'four boundaries in quick succession must drain once, not four times');
});

test('auto-drain: a stamp from the future does not wedge the trigger', () => {
  const home = tempDir('auto-drain-home-skew-');
  const stub = makeStub();
  // A clock that jumped forward and was corrected leaves a stamp ahead of now. Read naively it
  // suppresses every semantic boundary until real time catches up — a wedge, not a debounce.
  writeStamp(home, -24 * 60 * 60 * 1_000);

  assert.equal(runHook(fixturePayload('03-post-tool-use-bash-git-commit.json'), home, stub.bin).status, 0);

  assert.ok(waitFor(() => drainCount(stub.log) === 1), 'a future-dated stamp must not suppress the drain');
});

test('auto-drain: a terminal boundary bypasses the debounce', () => {
  const home = tempDir('auto-drain-home-terminal-');
  const stub = makeStub();

  // A commit right before quitting is the common case; if it swallowed the session-end
  // drain, the session's note would wait on the scheduled net instead of appearing now.
  assert.equal(runHook(fixturePayload('03-post-tool-use-bash-git-commit.json'), home, stub.bin).status, 0);
  assert.ok(waitFor(() => drainCount(stub.log) === 1), 'the commit boundary must trigger a drain');

  assert.equal(runHook(fixturePayload('08-session-end.json'), home, stub.bin).status, 0);
  assert.ok(waitFor(() => drainCount(stub.log) === 2), 'session end must drain even inside the debounce window');
});

test('auto-drain: an unresolvable librarian keeps the hook silent and exit 0', () => {
  const home = tempDir('auto-drain-home-missing-');
  const missing = path.join(tempDir('auto-drain-missing-bin-'), 'librarian');

  const result = runHook(fixturePayload('08-session-end.json'), home, missing);

  assert.equal(result.status, 0, `hook safety: exit 0 even with no librarian; stderr: ${result.stderr}`);
  assert.equal(result.stdout, '', 'hook safety: nothing on stdout');
  // Not asserted: the stderr line. Node reports a spawn failure asynchronously, and on this
  // path the hook has already exited 0 — the listener exists for the hooks that live longer
  // (an inject-bearing prompt), and its absence here is the contract working, not a leak.
});
