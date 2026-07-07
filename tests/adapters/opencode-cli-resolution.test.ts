import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLibrarianArgv, resolveMachineId } from '../../adapters/opencode/plugin.ts';
import { readAll } from '../../src/log/ndjson.ts';

/**
 * OpenCode adapter — CLI-resolution seam (the PATH-hardening regression).
 *
 * The plugin used to invoke `spawnSync('librarian', …)` by bare name, trusting $PATH.
 * OpenCode is a native binary whose plugin child inherits an unpredictable PATH (terminal
 * vs desktop vs login service vs package manager), so that seam broke in the smoke test
 * and had zero automated coverage. `resolveLibrarianArgv()` replaces it with an explicit
 * resolution order — LIBRARIAN_BIN → ~/.librarian/config.json `bin` → the built dist/cli.js
 * next to the plugin → bare `librarian` — and this file is that seam's coverage.
 *
 * Style matches the rest of tests/: node --test, no mocks, plain temp dirs, and a real
 * spawned CLI for the end-to-end leg. It exercises the REAL exported resolver (not a
 * reimplementation), then proves the argv it produces actually delivers an event.
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run the resolver with a controlled env: an explicit LIBRARIAN_BIN, HOME (which
 *  os.homedir() honors), and MACHINE_ID_PATH, restoring all afterward so tests do not
 *  leak into each other or touch the real ~/.librarian. A value of null deletes that
 *  variable. */
