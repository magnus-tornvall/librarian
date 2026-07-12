import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll } from '../../src/log/ndjson.ts';
import { readAllNotes } from '../../src/log/noteLog.ts';
import { validateEvent, DiagnosticRecordRejectedError } from '../../src/collector/validateEvent.ts';
import { runDistill } from '../../src/distill/distillRun.ts';
import type { InferenceProvider } from '../../src/distill/provider.ts';
import { importCuratedNote } from '../../src/distill/humanDistiller.ts';

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
const FAITHFUL_RESPONSE = JSON.stringify({ faithful: true, errors: [], reason: 'Supported by the events.' });

function scriptedProvider(responses: string[]): { provider: InferenceProvider; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      async complete(prompt: string): Promise<string> {
        prompts.push(prompt);
        const response = responses.shift();
        if (response === undefined) throw new Error('scripted provider ran out of responses');
        return response;
      },
    },
  };
}

function writeFixture(dir: string): string {
  const fixturePath = path.join(dir, 'llm-response.json');
  fs.writeFileSync(fixturePath, JSON.stringify([LLM_RESPONSE, FAITHFUL_RESPONSE]));
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

/** Write a provider fixture with arbitrary content (used to force a parse error). */
function writeFixtureContent(dir: string, content: string): string {
  const fixturePath = path.join(dir, 'llm-response.json');
  fs.writeFileSync(fixturePath, content);
  return fixturePath;
}

function eventLogPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'events', `${sessionId}.ndjson`);
}

function cursorPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'cursors', 'distiller', `${sessionId}.json`);
}

/** The distiller cursor for a session, or null when no pass has advanced it. */
function readCursorOrNull(dataDir: string, sessionId: string): Record<string, unknown> | null {
  const p = cursorPath(dataDir, sessionId);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) : null;
}

/**
 * Write events straight to the per-session event log, bypassing `collect`.
 * Needed only to exercise distill-side guards on inputs `collect`/`validateEvent`
 * would reject up front (e.g. a missing `resource.agent`).
 */
function writeEventLogDirect(dataDir: string, sessionId: string, events: Array<Record<string, unknown>>): void {
  const logPath = eventLogPath(dataDir, sessionId);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, events.map((e) => JSON.stringify(e) + '\n').join(''));
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

