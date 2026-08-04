import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAllNotes } from '../../src/log/noteLog.ts';
import { readDistillVerdicts } from '../../src/diagnostics/distillVerdict.ts';

// Integration tests for the settle gate (#168): a session's pending delta is
// distillable only once the session has gone quiet for `distill.settleMs`, or a
// terminal boundary marker says the arc is over. Real CLI, real temp dirs, real
// `collect` ingest, offline fixture provider — never a live model (§14).
//
// Event timestamps here are minted relative to `Date.now()` on purpose: the gate
// reads the hook-stamped `ts`, so "still live" is only expressible as a clock
// offset. `settleMs` is dialed down via a real config file so the tests are
// seconds, not days.

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const MINUTE_MS = 60_000;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], stdin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

function makeEvent(
  sessionId: string,
  turn: number,
  ts: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const seq = String(turn).padStart(2, '0');
  return {
    schema_version: 1,
    event_id: `01J8X7QK${seq}Z9R4M2N6P0S5T7WY`,
    ts,
    resource: {
      agent: 'claude-code',
      agent_version: '1.2.3',
      machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX',
      cwd: '/Users/magnus/dev/librarian',
      git_root: '/Users/magnus/dev/librarian',
    },
    context: { session_id: sessionId, turn, cwd: '/Users/magnus/dev/librarian' },
    ...overrides,
  };
}

/**
 * An eligible delta (11 events, 2 prompts, 1 write tool) whose NEWEST event is
 * exactly `lastEventAgeMs` old; earlier events step back one second each.
 */
function eligibleEvents(sessionId: string, lastEventAgeMs: number): Array<Record<string, unknown>> {
  const newest = Date.now() - lastEventAgeMs;
  const total = 11;
  const at = (turn: number): string => new Date(newest - (total - turn) * 1000).toISOString();
  const events = [
    makeEvent(sessionId, 1, at(1), { type: 'prompt', prompt: 'fix the login redirect bug, it loops on expired tokens' }),
    makeEvent(sessionId, 2, at(2), {
      type: 'tool',
      tool: { native_name: 'write_file', canonical_name: 'write', category: 'file_write' },
      files: [{ path: 'src/auth/session.ts', action: 'write' }],
    }),
    makeEvent(sessionId, 3, at(3), { type: 'prompt', prompt: 'now add a regression test for the expiry path' }),
  ];
  for (let turn = 4; turn <= total; turn += 1) {
    events.push(makeEvent(sessionId, turn, at(turn), {
      type: 'tool',
      tool: { native_name: 'read_file', canonical_name: 'read', category: 'file_read' },
      files: [{ path: `src/file-${turn}.ts`, action: 'read' }],
    }));
  }
  return events;
}

/** The terminal boundary marker #169 will emit — `stop` is per-turn and is NOT it. */
function terminalBoundaryEvent(sessionId: string, turn: number): Record<string, unknown> {
  return makeEvent(sessionId, turn, new Date().toISOString(), { type: 'session', action: 'end' });
}

/**
 * Distinct note payloads with no shared vocabulary — the novelty gate rejects
 * near-duplicates, so every note a test mints must be about something else.
 */
const TOPICS = [
  { title: 'Cache keys include tenant', summary: 'Folded the tenant identifier into every cache key so cross-tenant reads cannot collide.' },
  { title: 'Upload retry budget capped', summary: 'Capped upload attempts at three with exponential backoff before surfacing failure to the caller.' },
  { title: 'Timestamps persisted as UTC', summary: 'Normalized all stored datetimes to UTC; localization now happens only at render time.' },
];
const FAITHFUL = JSON.stringify({ faithful: true, errors: [], reason: 'Supported by the events.' });