function withEnv<T>(
  env: { LIBRARIAN_BIN?: string | null; HOME?: string | null; MACHINE_ID_PATH?: string | null },
  fn: () => T,
): T {
  const prev = {
    LIBRARIAN_BIN: process.env.LIBRARIAN_BIN,
    HOME: process.env.HOME,
    MACHINE_ID_PATH: process.env.MACHINE_ID_PATH,
  };
  const apply = (key: 'LIBRARIAN_BIN' | 'HOME' | 'MACHINE_ID_PATH', value: string | null | undefined) => {
    if (value === undefined) return; // key not mentioned — leave as-is
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  };
  const restore = (key: 'LIBRARIAN_BIN' | 'HOME' | 'MACHINE_ID_PATH', value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  try {
    apply('LIBRARIAN_BIN', env.LIBRARIAN_BIN);
    apply('HOME', env.HOME);
    apply('MACHINE_ID_PATH', env.MACHINE_ID_PATH);
    return fn();
  } finally {
    restore('LIBRARIAN_BIN', prev.LIBRARIAN_BIN);
    restore('HOME', prev.HOME);
    restore('MACHINE_ID_PATH', prev.MACHINE_ID_PATH);
  }
}

/** Point HOME at a fresh temp dir and write ~/.librarian/config.json with the given
 *  object. Returns the temp HOME. */
function homeWithConfig(config: unknown): string {
  const home = tempDir('opencode-cli-home-');
  fs.mkdirSync(path.join(home, '.librarian'), { recursive: true });
  fs.writeFileSync(path.join(home, '.librarian', 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return home;
}

/** Point HOME at a fresh temp dir and write ~/.librarian/machine-id with the given id.
 *  Returns the temp HOME. Mirrors the file the real `librarian machine-id` persists. */
function homeWithMachineId(id: string): string {
  const home = tempDir('opencode-mid-home-');
  fs.mkdirSync(path.join(home, '.librarian'), { recursive: true });
  fs.writeFileSync(path.join(home, '.librarian', 'machine-id'), id + '\n');
  return home;
}

/** A LIBRARIAN_BIN guaranteed to fail to spawn, so any resolved machine id must have come
 *  from a file rung, never the CLI. */
const UNRUNNABLE_BIN = '/nonexistent/librarian-cli-that-cannot-run';

test('resolution: LIBRARIAN_BIN pointing at a .js runs it under the current runtime (process.execPath)', () => {
  const argv = withEnv({ LIBRARIAN_BIN: '/opt/librarian/dist/cli.js', HOME: tempDir('empty-home-') }, () =>
    resolveLibrarianArgv(),
  );
  assert.deepEqual(argv, [process.execPath, '/opt/librarian/dist/cli.js']);
});

test('resolution: LIBRARIAN_BIN pointing at a non-.js executable is spawned directly (no runtime prefix)', () => {
  const argv = withEnv({ LIBRARIAN_BIN: '/usr/local/bin/librarian', HOME: tempDir('empty-home-') }, () =>
    resolveLibrarianArgv(),
  );
  assert.deepEqual(argv, ['/usr/local/bin/librarian']);
});

test('resolution: ~/.librarian/config.json `bin` is used when LIBRARIAN_BIN is unset', () => {
  const home = homeWithConfig({ bin: '/configured/dist/cli.js' });
  const argv = withEnv({ LIBRARIAN_BIN: null, HOME: home }, () => resolveLibrarianArgv());
  assert.deepEqual(argv, [process.execPath, '/configured/dist/cli.js']);
});

test('resolution: LIBRARIAN_BIN wins over a config `bin` (env is the highest rung)', () => {
  const home = homeWithConfig({ bin: '/configured/dist/cli.js' });
  const argv = withEnv({ LIBRARIAN_BIN: '/override/librarian', HOME: home }, () => resolveLibrarianArgv());
  assert.deepEqual(argv, ['/override/librarian'], 'the env override must take precedence over config');
});

test('resolution: config with other keys but no `bin` falls through (does not crash, does not invent a bin)', () => {
  // No bin key, and HOME has no dist/cli.js next to a plugin under it, so this falls all
  // the way to the bare-name rung — proving a partial config never throws.
  const home = homeWithConfig({ somethingElse: true });
  const argv = withEnv({ LIBRARIAN_BIN: null, HOME: home }, () => resolveLibrarianArgv());
  // The repo's own dist/cli.js (rung 3, resolved relative to the real plugin file) may or
  // may not exist depending on whether `npm run build` has run; either the built path or
  // the bare name is acceptable here. What must hold: it never picks up a phantom bin.
  assert.ok(
    (argv.length === 2 && argv[1].endsWith(path.join('dist', 'cli.js'))) ||
      (argv.length === 1 && argv[0] === 'librarian'),
    `expected the built dist/cli.js or bare 'librarian', got ${JSON.stringify(argv)}`,
  );
});

test('resolution: malformed config JSON is tolerated (falls through, never throws)', () => {
  const home = tempDir('opencode-cli-home-bad-');
  fs.mkdirSync(path.join(home, '.librarian'), { recursive: true });
  fs.writeFileSync(path.join(home, '.librarian', 'config.json'), '{ this is not json ');
  const argv = withEnv({ LIBRARIAN_BIN: null, HOME: home }, () => resolveLibrarianArgv());
  // Same acceptable outcomes as the partial-config case: built path or bare name.
  assert.ok(
    (argv.length === 2 && argv[1].endsWith(path.join('dist', 'cli.js'))) ||
      (argv.length === 1 && argv[0] === 'librarian'),
    `malformed config must fall through, got ${JSON.stringify(argv)}`,
  );
});

test('end-to-end: an event handed to the resolved argv (via config `bin`) lands in the per-session log', (t) => {
  // The actual regression the smoke test caught: resolve the CLI the way the plugin does,
  // then prove the resolved argv delivers a real event through `librarian collect`. We
  // point config `bin` at the BUILT dist/cli.js — exactly what the setup script writes and
  // what the resolver runs via process.execPath. If the CLI has not been built (a clean
  // checkout running `npm test` without `npm run build`), skip the spawn leg rather than
  // assert against a missing artifact; the resolution-order tests above still fully cover
  // the seam logic.
  const distCli = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js');
  if (!fs.existsSync(distCli)) {
    t.skip('dist/cli.js not built (run `npm run build`); resolution-order tests still cover the seam');
    return;
  }

  const home = homeWithConfig({ bin: distCli });
  const argv = withEnv({ LIBRARIAN_BIN: null, HOME: home }, () => resolveLibrarianArgv());
  assert.deepEqual(argv, [process.execPath, distCli], 'config .js bin should resolve to [runtime, dist/cli.js]');

  const dataDir = tempDir('opencode-cli-e2e-');
  const sessionId = 'opencode-cli-resolution-session';
  const event = {
    schema_version: 1,
    type: 'session',
    event_id: '01J8X7QK45Y0A6S9P7T1U6W8XX',
    ts: '2026-07-07T00:00:00.000Z',
    resource: { agent: 'opencode', machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX', cwd: '/repo' },
    context: { session_id: sessionId, cwd: '/repo' },
    action: 'start',
  };

  const [cmd, ...prefix] = argv;
  const result = spawnSync(cmd, [...prefix, 'collect', '--data-dir', dataDir], {
    input: JSON.stringify(event) + '\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `collect via the resolved argv should exit 0; stderr: ${result.stderr}`);

  const logFilePath = path.join(dataDir, 'events', `${sessionId}.ndjson`);
  assert.ok(fs.existsSync(logFilePath), 'the event must land in the per-session log');
  const persisted = readAll(logFilePath) as Array<Record<string, unknown>>;
  assert.equal(persisted.length, 1, 'exactly one event should be appended');
  assert.equal(persisted[0].event_id, event.event_id, 'the delivered event must round-trip');
});

/**
 * Machine-id resolution (§10.1, §11) — the "could not resolve machine id" regression.
 *
 * The plugin used to reach the persisted machine id ONLY through the MACHINE_ID_PATH env
 * var; with that unset (OpenCode's normal environment) it fell straight to spawning the
 * CLI, which is exactly the fragile PATH/spawn seam we are trying to avoid. So even with a
 * perfectly good `~/.librarian/machine-id` on disk, a launch that could not locate/run the
 * CLI surfaced a scary "could not resolve machine id" error. The fix: read the default
 * persisted file directly. These tests pin that behavior by making the CLI un-runnable —
 * so a correct id proves it came from the file, not a subprocess.
 */

test('machine-id: the persisted ~/.librarian/machine-id is read directly, without spawning the CLI', () => {
  const home = homeWithMachineId('01J8X7QK3VZ9R4M2N6P0S5T7WX');
  const id = withEnv({ HOME: home, MACHINE_ID_PATH: null, LIBRARIAN_BIN: UNRUNNABLE_BIN }, () =>
    resolveMachineId(),
  );
  assert.equal(
    id,
    '01J8X7QK3VZ9R4M2N6P0S5T7WX',
    'the id must come from the persisted file even when the CLI cannot run',
  );
});

test('machine-id: MACHINE_ID_PATH env, when set to a non-empty file, wins over the default path', () => {
  // Default path holds one id; the env override points at a different file with another.
  const home = homeWithMachineId('01DEFAULTDEFAULTDEFAULTDEF');
  const overridePath = path.join(tempDir('opencode-mid-override-'), 'mid');
  fs.writeFileSync(overridePath, '01OVERRIDEOVERRIDEOVERRIDE\n');
  const id = withEnv({ HOME: home, MACHINE_ID_PATH: overridePath, LIBRARIAN_BIN: UNRUNNABLE_BIN }, () =>
    resolveMachineId(),
  );
  assert.equal(id, '01OVERRIDEOVERRIDEOVERRIDE', 'the env override path must take precedence');
});

test('machine-id: an empty MACHINE_ID_PATH file falls through to the default persisted path', () => {
  const home = homeWithMachineId('01FALLBACKTOTHEDEFAULTFILE');
  const blankPath = path.join(tempDir('opencode-mid-blank-'), 'mid');
  fs.writeFileSync(blankPath, '   \n'); // whitespace only — treated as absent
  const id = withEnv({ HOME: home, MACHINE_ID_PATH: blankPath, LIBRARIAN_BIN: UNRUNNABLE_BIN }, () =>
    resolveMachineId(),
  );
  assert.equal(id, '01FALLBACKTOTHEDEFAULTFILE', 'a blank override file must not shadow the default');
});

test('machine-id: no persisted file and an un-runnable CLI yields a non-empty ephemeral id, never a throw', () => {
  // Empty HOME (no machine-id file), env unset, CLI cannot run: the last rung is a UUID.
  const home = tempDir('opencode-mid-empty-');
  let id: string | undefined;
  assert.doesNotThrow(() => {
    id = withEnv({ HOME: home, MACHINE_ID_PATH: null, LIBRARIAN_BIN: UNRUNNABLE_BIN }, () =>
      resolveMachineId(),
    );
  }, 'resolution must never throw — it must degrade to an ephemeral id');
  assert.ok(id && id.length > 0, 'the fallback id must be non-empty so events still carry a machine_id');
});
