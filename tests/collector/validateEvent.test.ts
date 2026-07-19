import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateEvent, DiagnosticRecordRejectedError } from '../../src/collector/validateEvent.ts';

const GOLDEN_DIR = path.join(import.meta.dirname, '..', '..', 'schema', 'examples', 'event');

for (const name of fs.readdirSync(GOLDEN_DIR)) {
  test(`golden example validates clean: ${name}`, () => {
    const record = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), 'utf8'));
    assert.doesNotThrow(() => validateEvent(record));
  });
}

test('a record_class:"diagnostic" record throws the distinct diagnostic-rejection error', () => {
  assert.throws(
    () => validateEvent({ record_class: 'diagnostic', reason: 'quarantine' }),
    DiagnosticRecordRejectedError,
  );
});

test('a record missing event_id throws a plain error', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '01-prompt-in-git-repo.json'), 'utf8'),
  );
  delete record.event_id;
  assert.throws(() => validateEvent(record), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof DiagnosticRecordRejectedError));
    return true;
  });
});

test('a note_flag record fed to the collector is hard-rejected (non-event record class)', () => {
  const flag = {
    kind: 'note_flag', schema_version: 1, note_id: 'fact:x', revision_id: 'rev-x',
    created_at: '2026-07-16T00:00:00.000Z', reason: 'wrong', source: { kind: 'cli' },
  };
  assert.throws(() => validateEvent(flag), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /type must be one of/);
    return true;
  });
});

test('a PromptEvent missing prompt throws', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '01-prompt-in-git-repo.json'), 'utf8'),
  );
  delete record.prompt;
  assert.throws(() => validateEvent(record));
});