/** A fixture scripting one (note, verification) pair per topic index, in order. */
function writeFixture(dir: string, topics: number[]): string {
  const responses = topics.flatMap((i) => [
    JSON.stringify({ note_type: 'decision', ...TOPICS[i] }),
    FAITHFUL,
  ]);
  const fixturePath = path.join(dir, `llm-response-${topics.join('-')}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(responses));
  return fixturePath;
}

function writeConfig(dir: string, settleMs: number, extra: Record<string, unknown> = {}): string {
  const configPath = path.join(dir, `config-${settleMs}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ distill: { settleMs }, ...extra }));
  return configPath;
}

function ingest(dataDir: string, events: Array<Record<string, unknown>>): void {
  const stdin = events.map((e) => JSON.stringify(e) + '\n').join('');
  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);
}

function distill(dataDir: string, diagnosticsDir: string, fixturePath: string, configPath: string): ReturnType<typeof spawnSync> {
  return runCli(['distill', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--provider-fixture', fixturePath, '--config', configPath], '');
}

function noteRevisions(dataDir: string): Array<Record<string, unknown>> {
  return (readAllNotes(dataDir) as Array<Record<string, unknown>>).filter((n) => n.kind === 'note_revision');
}

function sessionsOf(dataDir: string): string[] {
  return noteRevisions(dataDir)
    .map((n) => (n.provenance as Record<string, unknown>).session_id as string)
    .sort();
}

function cursorPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'cursors', 'distiller', `${sessionId}.json`);
}

test('settle: a live session is deferred while a settled one distills; the live one lands on a later pass', () => {
  const root = tempDir('settle-two-sessions-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const config = writeConfig(root, 30 * MINUTE_MS);

  ingest(dataDir, eligibleEvents('sess-live', 2 * MINUTE_MS));
  ingest(dataDir, eligibleEvents('sess-settled', 60 * MINUTE_MS));

  const first = distill(dataDir, diagnosticsDir, writeFixture(root, [0]), config);
  assert.equal(first.status, 0, `distill should exit 0; stderr: ${first.stderr}`);
  assert.deepEqual(sessionsOf(dataDir), ['sess-settled'], 'only the settled session distills');

  // The live session's cursor is UNTOUCHED — a deferral is not a decision, so
  // there is nothing to advance past and the whole delta stays pending.
  assert.equal(fs.existsSync(cursorPath(dataDir, 'sess-live')), false, 'the live session must have no cursor yet');
  assert.ok(fs.existsSync(cursorPath(dataDir, 'sess-settled')), 'the settled session advanced its cursor');

  // A later pass, once the window has passed (settleMs dialed to 1 min), picks
  // up the same still-pending delta in full.
  const second = distill(dataDir, diagnosticsDir, writeFixture(root, [1]), writeConfig(root, MINUTE_MS));
  assert.equal(second.status, 0, `the later pass should exit 0; stderr: ${second.stderr}`);
  assert.deepEqual(sessionsOf(dataDir), ['sess-live', 'sess-settled'], 'the previously live session distills later');

  const liveNote = noteRevisions(dataDir).find((n) => (n.provenance as Record<string, unknown>).session_id === 'sess-live')!;
  assert.equal(
    ((liveNote.provenance as Record<string, unknown>).event_ids as string[]).length,
    11,
    'the deferred delta is distilled whole — nothing was consumed by the deferral',
  );
});

test('settle: a deferred session is never reported as a judged skip', () => {
  const root = tempDir('settle-verdict-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');

  ingest(dataDir, eligibleEvents('sess-live', 2 * MINUTE_MS));
  const result = distill(dataDir, diagnosticsDir, writeFixture(root, [0]), writeConfig(root, 30 * MINUTE_MS));
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);

  const verdicts = readDistillVerdicts(diagnosticsDir);
  assert.equal(verdicts.length, 1, 'exactly one verdict for the one pending session');
  assert.equal(verdicts[0].decision, 'deferred', 'a settle-hold is "deferred", never "skipped"');
  assert.equal(verdicts[0].session_id, 'sess-live');
  assert.equal(
    verdicts.filter((v) => v.decision === 'skipped').length,
    0,
    'nothing judged the delta, so no skip verdict may exist',
  );

  // stats reads admission rates off judged verdicts only — a deferral must not
  // dilute them, or the skip/noop rates stop meaning what they say.
  const stats = runCli(['stats', '--diagnostics-dir', diagnosticsDir, '--data-dir', dataDir, '--json'], '');
  assert.equal(stats.status, 0, `stats should exit 0; stderr: ${stats.stderr}`);
  const report = JSON.parse(stats.stdout) as { admission: { total: number } };
  assert.equal(report.admission.total, 0, 'a deferral is not an admission decision');
});

