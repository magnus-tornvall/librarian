import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  map,
  type CanonicalEvent,
  type MapEnv,
  type NativePayload,
  type PostToolUsePayload,
} from '../../adapters/claude-code/map.ts';
import { runHook } from '../../adapters/claude-code/hook.ts';
import { validateEvent } from '../../src/collector/validateEvent.ts';
import { readAll } from '../../src/log/ndjson.ts';

/**
 * Claude Code adapter integration tests (issue #31 / spec §9).
 *
 * The fixture block contains NO per-case mapping logic. It auto-discovers every
 * fixtures/claude-code/**\/*.json, and for each one asserts that the PURE mapper
 * (adapters/claude-code/map.ts) produces the fixture's expected canonical event on all
 * stable fields and that the result passes the collector's validateEvent(). Adding a
 * fixture pair means dropping a JSON file under fixtures/claude-code/ — never editing this
 * runner (that is the Definition of Done).
 *
 * Beyond the fixtures, explicit assertions cover the remaining mapping rules (git push →
 * vcs_push, Grep/Glob → search, an unrecognized tool → unknown/other, Stop → stop, an
 * unrecognized hook event → no event). Then two end-to-end tests pipe mapped events
 * through the REAL `librarian collect` (spawned, temp data dir) — one proving every event
 * lands on its per-session log, one proving a secret-bearing command lands REDACTED
 * (redaction is the collector's job at the append boundary, §5). Finally, a hook-safety
 * test spawns the real hook.ts with a malformed payload and asserts it exits 0 (never
 * breaks the host session) while writing the error to stderr.
 */

const FIXTURE_ROOT = path.join(import.meta.dirname, '..', '..', 'fixtures', 'claude-code');
const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const HOOK = path.join(import.meta.dirname, '..', '..', 'adapters', 'claude-code', 'hook.ts');

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

/** Recursively collect every *.json under fixtures/claude-code/ (nested dirs allowed). */
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

// Guard the guard: if auto-discovery silently found nothing, every per-fixture test below
// would simply not exist and the suite would be vacuously green. Fail loudly — §9 requires
// 3–5 origin-qualification fixtures.
test('claude-code fixture auto-discovery finds at least 3 fixtures', () => {
  assert.ok(
    fixtureFiles.length >= 3,
    `expected >= 3 claude-code fixtures under ${FIXTURE_ROOT}, found ${fixtureFiles.length}`,
  );
});

