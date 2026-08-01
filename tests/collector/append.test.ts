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

test('a secret printed by a command never reaches disk', () => {
  // Machine-generated output arrives with no `<private>` markup — nobody tagged it — so the
  // patterns are its only guard, on the same non-retrofittable boundary as `command` (#179).
  const secret = 'ghp_' + 'D'.repeat(36);
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  );
  record.command = 'gh auth token';
  record.outcome = { stdout: `${secret}\n`, stderr: `warning: using ${secret}\n` };

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  assert.ok(!fs.readFileSync(logFilePath, 'utf8').includes(secret));
  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  const outcome = persisted.outcome as Record<string, string>;
  assert.match(outcome.stdout, /^\[REDACTED:token:sha256:[0-9a-f]{8}\]\n$/);
  assert.match(outcome.stderr, /^warning: using \[REDACTED:token:sha256:[0-9a-f]{8}\]\n$/);
});

test('an incidental private tag in command output does not truncate the rest', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  );
  record.outcome = {
    stdout: 'FAIL x.spec.ts\n  expected <private>true</privat\nREAL ERROR: ENOENT config.yml\n',
  };

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  const stdout = (persisted.outcome as Record<string, string>).stdout;
  assert.ok(stdout.includes('REAL ERROR: ENOENT config.yml'), 'the failure text survives');
  // An UNCLOSED tag in machine output is left as literal text — the same treatment an
  // unclosed `<librarian-memory>` already gets in a prompt. Nothing is declared, so nothing
  // is destroyed. A well-formed span is still stripped (next test).
  assert.ok(stdout.includes('<private>true'), 'the incidental tag is left as literal output');
});

test('a well-formed private span in command output is still stripped', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  );
  record.outcome = { stdout: 'before <private>do not persist this</private> after\n' };

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  const stdout = (persisted.outcome as Record<string, string>).stdout;
  assert.equal(stdout, 'before [PRIVATE] after\n');
  assert.ok(!fs.readFileSync(logFilePath, 'utf8').includes('do not persist this'));
});

test('a multi-megabyte stream is capped head+tail before durable append', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  );
  record.outcome = { stdout: `HEAD${'x'.repeat(4 * 1024 * 1024)}TAIL` };

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  const stdout = (persisted.outcome as Record<string, string>).stdout;
  assert.ok(stdout.length < 70 * 1024, `capped, got ${stdout.length} chars`);
  assert.ok(stdout.startsWith('HEAD'), 'the head survives — it holds the invocation');
  assert.ok(stdout.endsWith('TAIL'), 'the tail survives — it holds the error');
  assert.match(stdout, /…\[\d+ characters elided\]…/, 'the elision names what was dropped');
});

test('a stream at the cap is stored verbatim, with no elision marker', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  );
  const exact = 'z'.repeat(64 * 1024);
  record.outcome = { stdout: exact };

  const logFilePath = tempLogFile();
  appendEvent(logFilePath, record);

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  assert.equal((persisted.outcome as Record<string, string>).stdout, exact);
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
