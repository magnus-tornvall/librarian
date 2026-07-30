import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-update-'));
const binaryTier = process.env.LIBRARIAN_BINARY_TEST === '1';
let server: ChildProcess;
let tagsUrl: string;
let v1: string;
let v2: string;

function run(command: string, args: string[], env = process.env) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', env: { ...env, HOME: temp } });
}

async function startTags(): Promise<string> {
  const source = `require('http').createServer((_, r) => r.end('[{"name":"v2.0.0"}]')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })`;
  server = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((resolve, reject) => {
    server.stdout!.once('data', (data: Buffer) => resolve(data.toString().trim()));
    server.once('error', reject);
  });
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  if (!binaryTier) return;
  assert.equal(run('bash', ['scripts/build-sea.sh'], { ...process.env, LIBRARIAN_VERSION: 'v1.0.0' }).status, 0);
  v1 = path.join(temp, 'v1');
  fs.copyFileSync(path.join(ROOT, 'build', 'sea', 'librarian'), v1);
  assert.equal(run('bash', ['scripts/build-sea.sh'], { ...process.env, LIBRARIAN_VERSION: 'v2.0.0' }).status, 0);
  v2 = path.join(temp, 'v2');
  fs.copyFileSync(path.join(ROOT, 'build', 'sea', 'librarian'), v2);
  tagsUrl = await startTags();
});

after(() => server?.kill());

function install(): string {
  fs.rmSync(path.join(temp, '.librarian'), { recursive: true, force: true });
  fs.rmSync(path.join(temp, '.config'), { recursive: true, force: true });
  const target = path.join(temp, 'bin', 'librarian');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(v1, target);
  fs.chmodSync(target, 0o755);
  return target;
}

function env(candidate: string) {
  return { ...process.env, HOME: temp, LIBRARIAN_TAGS_URL: tagsUrl, LIBRARIAN_BINARY: candidate };
}

test('SEA update swaps a newer candidate and doctor reports its version', { skip: !binaryTier }, () => {
  const target = install();
  const config = path.join(temp, '.librarian', 'config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ embedding: { endpoint: 'http://127.0.0.1:1', model: 'missing' } }));
  const plugin = path.join(temp, '.config', 'opencode', 'plugins', 'librarian.ts');
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(plugin, '// stale plugin\n');
  assert.match(run(target, ['update', '--check'], env(v2)).stdout, /v2\.0\.0 is available/);
  const update = run(target, ['update'], env(v2));
  assert.equal(update.status, 0, update.stderr);
  assert.match(run(target, ['--version']).stdout, /v2\.0\.0/);
  assert.match(run(target, ['doctor', '--json']).stdout, /"version":"v2\.0\.0"/);
  assert.match(run(target, ['update', '--check'], env(v2)).stdout, /up to date/);
  assert.equal(fs.readFileSync(plugin, 'utf8'), fs.readFileSync(path.join(ROOT, 'adapters', 'opencode', 'plugin.ts'), 'utf8'));
});

test('plugin refresh failure keeps a verified binary', { skip: !binaryTier }, () => {
  const target = install();
  const plugin = path.join(temp, '.config', 'opencode', 'plugins', 'librarian.ts');
  fs.mkdirSync(plugin, { recursive: true });
  const update = run(target, ['update'], env(v2));
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stderr, /could not refresh OpenCode plugin/);
  assert.match(run(target, ['--version']).stdout, /v2\.0\.0/);
});

test('a mismatched or native-failing candidate rolls back the prior binary', { skip: !binaryTier }, () => {
  const target = install();
  const wrong = path.join(temp, 'wrong');
  fs.copyFileSync(v1, wrong);
  const mismatch = run(target, ['update'], env(wrong));
  assert.equal(mismatch.status, 1);
  assert.match(run(target, ['--version']).stdout, /v1\.0\.0/);

  const unlaunchable = path.join(temp, 'unlaunchable');
  fs.writeFileSync(unlaunchable, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(unlaunchable, 0o755);
  const launchFailure = run(target, ['update'], env(unlaunchable));
  assert.equal(launchFailure.status, 1);
  assert.match(run(target, ['--version']).stdout, /v1\.0\.0/);

  const hanging = path.join(temp, 'hanging');
  fs.writeFileSync(hanging, '#!/bin/sh\nsleep 60\n');
  fs.chmodSync(hanging, 0o755);
  const started = Date.now();
  const timeout = run(target, ['update'], env(hanging));
  assert.ok(Date.now() - started < 10_000, 'doctor verification must time out');
  assert.equal(timeout.status, 1);
  assert.match(run(target, ['--version']).stdout, /v1\.0\.0/);

  const failing = path.join(temp, 'failing');
  fs.writeFileSync(failing, '#!/bin/sh\necho \'{"version":"v2.0.0","native":{"ok":false}}\'\n');
  fs.chmodSync(failing, 0o755);
  const failedDoctor = run(target, ['update'], env(failing));
  assert.equal(failedDoctor.status, 1);
  assert.match(run(target, ['--version']).stdout, /v1\.0\.0/);
});
