import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAllNotes } from '../src/log/noteLog.ts';
import { readAll } from '../src/log/ndjson.ts';

// Hardening capstone — proves roadmap item 9 the way #32/#44/#53 proved 6–8:
// no new features, one end-to-end integration test driving the failure modes
// through REAL CLI process spawns (crash recovery, contention, poison input),
// plus the sacred-log guarantee. Everything exercised lands from #59–#62:
// stale-lock recovery, bounded retries + quarantine, the re-distill guard, and
// `librarian drain`. Offline fixture provider only — never a live model.

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Expire check before redirect',
  summary: 'Fixed the login redirect loop by checking token expiry before redirect.',
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], stdin = ''): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

function makeEvent(sessionId: string, turn: number, overrides: Record<string, unknown>): Record<string, unknown> {
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

/** An eligible delta: 11 events, 2 prompts, 1 write tool → mints one note. */
function eligibleEvents(sessionId: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    makeEvent(sessionId, 1, { type: 'prompt', prompt: 'fix the login redirect bug, it loops on expired tokens' }),
    makeEvent(sessionId, 2, {
      type: 'tool',
      tool: { native_name: 'write_file', canonical_name: 'write', category: 'file_write' },
      files: [{ path: 'src/auth/session.ts', action: 'write' }],
    }),
    makeEvent(sessionId, 3, { type: 'prompt', prompt: 'now add a regression test for the expiry path' }),
  ];
  for (let turn = 4; turn <= 11; turn += 1) {
    events.push(
      makeEvent(sessionId, turn, {
        type: 'tool',
        tool: { native_name: 'read_file', canonical_name: 'read', category: 'file_read' },
        files: [{ path: `src/file-${turn}.ts`, action: 'read' }],
      }),
    );
  }
  return events;
}

function writeFixture(dir: string, content = LLM_RESPONSE): string {
  const fixturePath = path.join(dir, 'llm-response.json');
  fs.writeFileSync(fixturePath, content);
  return fixturePath;
}

function ingest(dataDir: string, events: Array<Record<string, unknown>>): void {
  const stdin = events.map((e) => JSON.stringify(e) + '\n').join('');
  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);
}

function drain(
  dataDir: string,
  diagnosticsDir: string,
  fixturePath: string,
  vaultDir?: string,
): ReturnType<typeof spawnSync> {
  const args = ['drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--provider-fixture', fixturePath];
  if (vaultDir !== undefined) args.push('--vault', vaultDir);
  return runCli(args, '');
}

function noteRevisions(dataDir: string): Array<Record<string, unknown>> {
  return (readAllNotes(dataDir) as Array<Record<string, unknown>>).filter((n) => n.kind === 'note_revision');
}

/** Every file under a dir, sorted, with its bytes — for a byte-identical diff. */
function snapshot(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function assertIdentical(a: Map<string, Buffer>, b: Map<string, Buffer>, label: string): void {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${label}: file set must be unchanged`);
  for (const [rel, bytes] of a) {
    assert.deepEqual(b.get(rel), bytes, `${label}: ${rel} must be byte-identical`);
  }
}

function generatedFiles(vaultDir: string): string[] {
  const generated = path.join(vaultDir, 'generated');
  if (!fs.existsSync(generated)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(generated);
  return out;
}

/** A PID guaranteed to be dead: spawn a trivial process, wait, reuse its pid. */
function deadPid(): number {
  const r = spawnSync('node', ['-e', 'process.exit(0)']);
  return r.pid!;
}

/** Every distill verdict written to the diagnostics dir. */
function readVerdicts(diagnosticsDir: string): Array<Record<string, unknown>> {
  const distillDir = path.join(diagnosticsDir, 'distill');
  if (!fs.existsSync(distillDir)) return [];
  return fs
    .readdirSync(distillDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .flatMap((name) => readAll(path.join(distillDir, name)) as Array<Record<string, unknown>>);
}

test('capstone crash recovery: rolled-back cursor + stale dead-PID lock → drain recovers, no duplicate note', () => {
  const root = tempDir('capstone-crash-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  // Distill a fixture backlog for real.
  ingest(dataDir, eligibleEvents('sess-crash'));
  const first = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(first.status, 0, `initial drain should exit 0; stderr: ${first.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 1, 'the initial drain mints exactly one note');

  const notesAfterFirst = snapshot(path.join(dataDir, 'notes'));
  const vaultAfterFirst = snapshot(vaultDir);

  // Simulate the worst crash state: cursor rolled back to its pre-run offset
  // (as if the crash struck after appendNote but before advanceCursor), AND a
  // stale lock file with a dead PID left on disk.
  const cursorPath = path.join(dataDir, 'cursors', 'distiller', 'sess-crash.json');
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Record<string, unknown>;
  assert.ok((cursor.byte_offset as number) > 0, 'precondition: the healthy cursor advanced past 0');
  cursor.byte_offset = 0;
  fs.writeFileSync(cursorPath, JSON.stringify(cursor, null, 2));

  const lockPath = path.join(dataDir, 'locks', 'distiller.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), token: 'STALE00000000000000000000A', acquired_at: new Date().toISOString() }),
  );

  // Recovery run: the stale lock is recovered, the delta is replayed, but the
  // provenance guard prevents a duplicate note.
  const recovery = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(recovery.status, 0, `recovery drain should exit 0; stderr: ${recovery.stderr}`);

  assert.equal(noteRevisions(dataDir).length, 1, 'the provenance guard must prevent a duplicate note on replay');
  assertIdentical(notesAfterFirst, snapshot(path.join(dataDir, 'notes')), 'note log after crash recovery');
  assertIdentical(vaultAfterFirst, snapshot(vaultDir), 'vault after crash recovery');

  // Cursor healthy again (advanced past the delta) and no lock file survives.
  const recovered = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Record<string, unknown>;
  assert.ok((recovered.byte_offset as number) > 0, 'the cursor must be re-advanced past the replayed delta');
  assert.equal(fs.existsSync(lockPath), false, 'the stale lock must not survive a clean recovery run');

  // The recovery run reports its own counts (the replayed session was seen, and
  // skipped as already-provenanced rather than re-minted).
  assert.match(recovery.stdout, /sessions/, 'the recovery run reports a summary, not "nothing pending"');
  const skipped = readVerdicts(diagnosticsDir).filter(
    (v) => v.session_id === 'sess-crash' && v.decision === 'skipped' && v.reason === 'already_provenanced',
  );
  assert.ok(skipped.length >= 1, 'the replay must record an already_provenanced skip verdict');
});

