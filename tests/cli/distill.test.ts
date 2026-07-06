import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll } from '../../src/log/ndjson.ts';
import { readAllNotes } from '../../src/log/noteLog.ts';

// Integration tests: spawn the real CLI (`node src/cli.ts`) against real temp
// dirs so a run never touches ~/.librarian (§14). Events are ingested through
// the real `collect` path first, then distilled — the production ingest→distill
// wiring, not a hand-built log. Only the fixture provider is used; a live
// `claude -p` is never called (§2).

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], stdin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

/** A canonical event with sane defaults, overridable per field. `turn` bumps
 * `event_id`/`ts` so a session's events stay ordered and uniquely provenanced. */
function makeEvent(
  sessionId: string,
  turn: number,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const seq = String(turn).padStart(2, '0');
  return {
    schema_version: 1,
    event_id: `01J8X7QK${seq}Z9R4M2N6P0S5T7WY`,
    ts: `2026-07-05T09:${seq}:00.000Z`,
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

function promptEvent(sessionId: string, turn: number, prompt: string): Record<string, unknown> {
  return makeEvent(sessionId, turn, { type: 'prompt', prompt });
}

function writeToolEvent(sessionId: string, turn: number, file: string): Record<string, unknown> {
  return makeEvent(sessionId, turn, {
    type: 'tool',
    tool: { native_name: 'write_file', canonical_name: 'write', category: 'file_write' },
    files: [{ path: file, action: 'write' }],
  });
}

function readToolEvent(sessionId: string, turn: number, file: string): Record<string, unknown> {
  return makeEvent(sessionId, turn, {
    type: 'tool',
    tool: { native_name: 'read_file', canonical_name: 'read', category: 'file_read' },
    files: [{ path: file, action: 'read' }],
  });
}

/** An eligible delta: ≥10 events, ≥2 prompts, ≥1 write tool. */
function eligibleEvents(sessionId: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    promptEvent(sessionId, 1, 'fix the login redirect bug, it loops on expired tokens'),
    writeToolEvent(sessionId, 2, 'src/auth/session.ts'),
    promptEvent(sessionId, 3, 'now add a regression test for the expiry path'),
  ];
  for (let turn = 4; turn <= 11; turn += 1) {
    events.push(readToolEvent(sessionId, turn, `src/file-${turn}.ts`));
  }
  return events; // 11 events, 2 prompts, 1 write tool
}

/** The canned distill judgment — a fixture, not a live model. */
const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Expire check before redirect',
  summary: 'Fixed the login redirect loop by checking token expiry before redirect.',
});

function writeFixture(dir: string): string {
  const fixturePath = path.join(dir, 'llm-response.json');
  fs.writeFileSync(fixturePath, LLM_RESPONSE);
  return fixturePath;
}

/** Ingest events through the real `collect` command (the production path). */
function ingest(dataDir: string, events: Array<Record<string, unknown>>): void {
  const stdin = events.map((e) => JSON.stringify(e) + '\n').join('');
  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);
}

function distill(dataDir: string, diagnosticsDir: string, fixturePath: string): ReturnType<typeof spawnSync> {
  return runCli([
    'distill',
    '--data-dir',
    dataDir,
    '--diagnostics-dir',
    diagnosticsDir,
    '--provider-fixture',
    fixturePath,
  ], '');
}

function noteRevisions(dataDir: string): Array<Record<string, unknown>> {
  return (readAllNotes(dataDir) as Array<Record<string, unknown>>).filter(
    (n) => n.kind === 'note_revision',
  );
}

test('distill: an eligible session lands one note with correct origin and provenance; cursor advances', () => {
  const root = tempDir('cli-distill-eligible-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-eligible';
  const events = eligibleEvents(sessionId);

  ingest(dataDir, events);
  const result = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);

  const notes = noteRevisions(dataDir);
  assert.equal(notes.length, 1, 'exactly one note should be minted');
  const note = notes[0];

  // origin is denormalized from the events' resource.agent (§5).
  assert.equal((note.source as Record<string, unknown>).origin, 'claude-code', 'origin must be resource.agent');
  assert.equal((note.source as Record<string, unknown>).distiller, 'llm');

  // provenance covers exactly the ingested event_ids, in order.
  const provenance = note.provenance as Record<string, unknown>;
  assert.equal(provenance.session_id, sessionId);
  assert.deepEqual(
    provenance.event_ids,
    events.map((e) => e.event_id),
    'provenance.event_ids must be the ingested events',
  );

  // cursor advanced to end of the event log.
  const cursorPath = path.join(dataDir, 'cursors', 'distiller', `${sessionId}.json`);
  assert.ok(fs.existsSync(cursorPath), 'a distiller cursor should exist');
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Record<string, unknown>;
  const logBytes = fs.statSync(path.join(dataDir, 'events', `${sessionId}.ndjson`)).size;
  assert.equal(cursor.byte_offset, logBytes, 'cursor must advance to end of log');
  assert.equal(cursor.consumer, 'distiller');
});

