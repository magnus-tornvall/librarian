import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

// Pin detection to "nothing present": dead Ollama URL so the embedding menu is
// deterministic (probe fails → not detected). process.execPath is absolute.
function runConfig(configPath: string, answers: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, 'config', '--config', configPath], {
    encoding: 'utf8',
    input: answers,
    env: { ...process.env, LIBRARIAN_OLLAMA_URL: 'http://127.0.0.1:1' },
  });
}

test('config changes provider via scripted answers; loadConfig reflects it, scoring/unknown preserved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    inference: { provider: 'opencode', model: 'opencode/big-pickle' },
    scoring: { originWeights: { human: 5 } },
    extra: 'keep-me',
  }));

  // section=provider, provider=claude, model=blank (no model kept for claude)
  const result = runConfig(configPath, 'provider\nclaude\n\n');
  assert.equal(result.status, 0, result.stderr);

  const config = loadConfig(configPath);
  assert.equal(config.inference.provider, 'claude');

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(raw.scoring, { originWeights: { human: 5 } });
  assert.equal(raw.extra, 'keep-me');
});

test('config custom embedding endpoint path writes endpoint + model', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-'));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ inference: { provider: 'claude' }, scoring: { relevanceFloor: 0.1 } }));

  // section=embedding, choice=3 (custom…), endpoint, model
  const result = runConfig(configPath, 'embedding\n3\nhttp://example:9999\nmy-embed-model\n');
  assert.equal(result.status, 0, result.stderr);

  const config = loadConfig(configPath);
  assert.deepEqual(config.embedding, { endpoint: 'http://example:9999', model: 'my-embed-model', timeoutMs: 10000, recallTimeoutMs: 400 });
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(raw.scoring, { relevanceFloor: 0.1 });
});
