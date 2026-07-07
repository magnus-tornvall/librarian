import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLibrarianArgv } from '../../adapters/opencode/plugin.ts';
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

/** Run the resolver with a controlled env: an explicit LIBRARIAN_BIN and HOME (which
 *  os.homedir() honors), restoring both afterward so tests do not leak into each other or
 *  touch the real ~/.librarian. `bin`/`home` set to null delete that variable. */
function withEnv<T>(env: { LIBRARIAN_BIN?: string | null; HOME?: string | null }, fn: () => T): T {
  const prevBin = process.env.LIBRARIAN_BIN;
  const prevHome = process.env.HOME;
  try {
    if ('LIBRARIAN_BIN' in env) {
      if (env.LIBRARIAN_BIN == null) delete process.env.LIBRARIAN_BIN;
      else process.env.LIBRARIAN_BIN = env.LIBRARIAN_BIN;
    }
    if ('HOME' in env) {
      if (env.HOME == null) delete process.env.HOME;
      else process.env.HOME = env.HOME;
    }
    return fn();
  } finally {
    if (prevBin === undefined) delete process.env.LIBRARIAN_BIN;
    else process.env.LIBRARIAN_BIN = prevBin;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
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
