import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `librarian uninstall` — removes the wiring, keeps the memory (issue #157).
 *
 * The success signal from the issue: after uninstall the bin and the plugin file are gone and
 * nothing points at them, but the note log and index survive unless `--purge` was passed.
 * These tests build a fully-wired temp HOME by hand (the same artifacts `scripts/install.sh`
 * and `librarian init` leave behind), run the real CLI against it, and assert on what is left.
 */

const REPO_ROOT = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

const NOTES = path.join('data', 'notes', '2026-01.ndjson');

/** A HOME wired as if install.sh + `librarian init` had run, with data already collected. */
function wiredHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'));
  const write = (relative: string, text: string): void => {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };

  write(path.join('.librarian', 'bin', 'librarian'), '#!/bin/sh\nexit 0\n');
  // A killed self-update strands these siblings; uninstall should sweep them too.
  write(path.join('.librarian', 'bin', '.librarian.4242.update'), 'staged\n');
  write(path.join('.librarian', 'bin', '.librarian.4242.rollback'), 'previous\n');
  write(path.join('.config', 'opencode', 'plugins', 'librarian.ts'), 'export const plugin = 1;\n');
  write('.zshrc', `# user's own line\nexport PATH="${home}/.librarian/bin:$PATH" # added by librarian installer\n`);
  write(path.join('.librarian', 'config.json'), `${JSON.stringify({
    inference: { provider: 'opencode' },
    vault: '/somewhere/vault',
    bin: path.join(home, '.librarian', 'bin', 'librarian'),
    runtime: '/usr/bin/node',
  }, null, 2)}\n`);
  write(path.join('.librarian', NOTES), '{"note_id":"n1"}\n');
  write(path.join('.librarian', 'index', 'notes.db'), 'sqlite\n');

  return home;
}

function runUninstall(home: string, args: string[] = [], input = ''): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, 'uninstall', ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, HOME: home, LIBRARIAN_BIN_DIR: path.join(home, '.librarian', 'bin') },
  });
}

const exists = (home: string, relative: string): boolean => fs.existsSync(path.join(home, relative));

test('uninstall removes the wiring and preserves the data', () => {
  const home = wiredHome();
  const result = runUninstall(home);
  assert.equal(result.status, 0, result.stderr);

  // Wiring gone.
  assert.equal(exists(home, path.join('.librarian', 'bin')), false, 'bin dir should be pruned once empty');
  assert.equal(exists(home, path.join('.config', 'opencode', 'plugins', 'librarian.ts')), false, 'OpenCode plugin should be gone');
  const zshrc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.equal(zshrc.includes('added by librarian installer'), false, 'installer PATH line should be stripped');
  assert.match(zshrc, /# user's own line/, 'unrelated profile lines must survive');

  // Config: wiring keys dropped, settings kept.
  const config = JSON.parse(fs.readFileSync(path.join(home, '.librarian', 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(config).sort(), ['inference', 'vault']);

  // Data survives — the whole point.
  assert.equal(exists(home, path.join('.librarian', NOTES)), true, 'note log must survive');
  assert.equal(exists(home, path.join('.librarian', 'index', 'notes.db')), true, 'index must survive');
  assert.match(result.stdout, /Pass --purge/);
  assert.match(result.stdout, /\/plugin uninstall librarian/, 'host-owned teardown must be printed');
});

test('uninstall --purge removes the data once confirmed', () => {
  const home = wiredHome();
  const result = runUninstall(home, ['--purge'], 'y\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(exists(home, '.librarian'), false, '--purge should remove the whole tree');
  assert.equal(exists(home, path.join('.config', 'opencode', 'plugins', 'librarian.ts')), false);
});

test('uninstall --purge declined removes nothing', () => {
  const home = wiredHome();
  const result = runUninstall(home, ['--purge'], 'n\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /aborted/);
  assert.equal(exists(home, path.join('.librarian', NOTES)), true, 'declining must leave the data');
  assert.equal(exists(home, path.join('.librarian', 'bin', 'librarian')), true, 'declining must leave the wiring too');
});

test('uninstall --dry-run reports without changing anything', () => {
  const home = wiredHome();
  const result = runUninstall(home, ['--purge', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would remove/);
  assert.equal(exists(home, path.join('.librarian', 'bin', 'librarian')), true);
  assert.equal(exists(home, path.join('.config', 'opencode', 'plugins', 'librarian.ts')), true);
  assert.equal(exists(home, path.join('.librarian', NOTES)), true);
  assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /added by librarian installer/);
});

test('uninstall is idempotent on an unwired HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-bare-'));
  const result = runUninstall(home);
  assert.equal(result.status, 0, result.stderr);
});

test('uninstall rejects unknown flags', () => {
  const result = runUninstall(wiredHome(), ['--everything']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected argument: --everything/);
});
