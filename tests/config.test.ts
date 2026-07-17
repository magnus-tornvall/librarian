import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { DEFAULT_SCORING_CONFIG } from '../src/recall/scoring.ts';

test('loadConfig defaults missing and empty scoring sections per key', () => {
  const file = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
  assert.deepEqual(loadConfig(file), { inference: { provider: 'claude' }, scoring: DEFAULT_SCORING_CONFIG });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-config-'));
  const empty = path.join(dir, 'config.json');
  fs.writeFileSync(empty, JSON.stringify({ scoring: { originWeights: { human: 2 }, recencyHalfLifeDays: { fact: 'Infinity' } } }));
  assert.deepEqual(loadConfig(empty).scoring, {
    ...DEFAULT_SCORING_CONFIG,
    originWeights: { ...DEFAULT_SCORING_CONFIG.originWeights, human: 2 },
    typeWeights: { ...DEFAULT_SCORING_CONFIG.typeWeights },
    recencyHalfLifeDays: { ...DEFAULT_SCORING_CONFIG.recencyHalfLifeDays, fact: Infinity },
    ttlDays: { ...DEFAULT_SCORING_CONFIG.ttlDays },
  });
});

test('loadConfig tolerates extra fields and rejects malformed JSON and providers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ extra: true, inference: { provider: 'opencode', model: 'test/model', future: 1 } }));
  assert.deepEqual(loadConfig(file).inference, { provider: 'opencode', model: 'test/model' });
  fs.writeFileSync(file, '{');
  assert.throws(() => loadConfig(file), new RegExp(file));
  fs.writeFileSync(file, JSON.stringify({ inference: { provider: 'unknown' } }));
  assert.throws(() => loadConfig(file), new RegExp(file));
});

test('loadConfig rejects malformed scoring values by their keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ scoring: { originWeights: { human: 'heavy' } } }));
  assert.throws(() => loadConfig(file), /scoring\.originWeights\.human/);
  fs.writeFileSync(file, JSON.stringify({ scoring: { relevanceFloor: 'high' } }));
  assert.throws(() => loadConfig(file), /scoring\.relevanceFloor/);
});
