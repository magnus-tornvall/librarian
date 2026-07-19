import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeInjectionTrace, type InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempDiagnostics(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-why-last-'));
  return path.join(root, 'diagnostics');
}

function runWhy(args: string[], diagnosticsDir: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'why', ...args, '--diagnostics-dir', diagnosticsDir], { encoding: 'utf8' });
}

function pushTrace(injectionId: string, ts: string, sessionId?: string): InjectionTrace {
  return {
    record_class: 'diagnostic',
    injection_id: injectionId,
    path: 'push',
    ts,
    ...(sessionId ? { session_id: sessionId } : {}),
    query: `q-${injectionId}`,
    candidates: [],
    shipped_note_ids: [],
    indexed_through: '',
    embedding: 'disabled',
    config_snapshot: {},
  };
}

test('why --last replays the max-ULID push trace even when ts order contradicts it', () => {
  const dir = tempDiagnostics();
  // ULID order: A < B < C. ts order deliberately reversed (C oldest, A newest).
  writeInjectionTrace(dir, pushTrace('01AAAAAAAAAAAAAAAAAAAAAAAA', '2026-07-03T00:00:00.000Z'));
  writeInjectionTrace(dir, pushTrace('01BBBBBBBBBBBBBBBBBBBBBBBB', '2026-07-02T00:00:00.000Z'));
  writeInjectionTrace(dir, pushTrace('01CCCCCCCCCCCCCCCCCCCCCCCC', '2026-07-01T00:00:00.000Z'));
  // A pull trace with the highest ULID must be ignored (--last is push-only).
  writeInjectionTrace(dir, { ...pushTrace('01ZZZZZZZZZZZZZZZZZZZZZZZZ', '2026-07-09T00:00:00.000Z'), path: 'pull' });

  const result = runWhy(['--last', '--json'], dir);
  assert.equal(result.status, 0, `why --last should exit 0; stderr: ${result.stderr}`);
  assert.equal((JSON.parse(result.stdout) as InjectionTrace).injection_id, '01CCCCCCCCCCCCCCCCCCCCCCCC');
});

test('why --last --session filters to the session then takes max-ULID', () => {
  const dir = tempDiagnostics();
  writeInjectionTrace(dir, pushTrace('01AAAAAAAAAAAAAAAAAAAAAAAA', '2026-07-01T00:00:00.000Z', 'S1'));
  writeInjectionTrace(dir, pushTrace('01BBBBBBBBBBBBBBBBBBBBBBBB', '2026-07-02T00:00:00.000Z', 'S1'));
  writeInjectionTrace(dir, pushTrace('01ZZZZZZZZZZZZZZZZZZZZZZZZ', '2026-07-03T00:00:00.000Z', 'S2'));

  const result = runWhy(['--last', '--session', 'S1', '--json'], dir);
  assert.equal(result.status, 0, `why --last --session should exit 0; stderr: ${result.stderr}`);
  assert.equal((JSON.parse(result.stdout) as InjectionTrace).injection_id, '01BBBBBBBBBBBBBBBBBBBBBBBB');
});

test('why --last --session with an unknown session yields the session-specific error', () => {
  const dir = tempDiagnostics();
  writeInjectionTrace(dir, pushTrace('01AAAAAAAAAAAAAAAAAAAAAAAA', '2026-07-01T00:00:00.000Z', 'S1'));

  const result = runWhy(['--last', '--session', 'nope', '--json'], dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no push traces for session nope/);
});

test('why --last with no push traces yields the no-traces error', () => {
  const dir = tempDiagnostics();
  const result = runWhy(['--last'], dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no push traces found/);
});

test('why --last combined with a positional id is a usage error', () => {
  const dir = tempDiagnostics();
  const result = runWhy(['some-id', '--last'], dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mutually exclusive/);
});
