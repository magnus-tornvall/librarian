import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent } from '../../src/collector/append.ts';
import { readAll } from '../../src/log/ndjson.ts';

const GOLDEN_DIR = path.join(import.meta.dirname, '..', '..', 'schema', 'examples', 'event');

function tempLogFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-append-test-'));
  return path.join(dir, 'events.ndjson');
}

test('appending a golden example event round-trips through readAll', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '01-prompt-in-git-repo.json'), 'utf8'),
  );
  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);
  assert.deepEqual(readAll(logFilePath), [record]);
});

test('a plausible pre-redaction secret in command never reaches disk', () => {
  const secret = 'ghp_' + 'C'.repeat(36);
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  );
  record.command = `curl -H "Authorization: Bearer ${secret}" https://api.example.com/deploy`;

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  const rawBytes = fs.readFileSync(logFilePath, 'utf8');
  assert.ok(!rawBytes.includes(secret));
  assert.match(rawBytes, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  assert.match(
    persisted.command as string,
    /^curl -H "Authorization: Bearer \[REDACTED:token:sha256:[0-9a-f]{8}\]" https:\/\/api\.example\.com\/deploy$/,
  );
});

test('normalizes home paths throughout an event before durable append', () => {
  const home = os.homedir();
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '02-file-edit-write.json'), 'utf8'),
  );
  record.resource.cwd = `${home}/dev/librarian`;
  record.resource.git_root = `${home}/dev/librarian`;
  record.context.cwd = `${home}/dev/librarian`;
  record.files[0].path = `${home}/dev/librarian/src/auth/session.ts`;
  record.prompt = `edit ${home}/dev/librarian/src/auth/session.ts`;

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  assert.deepEqual(persisted.resource, { ...record.resource, cwd: '~/dev/librarian', git_root: '~/dev/librarian' });
  assert.deepEqual(persisted.context, { ...record.context, cwd: '~/dev/librarian' });
  assert.deepEqual(persisted.files, [{ path: '~/dev/librarian/src/auth/session.ts', action: 'write' }]);
  assert.equal(persisted.prompt, 'edit ~/dev/librarian/src/auth/session.ts');
  assert.ok(!JSON.stringify(persisted).includes(home));

  appendEvent(logFilePath, persisted);
  assert.deepEqual(readAll(logFilePath), [persisted, persisted]);
});

test('leaves paths that only neighbour or contain the home path unchanged', () => {
  const home = os.homedir();
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '01-prompt-in-git-repo.json'), 'utf8'),
  );
  record.resource.cwd = `/mnt/backup${home}/dev`;
  record.context.cwd = `${home}ish/dev`;
  record.prompt = `restored /mnt/backup${home}/dev into ${home}ish/dev`;

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  assert.deepEqual(readAll(logFilePath), [record]);
});

test('leaves paths outside home unchanged', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '01-prompt-in-git-repo.json'), 'utf8'),
  );
  record.resource.cwd = '/tmp/librarian';
  record.context.cwd = '/tmp/librarian';
  record.prompt = 'inspect /tmp/librarian';

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  assert.deepEqual(readAll(logFilePath), [record]);
});

test('an invalid event throws and does not create or modify the log file', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '01-prompt-in-git-repo.json'), 'utf8'),
  );
  delete record.event_id;

  const logFilePath = tempLogFile();
  assert.throws(() => appendEvent(logFilePath, record));
  assert.equal(fs.existsSync(logFilePath), false);
});
