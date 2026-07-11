import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

test('curated note CLI imports and tombstones a canary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-curated-cli-'));
  const vault = path.join(root, 'vault');
  const dataDir = path.join(root, 'data');
  const file = path.join(vault, 'curated', 'canary.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nnote_id: curated:cli-canary\n---\n# Canary\n\nDistinctive fact.\n');

  const imported = spawnSync(process.execPath, [CLI, 'note', 'import-curated', file, '--vault', vault, '--data-dir', dataDir], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).note_id, 'curated:cli-canary');

  const removed = spawnSync(process.execPath, [CLI, 'note', 'tombstone', 'curated:cli-canary', '--data-dir', dataDir, '--reason', 'test cleanup'], { encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
  const tombstone = JSON.parse(removed.stdout);
  assert.equal(tombstone.kind, 'note_tombstone');
  assert.equal(tombstone.reason, 'test cleanup');
});
