import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { map, type CanonicalEvent, type MapEnv, type NativePayload } from '../../adapters/opencode/map.ts';
import { validateEvent } from '../../src/collector/validateEvent.ts';
import { readAll } from '../../src/log/ndjson.ts';

/**
 * OpenCode adapter integration tests (issue #30 / spec §9).
 *
 * This file contains NO per-case mapping logic. It auto-discovers every
 * fixtures/opencode/**\/*.json, and for each one asserts that the PURE mapper
 * (adapters/opencode/map.ts) produces the fixture's expected canonical event on all
 * stable fields and that the result passes the collector's validateEvent(). Adding a
 * fixture pair means dropping a JSON file under fixtures/opencode/ — never editing this
 * runner (that is the Definition of Done).
 *
 * A final end-to-end test pipes mapped fixture events through the REAL `librarian
 * collect` (spawned, temp data dir) and proves a secret-bearing command lands redacted
 * — redaction is the collector's job at the append boundary (§5); the adapter ships raw
 * commands, and this test proves the pipeline covers it.
 */

const FIXTURE_ROOT = path.join(import.meta.dirname, '..', '..', 'fixtures', 'opencode');
const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

// Volatile fields excluded from the stable-field comparison (§9): ULID event_id, the
// wall-clock ts, and the per-machine machine_id. The runner instead asserts the mapper
// passes these through from the injected env unchanged (it must not author them).
const VOLATILE_TOP = ['event_id', 'ts'] as const;
const VOLATILE_RESOURCE = ['machine_id'] as const;

interface Fixture {
  name: string;
  description?: string;
  native: NativePayload;
  env: MapEnv;
  expected: Record<string, unknown>;
}

/** Recursively collect every *.json under fixtures/opencode/ (nested dirs allowed). */
function discoverFixtureFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...discoverFixtureFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out.sort();
}

function loadFixture(file: string): Fixture {
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
  assert.ok(fixture.name, `${file}: fixture is missing "name"`);
  assert.ok(fixture.native, `${file}: fixture is missing "native"`);
  assert.ok(fixture.env, `${file}: fixture is missing "env"`);
  assert.ok(fixture.expected, `${file}: fixture is missing "expected"`);
  return fixture;
}

/** Deep clone + strip volatile fields so two events can be compared on stable fields. */
function stripVolatile(event: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(event);
  for (const key of VOLATILE_TOP) {
    delete copy[key];
  }
  const resource = copy.resource;
  if (typeof resource === 'object' && resource !== null) {
    for (const key of VOLATILE_RESOURCE) {
      delete (resource as Record<string, unknown>)[key];
    }
  }
  return copy;
}

const fixtureFiles = discoverFixtureFiles(FIXTURE_ROOT);

// Guard the guard: if auto-discovery silently found nothing, every per-fixture test
// below would simply not exist and the suite would be vacuously green. Fail loudly —
// §9 requires 3–5 origin-qualification fixtures.
test('opencode fixture auto-discovery finds at least 3 fixtures', () => {
  assert.ok(
    fixtureFiles.length >= 3,
    `expected >= 3 opencode fixtures under ${FIXTURE_ROOT}, found ${fixtureFiles.length}`,
  );
});

for (const file of fixtureFiles) {
  const fixture = loadFixture(file);
  const rel = path.relative(FIXTURE_ROOT, file);

  test(`opencode fixture maps to expected canonical event: ${fixture.name} [${rel}]`, () => {
    const events = map(fixture.native, fixture.env);
    assert.equal(events.length, 1, `${fixture.name}: expected exactly one canonical event`);
    const [event] = events as [Record<string, unknown>];

    // Stable-field equality: everything except the volatile fields must match exactly.
    assert.deepEqual(
      stripVolatile(event),
      stripVolatile(fixture.expected),
      `${fixture.name}: mapped event must match expected on all stable fields`,
    );

    // The volatile fields must be passed through from the injected env verbatim — the
    // mapper stamps facts, it does not invent event_id/ts/machine_id.
    assert.equal(event.event_id, fixture.env.event_id, `${fixture.name}: event_id must come from env`);
    assert.equal(event.ts, fixture.env.ts, `${fixture.name}: ts must come from env`);
    assert.equal(
      (event.resource as Record<string, unknown>).machine_id,
      fixture.env.resource.machine_id,
      `${fixture.name}: machine_id must come from env`,
    );

    // Every mapped fixture event must satisfy the collector's validator.
    assert.doesNotThrow(() => validateEvent(event), `${fixture.name}: mapped event must pass validateEvent`);
  });
}

