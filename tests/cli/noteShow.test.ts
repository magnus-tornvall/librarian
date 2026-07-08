import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendNote, readAllNotes } from '../../src/log/noteLog.ts';
import type { NoteRevision, NoteTombstone } from '../../src/note.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const EVENT_CWD = path.join(os.tmpdir(), 'librarian-note-show-fixture-cwd');

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
      machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX',
      cwd: EVENT_CWD,
    },
    context: { session_id: sessionId, turn, cwd: EVENT_CWD },
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

function eligibleEvents(sessionId: string): Array<Record<string, unknown>> {
  const events = [
    promptEvent(sessionId, 1, 'preserve this exact prompt text'),
    writeToolEvent(sessionId, 2, 'src/provenance.ts'),
    promptEvent(sessionId, 3, 'add the exact regression test'),
  ];
  for (let turn = 4; turn <= 11; turn += 1) {
    events.push(readToolEvent(sessionId, turn, `src/read-${turn}.ts`));
  }
  return events;
}

function ingest(dataDir: string, events: Array<Record<string, unknown>>): void {
  const stdin = events.map((event) => JSON.stringify(event) + '\n').join('');
  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);
}

function distill(dataDir: string, diagnosticsDir: string, fixturePath: string): void {
  const result = runCli([
    'distill',
    '--data-dir',
    dataDir,
    '--diagnostics-dir',
    diagnosticsDir,
    '--provider-fixture',
    fixturePath,
  ]);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);
}

function writeFixture(root: string): string {
  const fixturePath = path.join(root, 'llm-response.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      note_type: 'decision',
      title: 'Provenance drill down',
      summary: 'The command must recover exact source events.',
    }),
  );
  return fixturePath;
}

function baseNote(overrides: Partial<NoteRevision>): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: 'fact:note-show-test',
    revision_id: 'rev-1',
    created_at: '2026-07-05T09:00:00.000Z',
    identity: { mode: 'episodic' },
    source: { origin: 'claude-code', distiller: 'llm' },
    note_type: 'fact',
    title: 'Original title',
    scope: { global: true },
    provenance: {},
    links: [],
    body: { summary: 'Original body.' },
    ...overrides,
  };
}

test('note show --with-provenance --json returns exactly the collected source events in log order', () => {
  const root = tempDir('cli-note-show-provenance-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const sessionId = 'sess-note-show';
  const events = eligibleEvents(sessionId);

  ingest(dataDir, events);
  distill(dataDir, diagnosticsDir, writeFixture(root));

  const [note] = (readAllNotes(dataDir) as Array<Record<string, unknown>>).filter((record) => record.kind === 'note_revision');
  const result = runCli(['note', 'show', note.note_id as string, '--data-dir', dataDir, '--with-provenance', '--json']);

  assert.equal(result.status, 0, `note show should exit 0; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(payload.provenance_events, events, 'provenance_events must be the stored events, verbatim, in log order');
});

test('note show --with-provenance supports event_range when individual event_ids are absent', () => {
  const dataDir = tempDir('cli-note-show-range-');
  const sessionId = 'sess-note-show-range';
  const events = [
    promptEvent(sessionId, 1, 'outside before the range'),
    writeToolEvent(sessionId, 2, 'src/in-range-a.ts'),
    readToolEvent(sessionId, 3, 'src/in-range-b.ts'),
    promptEvent(sessionId, 4, 'outside after the range'),
  ];
  ingest(dataDir, events);
  appendNote(
    dataDir,
    baseNote({
      provenance: {
        session_id: sessionId,
        event_range: {
          from_event_id: events[1].event_id as string,
          to_event_id: events[2].event_id as string,
        },
      },
    }),
  );

  const result = runCli(['note', 'show', 'fact:note-show-test', '--data-dir', dataDir, '--with-provenance', '--json']);

  assert.equal(result.status, 0, `note show should exit 0; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(payload.provenance_events, events.slice(1, 3));
});

test('note show resolves a multi-revision note to the latest revision', () => {
  const dataDir = tempDir('cli-note-show-latest-');
  appendNote(dataDir, baseNote({ revision_id: 'rev-1', title: 'Old title', created_at: '2026-07-05T09:00:00.000Z' }));
  appendNote(dataDir, baseNote({ revision_id: 'rev-2', title: 'Latest title', created_at: '2026-07-05T10:00:00.000Z' }));

  const result = runCli(['note', 'show', 'fact:note-show-test', '--data-dir', dataDir, '--json']);

  assert.equal(result.status, 0, `note show should exit 0; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as { note: NoteRevision };
  assert.equal(payload.note.revision_id, 'rev-2');
  assert.equal(payload.note.title, 'Latest title');
});

test('note show says explicitly when the latest note record is a tombstone', () => {
  const dataDir = tempDir('cli-note-show-tombstone-');
  appendNote(dataDir, baseNote({ created_at: '2026-07-05T09:00:00.000Z' }));
  const tombstone: NoteTombstone = {
    kind: 'note_tombstone',
    schema_version: 1,
    note_id: 'fact:note-show-test',
    revision_id: 'rev-tombstone',
    previous_revision_id: 'rev-1',
    reason: 'obsolete',
    created_at: '2026-07-05T11:00:00.000Z',
    source: { kind: 'cli' },
  };
  appendNote(dataDir, tombstone);

  const result = runCli(['note', 'show', 'fact:note-show-test', '--data-dir', dataDir]);

  assert.equal(result.status, 0, `note show should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /tombstoned/i);
  assert.doesNotMatch(result.stdout, /Original body/);
});

test('note show --with-provenance explains curated human provenance without looking for events', () => {
  const dataDir = tempDir('cli-note-show-curated-');
  appendNote(
    dataDir,
    baseNote({
      note_id: 'curated:abc',
      source: {
        origin: 'human',
        distiller: 'human',
        source_path: 'curated/architecture.md',
        content_hash: 'sha256:abc123',
      },
      note_type: 'curated',
    }),
  );

  const result = runCli(['note', 'show', 'curated:abc', '--data-dir', dataDir, '--with-provenance']);

  assert.equal(result.status, 0, `note show should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /curated\/architecture\.md/);
  assert.match(result.stdout, /sha256:abc123/);
  assert.match(result.stdout, /no event provenance/i);
});

test('note show --with-provenance errors loudly when the session log is missing', () => {
  const dataDir = tempDir('cli-note-show-missing-log-');
  appendNote(
    dataDir,
    baseNote({
      provenance: { session_id: 'missing-session', event_ids: ['01J8X7QK01Z9R4M2N6P0S5T7WY'] },
    }),
  );

  const result = runCli(['note', 'show', 'fact:note-show-test', '--data-dir', dataDir, '--with-provenance']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing provenance session log/);
  assert.match(result.stderr, new RegExp(path.join(dataDir, 'events', 'missing-session.ndjson').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('note show errors on an unknown note_id', () => {
  const dataDir = tempDir('cli-note-show-unknown-');
  const result = runCli(['note', 'show', 'fact:missing', '--data-dir', dataDir]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown note_id: fact:missing/);
});