test('capstone contention: two concurrent drains over one backlog → both exit 0, exactly one set of notes', async () => {
  const root = tempDir('capstone-contention-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  ingest(dataDir, eligibleEvents('sess-a'));
  ingest(dataDir, eligibleEvents('sess-b'));

  const spawnDrain = (): Promise<{ code: number | null }> =>
    new Promise((resolve) => {
      const child = spawn(
        'node',
        [CLI, 'drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--provider-fixture', goodFixture, '--vault', vaultDir],
        { stdio: 'ignore' },
      );
      child.on('close', (code) => resolve({ code }));
    });

  const [r1, r2] = await Promise.all([spawnDrain(), spawnDrain()]);
  assert.equal(r1.code, 0, 'first concurrent drain must exit 0');
  assert.equal(r2.code, 0, 'second concurrent drain must exit 0');

  // End state is identical to a single drain: exactly one note per session, one
  // exported file per note — no duplicates from the race.
  assert.equal(noteRevisions(dataDir).length, 2, 'two sessions must mint exactly two notes despite the race');
  assert.equal(generatedFiles(vaultDir).length, 2, 'exactly one exported file per note');

  // A follow-up single drain is a provable no-op — the concurrent pair fully drained the backlog.
  const notesBefore = snapshot(path.join(dataDir, 'notes'));
  const vaultBefore = snapshot(vaultDir);
  const follow = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(follow.status, 0, `follow-up drain should exit 0; stderr: ${follow.stderr}`);
  assert.match(follow.stdout, /Nothing pending/, 'after two concurrent drains nothing is left pending');
  assertIdentical(notesBefore, snapshot(path.join(dataDir, 'notes')), 'note log after contention');
  assertIdentical(vaultBefore, snapshot(vaultDir), 'vault after contention');
});

test('capstone poison: corrupt event line + an always-failing session → drain exits 0, verdicts name byte ranges, healthy sessions survive', () => {
  const root = tempDir('capstone-poison-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  ingest(dataDir, eligibleEvents('sess-healthy'));
  ingest(dataDir, eligibleEvents('sess-corrupt'));

  // Poison 1: a corrupt mid-file COMPLETE event line — quarantined by byte range immediately.
  const corruptLog = path.join(dataDir, 'events', 'sess-corrupt.ndjson');
  const lines = fs.readFileSync(corruptLog, 'utf8').split('\n').filter((l) => l.length > 0);
  const corruptLine = '{"schema_version":1,"type":"prompt","event_id":"BROKEN' + ',,,';
  fs.writeFileSync(corruptLog, [...lines.slice(0, 5), corruptLine, ...lines.slice(5)].join('\n') + '\n');

  const result = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(result.status, 0, `poison drain should exit 0; stderr: ${result.stderr}`);

  // The healthy session and the de-poisoned session both distill and export in the same run.
  assert.equal(noteRevisions(dataDir).length, 2, 'the healthy AND de-poisoned sessions both distill in the same run');
  assert.equal(generatedFiles(vaultDir).length, 2, 'both surviving notes export in the same run');
  assert.match(result.stdout, /sessions quarantined: 1/, 'the corrupt line is reported as one quarantine');

  // The quarantine verdict in the diagnostics dir names the byte range of the corrupt delta.
  const quarantined = readVerdicts(diagnosticsDir).filter((v) => v.decision === 'quarantined');
  assert.ok(quarantined.length >= 1, 'a quarantine verdict must be written to the diagnostics dir');
  const q = quarantined.find((v) => v.session_id === 'sess-corrupt');
  assert.ok(q, 'the corrupt session must have a quarantine verdict');
  const range = q!.quarantine as Record<string, unknown>;
  assert.equal(typeof range.byte_start, 'number', 'the verdict names byte_start');
  assert.equal(typeof range.byte_end, 'number', 'the verdict names byte_end');
  assert.ok((range.byte_end as number) > (range.byte_start as number), 'the named byte range is non-empty');
  assert.ok(String(q!.reason).includes('bytes'), 'the verdict reason names the byte range');

  // Poison 2: an always-failing provider (non-JSON fixture) over a fresh session.
  // distill() throws for it EVERY attempt; the bounded-retry budget (3) drives
  // it to quarantine on the third drain — exit 0 throughout, healthy sessions
  // untouched. A non-JSON fixture would fail the healthy sessions too, so this
  // session is drained on its own after the healthy backlog is already done.
  fs.mkdirSync(path.join(root, 'bad'), { recursive: true });
  const badFixturePath = writeFixture(path.join(root, 'bad'), 'not json at all — a model ignoring the instruction');
  ingest(dataDir, eligibleEvents('sess-always-fail'));

  // Attempts 1 & 2: distill throws → non-zero exit, attempts climb, cursor unmoved.
  const a1 = drain(dataDir, diagnosticsDir, badFixturePath, vaultDir);
  const a2 = drain(dataDir, diagnosticsDir, badFixturePath, vaultDir);
  assert.notEqual(a1.status, 0, 'the always-fail session errors on attempt 1');
  assert.notEqual(a2.status, 0, 'the always-fail session errors on attempt 2');
  // Attempt 3: budget exhausted → quarantine verdict, cursor advances, exit 0.
  const a3 = drain(dataDir, diagnosticsDir, badFixturePath, vaultDir);
  assert.equal(a3.status, 0, `attempt 3 quarantines and exits 0; stderr: ${a3.stderr}`);

  const failVerdict = readVerdicts(diagnosticsDir).find(
    (v) => v.session_id === 'sess-always-fail' && v.decision === 'quarantined',
  );
  assert.ok(failVerdict, 'the always-failing session must be quarantined after the retry budget');
  const failRange = failVerdict!.quarantine as Record<string, unknown>;
  assert.equal(failRange.attempts, 3, 'the always-fail quarantine records the exhausted attempt count');
  assert.ok(String(failVerdict!.reason).includes('bytes'), 'the always-fail verdict names its byte range');

  // The healthy notes are untouched by all the poison handling.
  assert.equal(noteRevisions(dataDir).length, 2, 'the poison handling never mints or drops a healthy note');
});

test('capstone sacred-log: across crash-recovery and contention re-runs the event log is byte-identical; only legitimate note appends occur', async () => {
  const root = tempDir('capstone-sacred-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  ingest(dataDir, eligibleEvents('sess-a'));
  ingest(dataDir, eligibleEvents('sess-b'));

  // The sacred event log is captured before any distill/recovery churn touches the tree.
  const eventsBefore = snapshot(path.join(dataDir, 'events'));

  // First drain establishes the notes.
  const first = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(first.status, 0, `first drain should exit 0; stderr: ${first.stderr}`);
  const notesAfterFirst = snapshot(path.join(dataDir, 'notes'));
  assert.equal(noteRevisions(dataDir).length, 2, 'two notes minted');

  // Crash-recovery re-run: roll back a cursor, wedge a stale dead-PID lock, drain again.
  const cursorPath = path.join(dataDir, 'cursors', 'distiller', 'sess-a.json');
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Record<string, unknown>;
  cursor.byte_offset = 0;
  fs.writeFileSync(cursorPath, JSON.stringify(cursor, null, 2));
  const lockPath = path.join(dataDir, 'locks', 'distiller.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), token: 'STALE00000000000000000000A', acquired_at: new Date().toISOString() }),
  );
  const recovery = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(recovery.status, 0, `recovery drain should exit 0; stderr: ${recovery.stderr}`);

  // Contention re-run: two concurrent drains over the (now-drained) backlog.
  const spawnDrain = (): Promise<number | null> =>
    new Promise((resolve) => {
      const child = spawn(
        'node',
        [CLI, 'drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--provider-fixture', goodFixture, '--vault', vaultDir],
        { stdio: 'ignore' },
      );
      child.on('close', (code) => resolve(code));
    });
  const [c1, c2] = await Promise.all([spawnDrain(), spawnDrain()]);
  assert.equal(c1, 0, 'concurrent drain 1 exits 0');
  assert.equal(c2, 0, 'concurrent drain 2 exits 0');

  // Sacred-log guarantee: the event log is byte-identical through every re-run.
  assertIdentical(eventsBefore, snapshot(path.join(dataDir, 'events')), 'sacred event log');
  // The note log only ever gained the two legitimate appends — no duplicates
  // from replay or the race, and nothing was rewritten.
  assertIdentical(notesAfterFirst, snapshot(path.join(dataDir, 'notes')), 'note log');
  assert.equal(noteRevisions(dataDir).length, 2, 'all failure bookkeeping stayed out of the note log');
});
