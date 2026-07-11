import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';

test('loadConfig defaults a missing file to claude', () => {
  assert.deepEqual(loadConfig(path.join(os.tmpdir(), `missing-${Date.now()}.json`)), {
    inference: { provider: 'claude' },
  });
});

test('loadConfig tolerates extra fields and rejects malformed JSON and providers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ extra: true, inference: { provider: 'opencode', model: 'test/model', future: 1 } }));
  assert.deepEqual(loadConfig(file), { inference: { provider: 'opencode', model: 'test/model' } });
  fs.writeFileSync(file, '{');
  assert.throws(() => loadConfig(file), new RegExp(file));
  fs.writeFileSync(file, JSON.stringify({ inference: { provider: 'unknown' } }));
  assert.throws(() => loadConfig(file), new RegExp(file));
});