test('distill: faithful first try appends one note after exactly two provider calls', async () => {
  const root = tempDir('cli-distill-verify-faithful-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-verify-faithful';
  ingest(dataDir, eligibleEvents(sessionId));
  const scripted = scriptedProvider([LLM_RESPONSE, FAITHFUL_RESPONSE]);

  const result = await runDistill({ dataDir, diagnosticsDir, provider: scripted.provider });

  assert.equal(result.distilled, 1);
  assert.equal(noteRevisions(dataDir).length, 1);
  assert.equal(scripted.prompts.length, 2);
});

test('distill: an unfaithful draft is re-distilled once with verifier feedback', async () => {
  const root = tempDir('cli-distill-verify-feedback-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-verify-feedback';
  ingest(dataDir, eligibleEvents(sessionId));
  const reason = 'The summary invents a database migration.';
  const unfaithful = JSON.stringify({ faithful: false, errors: ['hallucination'], reason });
  const scripted = scriptedProvider([LLM_RESPONSE, unfaithful, LLM_RESPONSE, FAITHFUL_RESPONSE]);

  const result = await runDistill({ dataDir, diagnosticsDir, provider: scripted.provider });

  assert.equal(result.distilled, 1);
  assert.equal(noteRevisions(dataDir).length, 1);
  assert.equal(scripted.prompts.length, 4);
  assert.match(scripted.prompts[2], new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('distill: two unfaithful verdicts reject without appending and advance the cursor', async () => {
  const root = tempDir('cli-distill-verify-rejected-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-verify-rejected';
  const events = eligibleEvents(sessionId);
  ingest(dataDir, events);
  const unfaithful = JSON.stringify({ faithful: false, errors: ['corruption'], reason: 'The title reverses the event outcome.' });
  const scripted = scriptedProvider([LLM_RESPONSE, unfaithful, LLM_RESPONSE, unfaithful]);

  const result = await runDistill({ dataDir, diagnosticsDir, provider: scripted.provider });

  assert.equal(result.rejected, 1);
  assert.equal(noteRevisions(dataDir).length, 0);
  assert.equal(readCursorOrNull(dataDir, sessionId)!.byte_offset, fs.statSync(eventLogPath(dataDir, sessionId)).size);
  const verdict = readVerdicts(diagnosticsDir).find((v) => v.decision === 'rejected');
  assert.deepEqual(verdict!.verify, { errors: ['corruption'], reason: 'The title reverses the event outcome.', attempts: 2 });
  const rerun = scriptedProvider([]);
  assert.equal((await runDistill({ dataDir, diagnosticsDir, provider: rerun.provider })).rejected, 0);
  assert.equal(rerun.prompts.length, 0);
});

test('distill: malformed verifier JSON follows the normal retry path', async () => {
  const root = tempDir('cli-distill-verify-malformed-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-verify-malformed';
  ingest(dataDir, eligibleEvents(sessionId));
  const scripted = scriptedProvider([LLM_RESPONSE, 'not verifier json']);

  await assert.rejects(runDistill({ dataDir, diagnosticsDir, provider: scripted.provider }), /JSON|verifier/);
  const cursor = readCursorOrNull(dataDir, sessionId)!;
  assert.equal(cursor.byte_offset, 0);
  assert.equal((cursor.failed_attempts as Record<string, unknown>).count, 1);
  assert.equal(noteRevisions(dataDir).length, 0);
});

test('drain: an always-unfaithful scripted provider rejects without appending and exits zero', () => {
  const root = tempDir('cli-drain-verify-rejected-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-drain-rejected';
  ingest(dataDir, eligibleEvents(sessionId));
  const unfaithful = JSON.stringify({ faithful: false, errors: ['omission'], reason: 'The note omits the outcome.' });
  const fixturePath = path.join(root, 'scripted-responses.json');
  fs.writeFileSync(fixturePath, JSON.stringify([LLM_RESPONSE, unfaithful, LLM_RESPONSE, unfaithful]));

  const result = runCli([
    'drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--provider-fixture', fixturePath,
  ], '');

  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /sessions rejected: 1/);
  assert.equal(noteRevisions(dataDir).length, 0);
  assert.equal(readVerdicts(diagnosticsDir).find((v) => v.decision === 'rejected')?.session_id, sessionId);
});

test('distill: curated human imports do not invoke an LLM provider', () => {
  const root = tempDir('cli-distill-human-no-verify-');
  const vaultDir = path.join(root, 'vault');
  const dataDir = path.join(root, 'data');
  const curatedDir = path.join(vaultDir, 'curated');
  fs.mkdirSync(curatedDir, { recursive: true });
  const filePath = path.join(curatedDir, 'runbook.md');
  fs.writeFileSync(filePath, '# Runbook\n\nHuman-authored source content.\n');
  let calls = 0;
  const provider: InferenceProvider = { complete: async () => { calls += 1; return ''; } };
  void provider;

  importCuratedNote(vaultDir, filePath, dataDir);

  assert.equal(calls, 0, 'the human distiller must structurally bypass the provider');
});

test('distill: OpenCode provider stamps its explicit model on the note', () => {
  const root = tempDir('cli-distill-opencode-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  const opencode = path.join(binDir, 'opencode');
  fs.writeFileSync(
    opencode,
    `#!/bin/sh\ncase "$(cat)" in *'Check whether the note is faithful'*) printf '%s' '${FAITHFUL_RESPONSE}' ;; *) printf '%s' '${LLM_RESPONSE}' ;; esac\n`,
  );
  fs.chmodSync(opencode, 0o755);
  ingest(dataDir, eligibleEvents('sess-opencode'));

  const result = spawnSync('node', [
    CLI, 'distill', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir,
    '--provider', 'opencode', '--model', 'test/test',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);
  const notes = noteRevisions(dataDir);
  assert.equal(notes.length, 1);
  assert.equal((notes[0].source as Record<string, unknown>).distiller, 'llm');
  assert.equal((notes[0].source as Record<string, unknown>).model, 'test/test');
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

test('distill: a provider whose output is not JSON fails loud — non-zero exit, no note, cursor not advanced', () => {
  const root = tempDir('cli-distill-badjson-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixtureContent(root, 'not json at all — a model that ignored the instruction');
  const sessionId = 'sess-badjson';

  ingest(dataDir, eligibleEvents(sessionId));

  const result = distill(dataDir, diagnosticsDir, fixturePath);
  assert.notEqual(result.status, 0, 'a JSON parse failure must cause a non-zero exit');
  assert.match(result.stderr, /librarian:/, 'the CLI must name the failure on stderr');

  // Fail loud, bounded (§5/#60): the first failure mints no note and the cursor
  // OFFSET does not advance — the next run retries the same range — but the
  // attempt is now recorded on the cursor so retries are bounded, not infinite.
  assert.equal(noteRevisions(dataDir).length, 0, 'a failed distill must mint no note');
  const cursor = readCursorOrNull(dataDir, sessionId);
  assert.ok(cursor, 'a cursor recording the failed attempt should exist');
  assert.equal(cursor!.byte_offset, 0, 'the cursor offset must not advance when distillation throws');
  assert.equal(
    (cursor!.failed_attempts as Record<string, unknown>).count,
    1,
    'the first failure must record failed_attempts.count = 1',
  );
});

test('distill: an eligible delta missing resource.agent fails loud — non-zero exit, no note, cursor not advanced', () => {
  const root = tempDir('cli-distill-noagent-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-noagent';

  // Build an otherwise-eligible delta (11 events, 2 prompts, 1 write tool) whose
  // events carry NO resource.agent, then strip resource.agent. `collect`/
  // validateEvent would reject this up front, so write the log directly to reach
  // the distill-side origin guard.
  const events = eligibleEvents(sessionId).map((e) => {
    const resource = { ...(e.resource as Record<string, unknown>) };
    delete resource.agent;
    return { ...e, resource };
  });
  writeEventLogDirect(dataDir, sessionId, events);

  const result = distill(dataDir, diagnosticsDir, fixturePath);
  assert.notEqual(result.status, 0, 'a missing resource.agent must cause a non-zero exit');
  assert.match(result.stderr, /resource\.agent/, 'the error must name the missing resource.agent');

  assert.equal(noteRevisions(dataDir).length, 0, 'no origin-less note may be minted (§4 fail-closed)');
  // Bounded (§5/#60): the origin guard is a failure that participates in the
  // retry budget — offset unmoved, attempt recorded.
  const cursor = readCursorOrNull(dataDir, sessionId);
  assert.ok(cursor, 'a cursor recording the failed attempt should exist');
  assert.equal(cursor!.byte_offset, 0, 'the cursor offset must not advance when the origin guard throws');
  assert.equal(
    (cursor!.failed_attempts as Record<string, unknown>).count,
    1,
    'the first failure must record failed_attempts.count = 1',
  );
});

test('distill: a written verdict is a collector poison-pill — validateEvent hard-rejects it', () => {
  const root = tempDir('cli-distill-poison-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-poison';

  // A skip produces a verdict record; read it back from the diagnostics dir.
  ingest(dataDir, [
    readToolEvent(sessionId, 1, 'README.md'),
    readToolEvent(sessionId, 2, 'src/index.ts'),
    readToolEvent(sessionId, 3, 'package.json'),
  ]);
  const result = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);

  const verdictDir = path.join(diagnosticsDir, 'distill');
  const verdicts = fs
    .readdirSync(verdictDir)
    .filter((n) => n.endsWith('.ndjson'))
    .flatMap((n) => readAll(path.join(verdictDir, n)) as Array<Record<string, unknown>>);
  assert.equal(verdicts.length, 1, 'exactly one verdict should be written');

  // §8 poison-pill: if a verdict ever leaked into the collector it would be
  // hard-rejected by construction. Prove it cross-module (mirrors the
  // injection-trace invariant test).
  assert.throws(
    () => validateEvent(verdicts[0]),
    DiagnosticRecordRejectedError,
    'a distill verdict must be hard-rejected by validateEvent',
  );
});

test('distill: a partial trailing line is left unconsumed until it completes', () => {
  const root = tempDir('cli-distill-partial-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-partial';

  // Ingest a complete eligible batch through the real collect path.
  ingest(dataDir, eligibleEvents(sessionId));
  const logPath = eventLogPath(dataDir, sessionId);
  const completeBytes = fs.statSync(logPath).size;

  // Append a partial (newline-less) JSON fragment, as a still-being-written line.
  const partialFragment = '{"schema_version":1,"type":"prompt","event_id":"01J8X7QK99Z9R4M2N6P0S5T7WY"';
  fs.appendFileSync(logPath, partialFragment);
  assert.ok(fs.statSync(logPath).size > completeBytes, 'the partial fragment should be on disk');

  // First pass: the complete events distill; the partial line is ignored, so the
  // cursor stops exactly at the last complete newline (§5), not at EOF.
  const first = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(first.status, 0, `distill should exit 0; stderr: ${first.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 1, 'the complete events should distill into one note');
  const cursorAfterFirst = readCursorOrNull(dataDir, sessionId);
  assert.ok(cursorAfterFirst, 'a cursor should exist after the first pass');
  assert.equal(
    cursorAfterFirst!.byte_offset,
    completeBytes,
    'the cursor must stop before the partial trailing line, not at EOF',
  );

  // Complete the partial line; now the pending delta becomes processable.
  fs.appendFileSync(logPath, ',"prompt":"finish the thought","ts":"2026-07-05T09:99:00.000Z","resource":{"agent":"claude-code","machine_id":"m","cwd":"/x"},"context":{"session_id":"' + sessionId + '","cwd":"/x"}}\n');
  const eof = fs.statSync(logPath).size;

  // Second pass: the now-complete line is a 1-event delta — below MIN_EVENTS, so
  // it is skipped, but it IS processed (a skipped delta advances the cursor to
  // EOF). The key invariant: the completed line is no longer pending.
  const second = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(second.status, 0, `distill should exit 0; stderr: ${second.stderr}`);
  const cursorAfterSecond = readCursorOrNull(dataDir, sessionId);
  assert.equal(
    cursorAfterSecond!.byte_offset,
    eof,
    'once completed, the trailing line is consumed and the cursor reaches EOF',
  );
});

/** Spawn `librarian distill` without blocking, resolving to {status, stderr}. */
function distillAsync(
  dataDir: string,
  diagnosticsDir: string,
  fixturePath: string,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [
        CLI,
        'distill',
        '--data-dir',
        dataDir,
        '--diagnostics-dir',
        diagnosticsDir,
        '--provider-fixture',
        fixturePath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test('distill: two concurrent spawns over one eligible session mint exactly one note; both exit 0', async () => {
  const root = tempDir('cli-distill-concurrent-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-concurrent';

  ingest(dataDir, eligibleEvents(sessionId));

  // Fire both distill processes at once and let them race the same backlog. The
  // single-writer lock (§5, issue #59) must let exactly one drain it: without
  // the lock both read the same delta before either advances its cursor, and
  // both append a note — the duplicate-memory bug the lock exists to close.
  const [a, b] = await Promise.all([
    distillAsync(dataDir, diagnosticsDir, fixturePath),
    distillAsync(dataDir, diagnosticsDir, fixturePath),
  ]);

  // Both exit 0: the winner distills; the loser finds the lock held by a live
  // fresh process and returns cleanly — a normal outcome under lazy triggering.
  assert.equal(a.status, 0, `first spawn should exit 0; stderr: ${a.stderr}`);
  assert.equal(b.status, 0, `second spawn should exit 0; stderr: ${b.stderr}`);

  // Exactly one note, no matter which process won the lock.
  assert.equal(
    noteRevisions(dataDir).length,
    1,
    'two concurrent distill runs over one session must mint exactly one note',
  );

  // At most one spawn reports the lock held: if they truly overlapped the loser
  // says so; if the first fully finished (acquire→distill→release) before the
  // second even tried, the second acquires cleanly, reads an already-drained
  // backlog, and mints nothing — still exactly one note either way. What must
  // NEVER happen is both draining: that shows up as the note count above.
  const noticed = [a, b].filter((r) => /already running/.test(r.stderr));
  assert.ok(noticed.length <= 1, 'the lock notice must never fire on both spawns');

  // No lock file survives a clean run — both released in finally (DoD).
  assert.equal(
    fs.existsSync(path.join(dataDir, 'locks', 'distiller.lock')),
    false,
    'no lock file may remain after a clean run',
  );
});

// ── Re-distill invariant by provenance (issue #61, §5, roadmap item 9) ──────────
// Nasty-path: the two windows that re-distill an already-provenanced range —
// (1) a crash between appendNote and advanceCursor, simulated by rolling the
// cursor back to its pre-run offset; (2) a lost/corrupt cursor rewound to 0,
// simulated with garbage bytes. Both must yield EXACTLY ONE note for the range,
// a healthy cursor, and an `already_provenanced` verdict — not a duplicate note.

/** All distill verdicts written under the diagnostics dir, newest-segment last. */
function readVerdicts(diagnosticsDir: string): Array<Record<string, unknown>> {
  const verdictDir = path.join(diagnosticsDir, 'distill');
  if (!fs.existsSync(verdictDir)) return [];
  return fs
    .readdirSync(verdictDir)
    .filter((n) => n.endsWith('.ndjson'))
    .sort()
    .flatMap((n) => readAll(path.join(verdictDir, n)) as Array<Record<string, unknown>>);
}

test('distill: cursor rolled back to its pre-run offset re-runs to exactly one note (append-then-crash window)', () => {
  const root = tempDir('cli-distill-rollback-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-rollback';

  ingest(dataDir, eligibleEvents(sessionId));

  // First pass distills and advances the cursor to EOF.
  const first = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(first.status, 0, `first distill should exit 0; stderr: ${first.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 1, 'first pass mints one note');
  const advanced = readCursorOrNull(dataDir, sessionId);
  assert.ok(advanced, 'a cursor should exist after the first pass');

  // Simulate the crash between appendNote and advanceCursor: the note is durable
  // but the cursor never advanced — roll it back to the pre-run offset (0).
  const rolledBack = { ...advanced!, byte_offset: 0 };
  fs.writeFileSync(cursorPath(dataDir, sessionId), JSON.stringify(rolledBack, null, 2));

  // Re-run: the provenance guard sees the existing note covering this range and
  // skips the second append — exactly one note, cursor re-advanced.
  const second = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(second.status, 0, `re-run should exit 0; stderr: ${second.stderr}`);
  assert.equal(
    noteRevisions(dataDir).length,
    1,
    're-distilling a rolled-back cursor must NOT mint a second note for the same range',
  );

  // Cursor healthy again (advanced past the replayed delta).
  const healed = readCursorOrNull(dataDir, sessionId);
  const logBytes = fs.statSync(eventLogPath(dataDir, sessionId)).size;
  assert.equal(healed!.byte_offset, logBytes, 'cursor must re-advance to EOF after the guarded replay');

  // An already_provenanced verdict was written for the skipped replay.
  const verdicts = readVerdicts(diagnosticsDir);
  assert.ok(
    verdicts.some((v) => v.session_id === sessionId && v.reason === 'already_provenanced'),
    'an already_provenanced verdict must record the skipped re-distill',
  );
});

test('distill: a cursor file of garbage bytes replays from 0 to exactly one note, healthy cursor rebuilt', () => {
  const root = tempDir('cli-distill-garbage-cursor-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-garbage-cursor';

  ingest(dataDir, eligibleEvents(sessionId));

  const first = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(first.status, 0, `first distill should exit 0; stderr: ${first.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 1, 'first pass mints one note');

  // Corrupt the cursor file with non-JSON bytes (disk corruption / partial write).
  fs.writeFileSync(cursorPath(dataDir, sessionId), '\x00\xff not json at all \x01');

  const second = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(second.status, 0, `re-run over a garbage cursor should still exit 0; stderr: ${second.stderr}`);

  // Loud warning on stderr — a corrupt cursor is never silent (§5).
  assert.match(
    second.stderr,
    /cursor.*unreadable|treating as offset 0/i,
    'a corrupt cursor must be reported loudly on stderr',
  );

  // Same outcome as rollback: one note (provenance guard), cursor rebuilt healthy.
  assert.equal(
    noteRevisions(dataDir).length,
    1,
    'a garbage cursor must replay duplicate-free — exactly one note for the range',
  );
  const healed = readCursorOrNull(dataDir, sessionId);
  const logBytes = fs.statSync(eventLogPath(dataDir, sessionId)).size;
  assert.ok(healed, 'a healthy cursor must be rebuilt after replay');
  assert.equal(healed!.byte_offset, logBytes, 'the rebuilt cursor must point at EOF');
});

test('distill: the guard blocks only covered ranges — NEW events after a guarded replay distill normally', () => {
  const root = tempDir('cli-distill-guard-control-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-guard-control';

  // Distill once, then roll the cursor back so the next run replays the range.
  ingest(dataDir, eligibleEvents(sessionId));
  const first = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(first.status, 0, `first distill should exit 0; stderr: ${first.stderr}`);
  const advanced = readCursorOrNull(dataDir, sessionId);
  fs.writeFileSync(cursorPath(dataDir, sessionId), JSON.stringify({ ...advanced!, byte_offset: 0 }, null, 2));

  // The guarded replay mints nothing.
  const replay = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(replay.status, 0, `guarded replay should exit 0; stderr: ${replay.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 1, 'the guarded replay mints no note');

  // Now append a genuinely NEW eligible delta (turns well past the first batch).
  const fresh: Array<Record<string, unknown>> = [
    promptEvent(sessionId, 40, 'add rate limiting to the token endpoint'),
    writeToolEvent(sessionId, 41, 'src/auth/rateLimit.ts'),
    promptEvent(sessionId, 42, 'and a test for the 429 path'),
  ];
  for (let turn = 43; turn <= 50; turn += 1) {
    fresh.push(readToolEvent(sessionId, turn, `src/fresh-${turn}.ts`));
  }
  ingest(dataDir, fresh);

  // The guard fires only on already-covered ranges: this NEW range distills.
  const third = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(third.status, 0, `distill of the new delta should exit 0; stderr: ${third.stderr}`);
  const notes = noteRevisions(dataDir);
  assert.equal(notes.length, 2, 'a NEW event range after the guard fired must distill into a second note');

  // The second note is provenanced to the NEW delta only, not the guarded range.
  const freshIds = fresh.map((e) => e.event_id);
  const freshNote = notes.find((n) => {
    const ids = (n.provenance as Record<string, unknown>).event_ids as string[];
    return ids.length === freshIds.length && ids[0] === freshIds[0];
  });
  assert.ok(freshNote, 'the second note must cover the new delta');
  assert.deepEqual(
    (freshNote!.provenance as Record<string, unknown>).event_ids,
    freshIds,
    'the new note must be provenanced to the new events only',
  );
});

// ---------------------------------------------------------------------------
// Bounded retries + poison-record quarantine (issue #60, spec §5).
// ---------------------------------------------------------------------------

/** All `quarantined` distill verdicts under the diagnostics dir. */
function quarantineVerdicts(diagnosticsDir: string): Array<Record<string, unknown>> {
  const verdictDir = path.join(diagnosticsDir, 'distill');
  if (!fs.existsSync(verdictDir)) {
    return [];
  }
  return fs
    .readdirSync(verdictDir)
    .filter((n) => n.endsWith('.ndjson'))
    .flatMap((n) => readAll(path.join(verdictDir, n)) as Array<Record<string, unknown>>)
    .filter((v) => v.decision === 'quarantined');
}

test('distill: a failing delta is retried to MAX_ATTEMPTS then quarantined — cursor advances, exit 0, then unstuck', () => {
  const root = tempDir('cli-distill-quarantine-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-wedge';

  // A provider fixture that is NOT JSON → distill() throws on every attempt (the
  // always-throwing provider the DoD names, via the offline fixture seam).
  const badFixture = writeFixtureContent(root, 'not json — a model that always ignores the instruction');

  const events = eligibleEvents(sessionId);
  ingest(dataDir, events);
  const logPath = eventLogPath(dataDir, sessionId);
  const wedgedBytes = fs.statSync(logPath).size;
  const logBefore = fs.readFileSync(logPath); // sacred-log snapshot

  // Runs 1 and 2: under budget → non-zero exit, no note, OFFSET unmoved,
  // failed_attempts.count climbing.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = distill(dataDir, diagnosticsDir, badFixture);
    assert.notEqual(r.status, 0, `attempt ${attempt} (< MAX) must exit non-zero`);
    assert.equal(noteRevisions(dataDir).length, 0, `attempt ${attempt} must mint no note`);
    const cursor = readCursorOrNull(dataDir, sessionId);
    assert.ok(cursor, `attempt ${attempt} must record a cursor`);
    assert.equal(cursor!.byte_offset, 0, `attempt ${attempt} must leave the offset unmoved`);
    assert.equal(
      (cursor!.failed_attempts as Record<string, unknown>).count,
      attempt,
      `attempt ${attempt} must record failed_attempts.count = ${attempt}`,
    );
    // No quarantine yet — still under budget.
    assert.equal(quarantineVerdicts(diagnosticsDir).length, 0, 'no quarantine before MAX_ATTEMPTS');
  }

  // Run 3 reaches MAX_ATTEMPTS (=3): quarantine. Verdict in the DIAGNOSTICS dir
  // naming the byte range, cursor advanced past the delta, exit 0 (unstuck).
  const r3 = distill(dataDir, diagnosticsDir, badFixture);
  assert.equal(r3.status, 0, `the run reaching MAX_ATTEMPTS must exit 0; stderr: ${r3.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 0, 'a quarantined delta mints no note');

  const quarantines = quarantineVerdicts(diagnosticsDir);
  assert.equal(quarantines.length, 1, 'exactly one quarantine verdict should be written');
  const q = quarantines[0];
  assert.equal(q.record_class, 'diagnostic', 'the quarantine verdict must be a diagnostic record');
  assert.equal(q.session_id, sessionId, 'the quarantine verdict must name the session');
  const qb = q.quarantine as Record<string, unknown>;
  assert.equal(qb.byte_start, 0, 'the quarantine verdict must name the byte-range start');
  assert.equal(qb.byte_end, wedgedBytes, 'the quarantine verdict must name the byte-range end (delta end)');
  assert.equal(qb.attempts, 3, 'the quarantine verdict must record the attempt count that gave up');
  assert.equal(qb.file_path, logPath, 'the quarantine verdict must name the event log file');
  assert.match(q.reason as string, /gave up after 3 attempts/, 'the reason must name the exhausted budget');

  // The quarantine verdict must NOT be under the data dir (memory is sacred).
  assert.equal(fs.existsSync(path.join(dataDir, 'distill')), false, 'no verdict may live under the data dir');

  // Cursor advanced past the poison delta; failed_attempts cleared (fresh range).
  const cursorAfter = readCursorOrNull(dataDir, sessionId);
  assert.equal(cursorAfter!.byte_offset, wedgedBytes, 'the cursor must advance past the quarantined delta');
  assert.equal(cursorAfter!.failed_attempts, undefined, 'failed_attempts must reset once the offset advances');

  // Sacred log: the event log is byte-identical after the whole wedge→quarantine.
  assert.deepEqual(fs.readFileSync(logPath), logBefore, 'the event log must be byte-identical after quarantine');

  // UNSTUCK: append new GOOD events to the same session and distill with a good
  // fixture — the consumer really is unstuck and processes the fresh delta.
  const goodFixture = writeFixture(root);
  const more = eligibleEvents('sess-wedge-2').map((e, i) => ({
    ...e,
    // re-home onto the same session, keep event_ids unique from the first batch.
    context: { ...(e.context as Record<string, unknown>), session_id: sessionId },
    event_id: `01J8X7QKB${String(i).padStart(1, '0')}Z9R4M2N6P0S5T7WY`,
  }));
  ingest(dataDir, more);

  const r4 = distill(dataDir, diagnosticsDir, goodFixture);
  assert.equal(r4.status, 0, `the unstuck run must exit 0; stderr: ${r4.stderr}`);
  assert.equal(noteRevisions(dataDir).length, 1, 'the appended good events must distill after quarantine');
  const eof = fs.statSync(logPath).size;
  assert.equal(readCursorOrNull(dataDir, sessionId)!.byte_offset, eof, 'the cursor must reach EOF after the unstuck run');
});

test('distill: a corrupt mid-file JSON line is quarantined; the surrounding lines distill normally', () => {
  const root = tempDir('cli-distill-corrupt-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = writeFixture(root);
  const sessionId = 'sess-corrupt';

  // Ingest an eligible batch through the real collect path, then splice a corrupt
  // COMPLETE line into the MIDDLE of the log (bytes stay put — event log is sacred;
  // we only need a poison line on disk to exercise the reader, and it is written
  // directly because collect would reject it up front).
  const events = eligibleEvents(sessionId);
  ingest(dataDir, events);
  const logPath = eventLogPath(dataDir, sessionId);
  const original = fs.readFileSync(logPath, 'utf8');
  const lines = original.split('\n').filter((l) => l.length > 0);
  const corruptLine = '{"schema_version":1,"type":"prompt","event_id":"BROKEN' + ',,,'; // invalid JSON, complete line
  const spliced = [
    ...lines.slice(0, 5),
    corruptLine,
    ...lines.slice(5),
  ].join('\n') + '\n';
  fs.writeFileSync(logPath, spliced);
  const eof = fs.statSync(logPath).size;
  const logAfterSplice = fs.readFileSync(logPath); // snapshot AFTER splice (this is now the sacred log)

  const result = distill(dataDir, diagnosticsDir, fixturePath);
  assert.equal(result.status, 0, `distill should exit 0 despite a corrupt line; stderr: ${result.stderr}`);

  // The surrounding complete lines distilled into one note (the corrupt line is
  // simply absent from provenance, not a run-aborting error).
  const notes = noteRevisions(dataDir);
  assert.equal(notes.length, 1, 'the surrounding complete events must distill into one note');
  const provIds = (notes[0].provenance as Record<string, unknown>).event_ids as string[];
  assert.equal(provIds.length, events.length, 'provenance must cover every VALID event, and no corrupt one');

  // A quarantine verdict was written naming the corrupt line's byte offset, with
  // attempts:null (unparseable bytes get no retry loop).
  const quarantines = quarantineVerdicts(diagnosticsDir);
  assert.equal(quarantines.length, 1, 'exactly one quarantine verdict for the corrupt line');
  const q = quarantines[0];
  const qb = q.quarantine as Record<string, unknown>;
  assert.equal(q.session_id, sessionId, 'the verdict must name the session');
  assert.equal(qb.attempts, null, 'a corrupt line is quarantined with no retry (attempts: null)');
  assert.ok((qb.byte_start as number) >= 0, 'the verdict must name the corrupt byte offset');
  assert.match(q.reason as string, /unparseable event line/, 'the reason must name the parse failure');

  // Cursor reaches EOF — the corrupt line is covered by the advance, never pending.
  assert.equal(readCursorOrNull(dataDir, sessionId)!.byte_offset, eof, 'the cursor must reach EOF past the corrupt line');

  // Sacred log: the corrupt bytes were never rewritten or removed by the reader.
  assert.deepEqual(fs.readFileSync(logPath), logAfterSplice, 'the event log must be byte-identical after the run');
});

test('distill: a corrupt line whose valid remainder keeps failing is quarantined once, not once per retry', () => {
  const root = tempDir('cli-distill-corrupt-retry-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-corrupt-retry';

  // A non-JSON provider fixture → the valid surrounding delta throws every run.
  const badFixture = writeFixtureContent(root, 'not json — a model that always ignores the instruction');

  // Ingest an eligible batch, then splice a corrupt COMPLETE line mid-file.
  const events = eligibleEvents(sessionId);
  ingest(dataDir, events);
  const logPath = eventLogPath(dataDir, sessionId);
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.length > 0);
  const corruptLine = '{"schema_version":1,"type":"prompt","event_id":"BROKEN' + ',,,';
  fs.writeFileSync(logPath, [...lines.slice(0, 5), corruptLine, ...lines.slice(5)].join('\n') + '\n');

  const corruptVerdicts = () =>
    quarantineVerdicts(diagnosticsDir).filter((v) => (v.quarantine as Record<string, unknown>).attempts === null);

  // Runs 1..2 are under the retry budget: the valid remainder fails the provider,
  // the cursor OFFSET stays put, and the corrupt line is NOT re-quarantined —
  // writing it eagerly would loop a verdict over bytes that never parse.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = distill(dataDir, diagnosticsDir, badFixture);
    assert.notEqual(r.status, 0, `attempt ${attempt} (< MAX) must exit non-zero`);
    assert.equal(readCursorOrNull(dataDir, sessionId)!.byte_offset, 0, `attempt ${attempt} leaves the offset unmoved`);
    assert.equal(corruptVerdicts().length, 0, `no corrupt-line verdict while retrying (attempt ${attempt})`);
  }

  // Run 3 reaches MAX_ATTEMPTS: the whole delta is quarantined and the cursor
  // advances past it — the corrupt line is now emitted, exactly once.
  const r3 = distill(dataDir, diagnosticsDir, badFixture);
  assert.equal(r3.status, 0, `the run reaching MAX_ATTEMPTS must exit 0; stderr: ${r3.stderr}`);
  assert.equal(corruptVerdicts().length, 1, 'the corrupt-line verdict is emitted exactly once, on the advancing run');
});