test('distill: re-running over an unchanged log mints no second note (idempotency by provenance)', () => {
  const root = tempDir('cli-distill-rerun-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-rerun';

  ingest(dataDir, eligibleEvents(sessionId));

  const first = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(first.status, 0, `first distill should exit 0; stderr: ${first.stderr}`);
  const second = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(second.status, 0, `second distill should exit 0; stderr: ${second.stderr}`);

  assert.equal(noteRevisions(dataDir).length, 1, 'running distill twice must produce exactly one note');
});

test('distill: a low-signal session is skipped — no note, a diagnostic verdict, cursor advanced', () => {
  const root = tempDir('cli-distill-skip-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-skip';

  // 3 read-only events: fewer than 10 events → skip.
  const events = [
    readToolEvent(sessionId, 1, 'README.md'),
    readToolEvent(sessionId, 2, 'src/index.ts'),
    readToolEvent(sessionId, 3, 'package.json'),
  ];
  ingest(dataDir, events);

  const result = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);

  // No note.
  assert.equal(noteRevisions(dataDir).length, 0, 'a skipped session must mint no note');

  // A distill-verdict diagnostic is in the DIAGNOSTICS dir, not the data dir.
  const verdictDir = path.join(diagnosticsDir, 'distill');
  assert.ok(fs.existsSync(verdictDir), 'a distill verdict segment dir should exist');
  const verdicts = fs
    .readdirSync(verdictDir)
    .filter((n) => n.endsWith('.ndjson'))
    .flatMap((n) => readAll(path.join(verdictDir, n)) as Array<Record<string, unknown>>);
  assert.equal(verdicts.length, 1, 'exactly one verdict should be written');
  const verdict = verdicts[0];
  assert.equal(verdict.record_class, 'diagnostic', 'verdict must carry record_class:diagnostic');
  assert.equal(verdict.decision, 'skipped');
  assert.equal(verdict.session_id, sessionId);
  assert.match(verdict.reason as string, /fewer than 10 events/, 'the skip reason must be named');

  // The verdict must NOT be in the data dir (memory is sacred; verdicts are diagnostics).
  assert.equal(
    fs.existsSync(path.join(dataDir, 'distill')),
    false,
    'no verdict segment may exist under the data dir',
  );

  // Cursor advanced — a skipped delta is processed, not pending forever.
  const cursorPath = path.join(dataDir, 'cursors', 'distiller', `${sessionId}.json`);
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Record<string, unknown>;
  const logBytes = fs.statSync(path.join(dataDir, 'events', `${sessionId}.ndjson`)).size;
  assert.equal(cursor.byte_offset, logBytes, 'cursor must advance past a skipped delta');
});

test('distill: events appended after a successful distill are distilled as the delta only', () => {
  const root = tempDir('cli-distill-delta-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-delta';

  // First eligible batch.
  const first = eligibleEvents(sessionId);
  ingest(dataDir, first);
  const r1 = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(r1.status, 0, `first distill should exit 0; stderr: ${r1.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 1, 'first pass mints one note');

  // A second eligible batch appended after the first was consumed.
  const second: Array<Record<string, unknown>> = [
    promptEvent(sessionId, 20, 'refactor the token store'),
    writeToolEvent(sessionId, 21, 'src/auth/store.ts'),
    promptEvent(sessionId, 22, 'and cover it with a test'),
  ];
  for (let turn = 23; turn <= 30; turn += 1) {
    second.push(readToolEvent(sessionId, turn, `src/delta-${turn}.ts`));
  }
  ingest(dataDir, second);

  const r2 = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(r2.status, 0, `second distill should exit 0; stderr: ${r2.stderr}`);

  const notes = noteRevisions(dataDir);
  assert.equal(notes.length, 2, 'the appended delta mints a second note');

  // The second note's provenance must cover ONLY the delta events, not the first batch.
  const secondIds = second.map((e) => e.event_id);
  const secondNote = notes.find((n) => {
    const ids = (n.provenance as Record<string, unknown>).event_ids as string[];
    return ids.length === secondIds.length && ids[0] === secondIds[0];
  });
  assert.ok(secondNote, 'a note whose provenance is the delta should exist');
  assert.deepEqual(
    (secondNote!.provenance as Record<string, unknown>).event_ids,
    secondIds,
    'the second note must be provenanced to the delta only',
  );
});