test('settle: a delta carrying a terminal boundary marker distills immediately', () => {
  const root = tempDir('settle-terminal-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');

  // Same 2-minute recency as the deferred case above — only the marker differs.
  const events = eligibleEvents('sess-ended', 2 * MINUTE_MS);
  events.push(terminalBoundaryEvent('sess-ended', 12));
  ingest(dataDir, events);

  const result = distill(dataDir, diagnosticsDir, writeFixture(root, [0]), writeConfig(root, 30 * MINUTE_MS));
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);
  assert.deepEqual(sessionsOf(dataDir), ['sess-ended'], 'a terminal marker beats the clock');
  assert.equal(
    readDistillVerdicts(diagnosticsDir).filter((v) => v.decision === 'deferred').length,
    0,
    'an ended session is never deferred',
  );
});

test('settle: drain over a backlog containing a live session exits 0 and drains the settled ones', () => {
  const root = tempDir('settle-drain-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const indexDir = path.join(root, 'index');
  const config = writeConfig(root, 30 * MINUTE_MS);

  ingest(dataDir, eligibleEvents('sess-a-settled', 90 * MINUTE_MS));
  ingest(dataDir, eligibleEvents('sess-b-live', MINUTE_MS));
  ingest(dataDir, eligibleEvents('sess-c-settled', 60 * MINUTE_MS));

  const result = runCli([
    'drain',
    '--data-dir', dataDir,
    '--diagnostics-dir', diagnosticsDir,
    '--index-dir', indexDir,
    '--provider-fixture', writeFixture(root, [0, 1]),
    '--config', config,
  ], '');
  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);
  assert.deepEqual(sessionsOf(dataDir), ['sess-a-settled', 'sess-c-settled'], 'the live session is left alone');
  assert.match(result.stdout, /sessions deferred \(still live\): 1/, 'the summary names the deferral');
  assert.equal(fs.existsSync(cursorPath(dataDir, 'sess-b-live')), false, 'drain must not advance a live session cursor');
});

test('settle: distill.settleMs round-trips from config alongside unmanaged keys', async () => {
  const root = tempDir('settle-config-');
  const configPath = writeConfig(root, 5_000, { scoring: { relevanceFloor: 0.2 }, extra: 'keep-me' });
  const { loadConfig } = await import('../../src/config.ts');

  const config = loadConfig(configPath);
  assert.equal(config.distill.settleMs, 5_000);
  assert.equal(config.scoring.relevanceFloor, 0.2, 'unmanaged-adjacent sections still load');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).extra, 'keep-me', 'unknown keys are untouched on read');

  const { DEFAULT_SETTLE_MS } = await import('../../src/config.ts');
  const bare = path.join(root, 'bare.json');
  fs.writeFileSync(bare, JSON.stringify({ inference: { provider: 'claude' } }));
  assert.equal(loadConfig(bare).distill.settleMs, DEFAULT_SETTLE_MS, 'the default is 24h when unset');
  assert.equal(DEFAULT_SETTLE_MS, 86_400_000);

  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ distill: { settleMs: -1 } }));
  assert.throws(() => loadConfig(bad), /distill\.settleMs/, 'a non-positive settle window is rejected loudly');
});