// --- End-to-end: mapped fixture events through the real `librarian collect` ----------

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ndjsonLine(record: unknown): string {
  return JSON.stringify(record) + '\n';
}

function runCollect(dataDir: string, stdin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'collect', '--data-dir', dataDir], { input: stdin, encoding: 'utf8' });
}

test('opencode e2e: every mapped fixture event pipes through real `librarian collect` onto its per-session log', () => {
  const dataDir = tempDir('opencode-e2e-');

  // Map each fixture through the adapter and collect the resulting canonical events.
  const events: CanonicalEvent[] = fixtureFiles.flatMap((file) => {
    const fixture = loadFixture(file);
    return map(fixture.native, fixture.env);
  });
  assert.ok(events.length >= 3, 'expected mapped events from the discovered fixtures');

  const stdin = events.map(ndjsonLine).join('');
  const result = runCollect(dataDir, stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);

  // Group expected events by their own context.session_id — the routing key — and assert
  // each per-session log holds exactly those events (byte-parseable back out).
  const bySession = new Map<string, CanonicalEvent[]>();
  for (const event of events) {
    const bucket = bySession.get(event.context.session_id) ?? [];
    bucket.push(event);
    bySession.set(event.context.session_id, bucket);
  }

  let totalAppended = 0;
  for (const [sessionId, expected] of bySession) {
    const logFilePath = path.join(dataDir, 'events', `${sessionId}.ndjson`);
    assert.ok(fs.existsSync(logFilePath), `per-session log for ${sessionId} should exist`);
    const persisted = readAll(logFilePath) as Array<Record<string, unknown>>;
    assert.deepEqual(persisted, expected, `records for ${sessionId} should round-trip byte-parseable`);
    totalAppended += persisted.length;
  }
  assert.equal(totalAppended, events.length, 'every mapped event should be appended exactly once');
});

test('opencode e2e: the adapter ships a raw secret-bearing command; the collector lands it REDACTED', () => {
  const dataDir = tempDir('opencode-e2e-redact-');

  const secret = 'ghp_' + 'C'.repeat(36); // a github-token-shaped secret the collector redacts
  const rawCommand = `curl -H "Authorization: Bearer ${secret}" https://api.example.com/deploy`;

  const native: NativePayload = { kind: 'tool', tool: 'bash', command: rawCommand };
  const env: MapEnv = {
    event_id: '01J8X7QK45Y0A6S9P7T1U6W8XX',
    ts: '2026-07-06T09:30:00.000Z',
    resource: { agent: 'opencode', machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX', cwd: '/repo' },
    context: { session_id: 'opencode-redact-session', turn: 1, cwd: '/repo' },
  };

  const [event] = map(native, env) as [Record<string, unknown>];

  // Contract check: the ADAPTER must NOT pre-redact — the mapped event still carries the
  // raw secret. Redaction is the collector's, at the append boundary (§5).
  assert.equal(event.command, rawCommand, 'the adapter must ship the raw command, not pre-redact');
  assert.ok((event.command as string).includes(secret), 'the raw secret is present pre-collector (adapter is dumb)');

  const result = runCollect(dataDir, ndjsonLine(event));
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);

  // After the collector, the secret must be gone and the redaction marker present — this
  // proves the adapter→collector pipeline covers redaction even though the adapter ships raw.
  const logFilePath = path.join(dataDir, 'events', 'opencode-redact-session.ndjson');
  const rawBytes = fs.readFileSync(logFilePath, 'utf8');
  assert.ok(!rawBytes.includes(secret), 'the raw secret must never reach disk after the collector');
  assert.match(rawBytes, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/, 'the redaction marker must be present on disk');

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  assert.match(persisted.command as string, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});
