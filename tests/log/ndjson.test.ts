import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecord, readAll } from '../../src/log/ndjson.ts';

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-test-'));
  return path.join(dir, 'nested', 'log.ndjson');
}

test('append then read-all round-trips records', () => {
  const filePath = tempFile();
  appendRecord(filePath, { id: 1 });
  appendRecord(filePath, { id: 2 });
  assert.deepEqual(readAll(filePath), [{ id: 1 }, { id: 2 }]);
});

test('a truncated final line is silently dropped', () => {
  const filePath = tempFile();
  appendRecord(filePath, { id: 1 });
  appendRecord(filePath, { id: 2 });
  fs.appendFileSync(filePath, '{"id": 3, "truncat');
  assert.deepEqual(readAll(filePath), [{ id: 1 }, { id: 2 }]);
});

test('reading a nonexistent file returns an empty array', () => {
  const filePath = tempFile();
  assert.deepEqual(readAll(filePath), []);
});

test('a malformed line that is not the last line throws', () => {
  const filePath = tempFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"id": 1, "broken"\n{"id": 2}\n');
  assert.throws(() => readAll(filePath));
});
