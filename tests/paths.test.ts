import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LIBRARIAN_ROOT, DATA_DIR, DIAGNOSTICS_DIR, CONFIG_PATH } from '../src/paths.ts';

test('DATA_DIR and DIAGNOSTICS_DIR are distinct children of LIBRARIAN_ROOT', () => {
  assert.notEqual(DATA_DIR, DIAGNOSTICS_DIR);
  assert.ok(DATA_DIR.startsWith(LIBRARIAN_ROOT + path.sep));
  assert.ok(DIAGNOSTICS_DIR.startsWith(LIBRARIAN_ROOT + path.sep));
});

test('CONFIG_PATH ends in config.json directly under LIBRARIAN_ROOT', () => {
  assert.equal(path.basename(CONFIG_PATH), 'config.json');
  assert.equal(path.dirname(CONFIG_PATH), LIBRARIAN_ROOT);
  assert.ok(!CONFIG_PATH.startsWith(DATA_DIR));
  assert.ok(!CONFIG_PATH.startsWith(DIAGNOSTICS_DIR));
});
