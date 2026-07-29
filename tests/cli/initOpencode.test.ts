import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `librarian init` — the OpenCode wiring step (issue #155).
 *
 * OpenCode is the only host that loads executable JS in-process, so it is the only one where
 * a file has to land on disk. The wizard writes it: one dependency-free file into
 * `~/.config/opencode/plugins/librarian.ts`, plus config `bin` pointed at the installed
 * binary so the plugin can reach `librarian hook opencode`. No package, no release ref, no
 * second repo — see the §14 supersession.
 *
 * These tests drive the REAL `librarian init` with scripted answers against a temp HOME, then
 * assert on the artifacts it leaves behind.
 */

const REPO_ROOT = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const PLUGIN_SOURCE = path.join(REPO_ROOT, 'adapters', 'opencode', 'plugin.ts');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A PATH containing only a stub `opencode`, so detection finds that surface and nothing else. */
function pathWithOpenCode(): string {
  const dir = tempDir('init-oc-path-');
  const stub = path.join(dir, 'opencode');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  return dir;
}

/** Write a stand-in for the installed single-executable at the path scripts/install.sh uses. */
function installBinary(home: string): string {
  const bin = path.join(home, '.librarian', 'bin', 'librarian');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function runInit(home: string, answers: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [CLI, 'init', '--config', path.join(home, '.librarian', 'config.json'), '--index-dir', path.join(home, '.librarian', 'index')],
    {
      encoding: 'utf8',
      input: answers,
      env: { ...process.env, HOME: home, PATH: pathWithOpenCode(), LIBRARIAN_OLLAMA_URL: 'http://127.0.0.1:1' },
    },
  );
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(home, '.librarian', 'config.json'), 'utf8')) as Record<string, unknown>;
}

// provider=opencode, model=default, embedding=off, vault=blank, then confirm the install.
const ANSWERS_INSTALL = 'opencode\n\noff\n\n\n';
// Same, but decline the install.
const ANSWERS_DECLINE = 'opencode\n\noff\n\nn\n';

test('init writes the OpenCode plugin and points config `bin` at the installed binary', () => {
  const home = tempDir('init-oc-home-');
  const bin = installBinary(home);

  const result = runInit(home, ANSWERS_INSTALL);
  assert.equal(result.status, 0, result.stderr);

  const installed = path.join(home, '.config', 'opencode', 'plugins', 'librarian.ts');
  assert.ok(fs.existsSync(installed), 'the plugin must land directly in the global plugin dir');
  assert.equal(
    fs.readFileSync(installed, 'utf8'),
    fs.readFileSync(PLUGIN_SOURCE, 'utf8'),
    'the installed file must be adapters/opencode/plugin.ts verbatim — no generated bundle',
  );
  assert.equal(readConfig(home).bin, bin, 'config `bin` must resolve to the installed binary, not repo-local dist/');
  assert.match(result.stdout, /Wrote .*librarian\.ts/);
  assert.match(result.stdout, /restart OpenCode/);
});

test('init is idempotent: a re-run overwrites the plugin in place', () => {
  const home = tempDir('init-oc-rerun-');
  installBinary(home);
  const installed = path.join(home, '.config', 'opencode', 'plugins', 'librarian.ts');

  assert.equal(runInit(home, ANSWERS_INSTALL).status, 0);
  fs.writeFileSync(installed, '// stale plugin from an older librarian\n');
  assert.equal(runInit(home, ANSWERS_INSTALL).status, 0);

  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(PLUGIN_SOURCE, 'utf8'), 'a re-run is how an update lands');
});

test('init declining the install writes no plugin and leaves `bin` untouched', () => {
  const home = tempDir('init-oc-decline-');
  installBinary(home);
  // A dev checkout's bin → dist/cli.js must survive a wizard run that installed nothing.
  fs.writeFileSync(path.join(home, '.librarian', 'config.json'), JSON.stringify({ bin: '/checkout/dist/cli.js' }));

  const result = runInit(home, ANSWERS_DECLINE);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'librarian.ts')));
  assert.equal(readConfig(home).bin, '/checkout/dist/cli.js', 'declining must not clobber an existing bin');
});

test('init warns instead of pointing `bin` at a binary that was never installed', () => {
  // No ~/.librarian/bin/librarian: the plugin still gets written (it can be pointed at a bin
  // later), but we must not record a path that does not exist and call it done.
  const home = tempDir('init-oc-nobin-');

  const result = runInit(home, ANSWERS_INSTALL);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'librarian.ts')));
  assert.equal(readConfig(home).bin, undefined, 'no installed binary means no invented `bin`');
  assert.match(result.stdout, /No installed binary/);
});

test('the installed plugin imports nothing outside node builtins', () => {
  // The load-bearing property of the whole thin-plugin design: OpenCode's sandbox has no
  // dependency resolution to do. If `ulid`, better-sqlite3, sqlite-vec, or the MCP SDK ever
  // becomes reachable from this file, the install path breaks in the host, not in CI.
  const source = fs.readFileSync(PLUGIN_SOURCE, 'utf8');
  const specs = [...source.matchAll(/(?:^|\s)(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const dynamic = [...source.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

  assert.ok(specs.length > 0, 'the scan must actually find the imports it is asserting about');
  for (const spec of [...specs, ...dynamic]) {
    assert.ok(spec.startsWith('node:'), `plugin.ts may only import node builtins; found ${spec}`);
  }
  for (const forbidden of ['ulid', 'better-sqlite3', 'sqlite-vec', '@modelcontextprotocol', '@opencode-ai']) {
    assert.ok(!source.includes(`'${forbidden}`), `plugin.ts must not reference ${forbidden}`);
  }
});
