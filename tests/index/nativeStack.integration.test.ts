import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { probeNativeStack } from '../../src/index/database.ts';
import { doctorReport } from '../../src/cli.ts';

// The packaged single-executable (#149) hinges on both native deps loading; the
// SEA-specific extraction path is verified by scripts/build-sea.sh + a no-Node
// smoke run (not reproducible under `node --test`). These guard the in-process
// pieces that ship in the codebase: the probe's vec0 round-trip and doctor's
// native field.

test('probeNativeStack round-trips a vec0 query against the real native stack', () => {
  assert.doesNotThrow(() => probeNativeStack());
});

test('doctor reports the native stack ok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-stack-'));
  const report = await doctorReport(path.join(dir, 'index'), path.join(dir, 'config.json'));
  assert.equal(report.native.ok, true);
  assert.equal(report.native.error, undefined);
});
