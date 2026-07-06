import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProvider } from '../../src/cli.ts';

// Unit tests for the provider-selection seam (§2). Importing `cli.ts` does NOT
// run the CLI — the top-level invocation is guarded by `import.meta.main` — so
// these assert the flag→provider decision directly, with no CLI spawn and
// without ever invoking the real `claude -p` path.

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveProvider: --provider-fixture selects an offline provider that replays the file, ignoring the prompt', async () => {
  const dir = tempDir('resolve-provider-fixture-');
  const fixturePath = path.join(dir, 'response.json');
  const canned = '{"note_type":"decision","title":"canned","summary":"from the fixture file"}';
  fs.writeFileSync(fixturePath, canned);

  const provider = resolveProvider(new Map([['provider-fixture', fixturePath]]));

  // The fixture double replays the file's contents and ignores its prompt —
  // proving selection picked the offline provider, not `claude -p`.
  assert.equal(await provider.complete('an ignored prompt'), canned);
  assert.equal(await provider.complete('a different ignored prompt'), canned);
});

test('resolveProvider: no fixture flag selects a different (real claude) provider without invoking it', () => {
  // Absent the flag, selection returns the real provider. We assert its SHAPE
  // only and never call complete(), so no `claude` process is spawned here.
  const real = resolveProvider(new Map());
  assert.equal(typeof real.complete, 'function', 'the resolved provider must satisfy InferenceProvider');

  // And it must be a genuinely different selection from the fixture branch: the
  // fixture provider closes over the file contents, the real one does not.
  const dir = tempDir('resolve-provider-distinct-');
  const fixturePath = path.join(dir, 'response.json');
  fs.writeFileSync(fixturePath, 'x');
  const fixtureProvider = resolveProvider(new Map([['provider-fixture', fixturePath]]));
  assert.notEqual(real.complete, fixtureProvider.complete, 'the two branches must resolve distinct providers');
});
