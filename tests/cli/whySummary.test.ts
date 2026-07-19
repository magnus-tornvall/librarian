import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { writeInjectionTrace, type InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

function trace(overrides: Partial<InjectionTrace>): InjectionTrace {
  return {
    record_class: 'diagnostic',
    injection_id: ulid(),
    path: 'push',
    ts: '2026-07-10T00:00:00.000Z',
    query: 'q',
    candidates: [],
    shipped_note_ids: [],
    indexed_through: '2026-07-10T00:00:00.000Z',
    embedding: 'disabled',
    config_snapshot: {},
    ...overrides,
  };
}

function seed(): string {
  const diagnosticsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-summary-'));
  // S1: two push traces (ids ordered). S2: one push trace, newer id. Plus one pull trace.
  const s1a = trace({ injection_id: '01AAAAAAAAAAAAAAAAAAAAAAA1', session_id: 'S1', query: 's1-first' });
  const s1b = trace({ injection_id: '01AAAAAAAAAAAAAAAAAAAAAAA2', session_id: 'S1', query: 's1-second' });
  const s2 = trace({ injection_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ9', session_id: 'S2', query: 's2-only' });
  const pull = trace({ injection_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZZ', path: 'pull', query: 'pull-noise' });
  // write out of order to prove sorting
  for (const t of [s1b, pull, s2, s1a]) writeInjectionTrace(diagnosticsDir, t);
  return diagnosticsDir;
}

test('why-summary with no args resolves the newest session and replays only its push traces in ULID order', () => {
  const diagnosticsDir = seed();
  const r = runCli(['why-summary', '--diagnostics-dir', diagnosticsDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Session S2 · 1 injection\n/);
  assert.match(r.stdout, /Query: s2-only/);
  assert.doesNotMatch(r.stdout, /pull-noise/);
  assert.doesNotMatch(r.stdout, /s1-/);
});

test('why-summary --session S1 replays S1 only in ULID order', () => {
  const diagnosticsDir = seed();
  const r = runCli(['why-summary', '--session', 'S1', '--diagnostics-dir', diagnosticsDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Session S1 · 2 injections\n/);
  assert.ok(r.stdout.indexOf('s1-first') < r.stdout.indexOf('s1-second'), 'ULID order');
  assert.doesNotMatch(r.stdout, /s2-only|pull-noise/);
});

test('why-summary --json parses and carries the same traces in the same order', () => {
  const diagnosticsDir = seed();
  const r = runCli(['why-summary', '--session', 'S1', '--json', '--diagnostics-dir', diagnosticsDir]);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout) as { session: string; injections: number; traces: InjectionTrace[] };
  assert.equal(payload.session, 'S1');
  assert.equal(payload.injections, 2);
  assert.deepEqual(payload.traces.map((t) => t.query), ['s1-first', 's1-second']);
  assert.ok(payload.traces.every((t) => t.session_id === 'S1' && t.path === 'push'));
});
