import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll } from '../../src/log/ndjson.ts';

// Integration tests: spawn the real CLI with `node src/cli.ts` against a temp
// data dir so a run never touches the real ~/.librarian (§14). The golden
// examples under schema/examples/event double as fixtures.

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const GOLDEN_DIR = path.join(import.meta.dirname, '..', '..', 'schema', 'examples', 'event');
const GOLDEN_FILES = [
  '01-prompt-in-git-repo.json',
  '02-file-edit-write.json',
  '03-git-commit-vcs-commit.json',
  '04-redacted-command-with-token.json',
  '05-session-checkpoint.json',
];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Serialize a record onto one NDJSON line (the on-the-wire collect input). */
function ndjsonLine(record: unknown): string {
  return JSON.stringify(record) + '\n';
}

function runCli(args: string[], stdin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

test('collect: five golden events each land in the correct per-session log, byte-parseable back out', () => {
  const dataDir = tempDir('cli-collect-golden-');
  const records = GOLDEN_FILES.map(
    (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, name), 'utf8')) as Record<string, unknown>,
  );
  const stdin = records.map(ndjsonLine).join('');

  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);

  // Group the expected records by their own context.session_id — the routing key.
  const bySession = new Map<string, Array<Record<string, unknown>>>();
  for (const record of records) {
    const sessionId = (record.context as Record<string, unknown>).session_id as string;
    const bucket = bySession.get(sessionId) ?? [];
    bucket.push(record);
    bySession.set(sessionId, bucket);
  }

  let totalAppended = 0;
  for (const [sessionId, expected] of bySession) {
    const logFilePath = path.join(dataDir, 'events', `${sessionId}.ndjson`);
    assert.ok(fs.existsSync(logFilePath), `per-session log for ${sessionId} should exist`);
    const persisted = readAll(logFilePath) as Array<Record<string, unknown>>;
    assert.deepEqual(persisted, expected, `records for ${sessionId} should round-trip byte-parseable`);
    totalAppended += persisted.length;
  }
  assert.equal(totalAppended, records.length, 'every golden event should be appended exactly once');
});

test('collect: a command carrying a secret-looking token is stored with the [REDACTED: marker, not the token', () => {
  const dataDir = tempDir('cli-collect-redact-');
  const secret = 'ghp_' + 'C'.repeat(36);
  const record = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  ) as Record<string, unknown>;
  record.command = `curl -H "Authorization: Bearer ${secret}" https://api.example.com/deploy`;

  const result = runCli(['collect', '--data-dir', dataDir], ndjsonLine(record));
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);

  const sessionId = (record.context as Record<string, unknown>).session_id as string;
  const logFilePath = path.join(dataDir, 'events', `${sessionId}.ndjson`);
  const rawBytes = fs.readFileSync(logFilePath, 'utf8');
  assert.ok(!rawBytes.includes(secret), 'the raw secret must never reach disk');
  assert.match(rawBytes, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/, 'the redaction marker must be present');

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  assert.match(persisted.command as string, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});

test('collect: private spans and injected memory never reach prompt or command event logs', () => {
  const dataDir = tempDir('cli-collect-private-memory-');
  const prompt = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '01-prompt-in-git-repo.json'), 'utf8'),
  ) as Record<string, unknown>;
  const command = JSON.parse(
    fs.readFileSync(path.join(GOLDEN_DIR, '03-git-commit-vcs-commit.json'), 'utf8'),
  ) as Record<string, unknown>;
  const privateText = 'declared private text';
  const memoryText = 'injected note text';
  prompt.prompt = `keep <private>${privateText}</private> <librarian-memory>${memoryText}</librarian-memory> asking`;
  command.command = `run <private>${privateText}</private> <librarian-memory>${memoryText}</librarian-memory> now`;

  const result = runCli(['collect', '--data-dir', dataDir], [prompt, command].map(ndjsonLine).join(''));
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);

  for (const record of [prompt, command]) {
    const sessionId = (record.context as Record<string, unknown>).session_id as string;
    const raw = fs.readFileSync(path.join(dataDir, 'events', `${sessionId}.ndjson`), 'utf8');
    assert.ok(!raw.includes(privateText), 'private content must never reach disk');
    assert.ok(!raw.includes(memoryText), 'injected memory must never reach disk');
    assert.ok(!raw.includes('librarian-memory'), 'memory tags must never reach disk');
  }

  const [persistedPrompt] = readAll(
    path.join(dataDir, 'events', `${(prompt.context as Record<string, unknown>).session_id}.ndjson`),
  ) as Array<Record<string, unknown>>;
  assert.match(persistedPrompt.prompt as string, /\[PRIVATE\]/);
  assert.ok(!(persistedPrompt.prompt as string).includes('sha256'));
});

test('collect: a record_class:diagnostic record exits non-zero, names the rejection, and leaves the log unchanged', () => {
  const dataDir = tempDir('cli-collect-diagnostic-');
  const diagnostic = {
    record_class: 'diagnostic',
    schema_version: 1,
    type: 'prompt',
    event_id: '01J8X7QK3VZ9R4M2N6P0S5T7WY',
    ts: '2026-07-05T09:12:03.441Z',
    resource: { agent: 'claude-code', machine_id: 'm', cwd: '/tmp' },
    context: { session_id: 'sess-diagnostic', cwd: '/tmp' },
    prompt: 'a diagnostic must never be ingested',
  };

  const result = runCli(['collect', '--data-dir', dataDir], ndjsonLine(diagnostic));
  assert.notEqual(result.status, 0, 'a diagnostic record must cause a non-zero exit');
  assert.match(result.stderr, /diagnostic/i, 'the error must name the diagnostic rejection');

  const logFilePath = path.join(dataDir, 'events', 'sess-diagnostic.ndjson');
  assert.equal(fs.existsSync(logFilePath), false, 'nothing from the rejected line may be appended');
});

test('collect: a malformed JSON line exits non-zero, names the reason, and appends nothing', () => {
  const dataDir = tempDir('cli-collect-malformed-');
  const result = runCli(['collect', '--data-dir', dataDir], 'not valid json {{{\n');
  assert.notEqual(result.status, 0, 'malformed JSON must cause a non-zero exit');
  assert.match(result.stderr, /malformed JSON/i, 'the error must name the malformed JSON');
  assert.equal(fs.existsSync(path.join(dataDir, 'events')), false, 'nothing may be appended');
});

test('machine-id: two calls print the same id and the file exists at the configured path', () => {
  const dir = tempDir('cli-machine-id-');
  const machineIdPath = path.join(dir, 'machine-id');

  const first = runCli(['machine-id', '--path', machineIdPath], '');
  assert.equal(first.status, 0, `machine-id should exit 0; stderr: ${first.stderr}`);
  const second = runCli(['machine-id', '--path', machineIdPath], '');
  assert.equal(second.status, 0, `machine-id should exit 0; stderr: ${second.stderr}`);

  const id1 = first.stdout.trim();
  const id2 = second.stdout.trim();
  assert.ok(id1.length > 0, 'machine-id must print a non-empty id');
  assert.equal(id1, id2, 'the id must be stable across calls');
  assert.ok(fs.existsSync(machineIdPath), 'the machine-id file must exist at the configured path');
  assert.equal(fs.readFileSync(machineIdPath, 'utf8').trim(), id1, 'the persisted id must match the printed id');
});
