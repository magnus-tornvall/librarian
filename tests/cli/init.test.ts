import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

// Run the real binary with detection pinned to "nothing present": an empty PATH
// (no agent CLIs) and a dead Ollama URL. process.execPath is absolute so the
// empty PATH never breaks launching node itself.
function runInit(configPath: string, indexDir: string, answers: string): ReturnType<typeof spawnSync> {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'init-emptypath-'));
  return spawnSync(process.execPath, [CLI, 'init', '--config', configPath, '--index-dir', indexDir], {
    encoding: 'utf8',
    input: answers,
    env: { ...process.env, PATH: emptyPath, LIBRARIAN_OLLAMA_URL: 'http://127.0.0.1:1' },
  });
}

test('init writes a valid config from scripted answers and doctor reports green', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-'));
  const configPath = path.join(root, 'config.json');
  const vault = path.join(root, 'vault');
  // provider=opencode, model=default(blank), embedding=off, vault=<path>
  const result = runInit(configPath, path.join(root, 'index'), `opencode\n\noff\n${vault}\n`);

  assert.equal(result.status, 0, result.stderr);
  const config = loadConfig(configPath);
  assert.deepEqual(config.inference, { provider: 'opencode', model: 'opencode/big-pickle' });
  assert.equal(config.embedding, undefined);
  assert.equal(config.vault, vault);
  assert.match(result.stdout, /Native stack: ok/);
  assert.match(result.stdout, /Embedding: unconfigured/);
  assert.match(result.stdout, /Setup complete/);
});

test('init detection is fail-soft: absent agents and Ollama degrade, never throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-'));
  const configPath = path.join(root, 'config.json');
  // Choose ollama-local even though none is detected: it must degrade to a
  // manual model prompt, not throw. endpoint falls back to the (dead) probe URL.
  const result = runInit(configPath, path.join(root, 'index'), 'claude\nollama-local\nmanual-embed\n\n');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent CLIs on PATH: none/);
  assert.match(result.stdout, /Ollama: not detected/);
  const config = loadConfig(configPath);
  assert.equal(config.inference.provider, 'claude');
  assert.deepEqual(config.embedding, { endpoint: 'http://127.0.0.1:1', model: 'manual-embed', timeoutMs: 10000, recallTimeoutMs: 400 });
  // A configured-but-unreachable endpoint must warn, not falsely claim green.
  assert.match(result.stdout, /Embedding: unreachable/);
  assert.match(result.stdout, /⚠ Config written/);
  assert.doesNotMatch(result.stdout, /Setup complete/);
});

test('init re-run keeps existing provider and vault when answers are blank', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-'));
  const configPath = path.join(root, 'config.json');
  const indexDir = path.join(root, 'index');
  const vault = path.join(root, 'vault');
  // First run: provider=claude (no model prompt), embedding=off, vault=<path>.
  assert.equal(runInit(configPath, indexDir, `claude\noff\n${vault}\n`).status, 0);
  // Re-run with every answer blank must edit in place, not revert to detection.
  const result = runInit(configPath, indexDir, '\n\n\n');

  assert.equal(result.status, 0, result.stderr);
  const config = loadConfig(configPath);
  assert.equal(config.inference.provider, 'claude');
  assert.equal(config.vault, vault);
});

test('init round-trip preserves unmanaged config keys (scoring)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ scoring: { originWeights: { human: 5 } }, extra: 'keep-me' }));

  const result = runInit(configPath, path.join(root, 'index'), 'opencode\n\noff\n\n');

  assert.equal(result.status, 0, result.stderr);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(raw.scoring, { originWeights: { human: 5 } });
  assert.equal(raw.extra, 'keep-me');
  assert.equal(raw.inference.provider, 'opencode');
});
