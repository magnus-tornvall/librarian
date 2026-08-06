import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULT_SETTLE_MS } from '../src/config.ts';
import { HOME } from '../src/paths.ts';
import { DEFAULT_SCORING_CONFIG } from '../src/recall/scoring.ts';

test('loadConfig defaults missing and empty scoring sections per key', () => {
  const file = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
  assert.deepEqual(loadConfig(file), { inference: { provider: 'opencode', model: 'opencode/big-pickle' }, embedding: undefined, distill: { settleMs: DEFAULT_SETTLE_MS }, debug: false, scoring: DEFAULT_SCORING_CONFIG });
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

test('loadConfig reads optional vault path and rejects malformed values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ vault: '/home/me/notes' }));
  assert.equal(loadConfig(file).vault, '/home/me/notes');
  fs.writeFileSync(file, JSON.stringify({ scoring: {} }));
  assert.equal(loadConfig(file).vault, undefined);
  fs.writeFileSync(file, JSON.stringify({ vault: '' }));
  assert.throws(() => loadConfig(file), /vault/);
  fs.writeFileSync(file, JSON.stringify({ vault: 42 }));
  assert.throws(() => loadConfig(file), /vault/);
});

test('loadConfig expands a tilde vault and absolutizes a relative one', () => {
  // Regression: `"vault": "~/.librarian/vault/"` used to be handed to fs verbatim, which
  // treats it as *relative* — drain then exported into a literal `~` dir under the cwd.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ vault: '~/.librarian/vault/' }));
  assert.equal(loadConfig(file).vault, path.join(HOME, '.librarian', 'vault'));
  fs.writeFileSync(file, JSON.stringify({ vault: '~' }));
  assert.equal(loadConfig(file).vault, HOME);
  // `~user` is someone else's home — not ours to resolve, so it stays a plain path segment.
  fs.writeFileSync(file, JSON.stringify({ vault: '~someone/notes' }));
  assert.equal(loadConfig(file).vault, path.resolve('~someone/notes'));
  // Relative paths absolutize at load time so the cwd-less drain timer cannot drift.
  fs.writeFileSync(file, JSON.stringify({ vault: 'notes/vault' }));
  assert.equal(loadConfig(file).vault, path.resolve('notes/vault'));
});

test('loadConfig reads optional embedding settings and rejects malformed values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b', timeoutMs: 400 } }));
  assert.deepEqual(loadConfig(file).embedding, { endpoint: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b', timeoutMs: 400, recallTimeoutMs: 400 });
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint: 'https://embeddings.example.test', model: 'multilingual', digest: 'revision-123' } }));
  assert.deepEqual(loadConfig(file).embedding, { endpoint: 'https://embeddings.example.test', model: 'multilingual', digest: 'revision-123', timeoutMs: 10000, recallTimeoutMs: 400 });
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint: 'http://localhost', model: 'model', recallTimeoutMs: 250 } }));
  assert.deepEqual(loadConfig(file).embedding, { endpoint: 'http://localhost', model: 'model', timeoutMs: 10000, recallTimeoutMs: 250 });
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint: '', model: 'model' } }));
  assert.throws(() => loadConfig(file), /embedding\.endpoint/);
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint: 'http://localhost', model: 'model', timeoutMs: 0 } }));
  assert.throws(() => loadConfig(file), /embedding\.timeoutMs/);
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint: 'http://localhost', model: 'model', recallTimeoutMs: 0 } }));
  assert.throws(() => loadConfig(file), /embedding\.recallTimeoutMs/);
  fs.writeFileSync(file, JSON.stringify({ embedding: { endpoint: 'http://localhost', model: 'model', digest: '' } }));
  assert.throws(() => loadConfig(file), /embedding\.digest/);
});

test('loadConfig reads distill.settleMs: default, explicit, gate-off zero, and a loud reject', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-settle-'));
  const write = (name: string, body: unknown): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  assert.equal(DEFAULT_SETTLE_MS, 86_400_000, 'the default settle window is 24h');
  assert.equal(loadConfig(write('bare.json', { inference: { provider: 'claude' } })).distill.settleMs, DEFAULT_SETTLE_MS);
  assert.equal(loadConfig(write('set.json', { distill: { settleMs: 5_000 } })).distill.settleMs, 5_000);
  // Zero is the deliberate escape hatch (gate off), not a validation failure.
  assert.equal(loadConfig(write('off.json', { distill: { settleMs: 0 } })).distill.settleMs, 0);
  assert.throws(() => loadConfig(write('neg.json', { distill: { settleMs: -1 } })), /distill\.settleMs/);
  assert.throws(() => loadConfig(write('str.json', { distill: { settleMs: '1h' } })), /distill\.settleMs/);
  assert.throws(() => loadConfig(write('arr.json', { distill: [] })), /invalid distill/);

  // An unmanaged key alongside it still loads and is left alone.
  const withExtra = write('extra.json', { distill: { settleMs: 60_000 }, extra: 'keep-me' });
  assert.equal(loadConfig(withExtra).distill.settleMs, 60_000);
  assert.equal(JSON.parse(fs.readFileSync(withExtra, 'utf8')).extra, 'keep-me');
});

test('loadConfig reads debug: off by default, on when set, loud on a non-boolean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-debug-'));
  const write = (name: string, body: unknown): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  assert.equal(loadConfig(write('bare.json', {})).debug, false, 'debug is off unless asked for');
  assert.equal(loadConfig(write('on.json', { debug: true })).debug, true);
  assert.throws(() => loadConfig(write('str.json', { debug: 'yes' })), /invalid debug/);
});