for (const file of fixtureFiles) {
  const fixture = loadFixture(file);
  const rel = path.relative(FIXTURE_ROOT, file);

  test(`claude-code fixture maps to expected canonical event: ${fixture.name} [${rel}]`, () => {
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

// --- Additional mapping rules not carried by a fixture --------------------------------

/** A minimal env for the inline mapping-rule assertions below. */
function inlineEnv(overrides: Partial<MapEnv> = {}): MapEnv {
  return {
    event_id: '01J8X7QK45Y0A6S9P7T1U6W8XX',
    ts: '2026-07-06T10:00:00.000Z',
    resource: { agent: 'claude-code', machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX', cwd: '/repo' },
    context: { session_id: 'cc-inline-session', cwd: '/repo' },
    ...overrides,
  };
}

/** Build a PostToolUse native payload for a given tool + input. */
function postToolUse(tool_name: string, tool_input?: Record<string, unknown>): PostToolUsePayload {
  return {
    session_id: 'cc-inline-session',
    cwd: '/repo',
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input,
  };
}

test('claude-code mapping: Bash `git push` recategorizes to vcs_push (no hint), raw command shipped', () => {
  const command = 'git push origin feat/claude-code-adapter';
  const [event] = map(postToolUse('Bash', { command }), inlineEnv()) as [Record<string, unknown>];
  assert.equal((event.tool as Record<string, unknown>).native_name, 'Bash');
  assert.equal((event.tool as Record<string, unknown>).canonical_name, 'bash');
  assert.equal((event.tool as Record<string, unknown>).category, 'vcs_push');
  assert.equal(event.command, command, 'the raw command must be shipped');
  assert.equal(event.hints, undefined, 'vcs_push carries no salience hint');
  assert.doesNotThrow(() => validateEvent(event));
});

test('claude-code mapping: Grep and Glob map to search/search', () => {
  for (const tool of ['Grep', 'Glob']) {
    const [event] = map(postToolUse(tool, { pattern: 'TODO' }), inlineEnv()) as [Record<string, unknown>];
    assert.equal((event.tool as Record<string, unknown>).native_name, tool);
    assert.equal((event.tool as Record<string, unknown>).canonical_name, 'search');
    assert.equal((event.tool as Record<string, unknown>).category, 'search');
    assert.equal(event.files, undefined, `${tool}: a search has no files[]`);
    assert.doesNotThrow(() => validateEvent(event));
  }
});

test('claude-code mapping: an unrecognized tool falls through to unknown/other (dumb by design)', () => {
  const [event] = map(postToolUse('WebFetch', { url: 'https://example.com' }), inlineEnv()) as [
    Record<string, unknown>,
  ];
  assert.equal((event.tool as Record<string, unknown>).native_name, 'WebFetch');
  assert.equal((event.tool as Record<string, unknown>).canonical_name, 'unknown');
  assert.equal((event.tool as Record<string, unknown>).category, 'other');
  assert.doesNotThrow(() => validateEvent(event));
});

test('claude-code mapping: Edit maps to edit/file_write with files[] action edit + file_write hint', () => {
  const native = postToolUse('Edit', {
    file_path: '/repo/src/x.ts',
    old_string: 'a',
    new_string: 'b',
  });
  const [event] = map(native, inlineEnv()) as [Record<string, unknown>];
  assert.equal((event.tool as Record<string, unknown>).canonical_name, 'edit');
  assert.equal((event.tool as Record<string, unknown>).category, 'file_write');
  assert.deepEqual(event.files, [{ path: '/repo/src/x.ts', action: 'edit' }]);
  assert.deepEqual(event.hints, { possibly_salient: true, reason: 'file_write' });
  assert.doesNotThrow(() => validateEvent(event));
});

test('claude-code mapping: Stop maps to SessionEvent action stop', () => {
  const native: NativePayload = {
    session_id: 'cc-inline-session',
    cwd: '/repo',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'done',
  };
  const [event] = map(native, inlineEnv()) as [Record<string, unknown>];
  assert.equal(event.type, 'session');
  assert.equal(event.action, 'stop');
  assert.doesNotThrow(() => validateEvent(event));
});

test('claude-code mapping: an unrecognized hook event maps to no canonical event', () => {
  // Not one of the four mapped events — the mapper returns [] rather than throwing, so a
  // stray payload is a no-op (hook-safety, §14).
  const native = {
    session_id: 'cc-inline-session',
    cwd: '/repo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  } as unknown as NativePayload;
  assert.deepEqual(map(native, inlineEnv()), []);
});

// --- End-to-end: mapped fixture events through the real `librarian collect` ------------

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function ndjsonLine(record: unknown): string {
  return JSON.stringify(record) + '\n';
}

function runCollect(dataDir: string, stdin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'collect', '--data-dir', dataDir], { input: stdin, encoding: 'utf8' });
}

test('claude-code e2e: every mapped fixture event pipes through real `librarian collect` onto its per-session log', () => {
  const dataDir = tempDir('claude-code-e2e-');

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

test('claude-code e2e: the adapter ships a raw secret-bearing command; the collector lands it REDACTED', () => {
  const dataDir = tempDir('claude-code-e2e-redact-');

  const secret = 'ghp_' + 'C'.repeat(36); // a github-token-shaped secret the collector redacts
  const rawCommand = `curl -H "Authorization: Bearer ${secret}" https://api.example.com/deploy`;

  // A real Claude Code PostToolUse Bash payload carrying the secret in tool_input.command.
  const native: NativePayload = postToolUse('Bash', { command: rawCommand });
  const env: MapEnv = {
    event_id: '01J8X7QK45Y0A6S9P7T1U6W8XX',
    ts: '2026-07-06T09:30:00.000Z',
    resource: { agent: 'claude-code', machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX', cwd: '/repo' },
    context: { session_id: 'claude-code-redact-session', cwd: '/repo' },
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
  const logFilePath = path.join(dataDir, 'events', 'claude-code-redact-session.ndjson');
  const rawBytes = fs.readFileSync(logFilePath, 'utf8');
  assert.ok(!rawBytes.includes(secret), 'the raw secret must never reach disk after the collector');
  assert.match(rawBytes, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/, 'the redaction marker must be present on disk');

  const [persisted] = readAll(logFilePath) as Array<Record<string, unknown>>;
  assert.match(persisted.command as string, /\[REDACTED:token:sha256:[0-9a-f]{8}\]/);
});

// --- Hook-safety: a malformed payload must never break the host session ----------------

test('claude-code hook-safety (unit): runHook swallows a malformed payload, delivers nothing, does not throw', () => {
  const delivered: CanonicalEvent[] = [];
  // A non-JSON stdin. runHook must log to stderr (not asserted here) and return without
  // throwing or delivering anything.
  assert.doesNotThrow(() =>
    runHook(
      () => 'this is not json {{{',
      (event) => delivered.push(event),
      () => ({ agent: 'claude-code', machine_id: 'x', cwd: '/repo' }),
    ),
  );
  assert.equal(delivered.length, 0, 'a malformed payload must produce no delivered events');
});

test('claude-code hook-safety (unit): runHook ignores an unrecognized hook event without delivering', () => {
  const delivered: CanonicalEvent[] = [];
  const payload = JSON.stringify({
    session_id: 'cc-inline-session',
    cwd: '/repo',
    hook_event_name: 'Notification',
    message: 'hi',
  });
  runHook(
    () => payload,
    (event) => delivered.push(event),
    () => ({ agent: 'claude-code', machine_id: 'x', cwd: '/repo' }),
  );
  assert.equal(delivered.length, 0, 'an unrecognized event must produce no delivered events');
});

test('claude-code hook-safety (e2e): feeding hook.ts a malformed payload exits 0 and writes the error to stderr', () => {
  // Spawn the REAL hook entry with garbage on stdin. The load-bearing hook-safety contract
  // (§14, Definition of done): the process must exit 0 (never break the host Claude Code
  // session) while surfacing the error on stderr for an operator to find.
  const result = spawnSync('node', [HOOK], { input: 'not json at all {{{', encoding: 'utf8' });
  assert.equal(result.status, 0, `hook.ts must exit 0 on a malformed payload; got ${result.status}`);
  assert.equal(result.stdout, '', 'hook.ts must not write to stdout (Claude Code may treat it as decision/context)');
  assert.match(
    result.stderr,
    /librarian-claude-code: ignoring malformed hook payload/,
    'the malformed-payload error must be surfaced on stderr',
  );
});

test('claude-code hook-safety (e2e): feeding hook.ts empty stdin exits 0 silently', () => {
  const result = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
  assert.equal(result.status, 0, 'hook.ts must exit 0 on empty stdin');
  assert.equal(result.stdout, '', 'hook.ts must not write to stdout');
});
