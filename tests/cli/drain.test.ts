import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAllNotes, appendNote } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';
// Integration tests for `librarian drain`: spawn the real CLI against real temp
// dirs, ingest events through the real `collect` path, and drive the composed
// distill+export pipeline with the offline fixture provider — never a live model.
//
// The DoD verified here: two consecutive drains over the same backlog — the
// first does all the work, the second is a provable no-op (note log and vault
// byte-identical). Drain writes only: note-log appends, vault/generated/**,
// cursors, locks, diagnostics.

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], stdin: string): ReturnType<typeof spawnSync> {
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

/** An eligible delta: 11 events, 2 prompts, 1 write tool. */
function eligibleEvents(sessionId: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    promptEvent(sessionId, 1, 'fix the login redirect bug, it loops on expired tokens'),
    writeToolEvent(sessionId, 2, 'src/auth/session.ts'),
    promptEvent(sessionId, 3, 'now add a regression test for the expiry path'),
  ];
  for (let turn = 4; turn <= 11; turn += 1) {
    events.push(readToolEvent(sessionId, turn, `src/file-${turn}.ts`));
  }
  return events;
}

/** A low-signal delta: 3 read-only events → skipped. */
function skipEvents(sessionId: string): Array<Record<string, unknown>> {
  return [
    readToolEvent(sessionId, 1, 'README.md'),
    readToolEvent(sessionId, 2, 'src/index.ts'),
    readToolEvent(sessionId, 3, 'package.json'),
  ];
}

const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Expire check before redirect',
  summary: 'Fixed the login redirect loop by checking token expiry before redirect.',
});
const FAITHFUL_RESPONSE = JSON.stringify({ faithful: true, errors: [], reason: 'Supported by the events.' });

function writeFixture(dir: string, content = LLM_RESPONSE): string {
  const fixturePath = path.join(dir, 'llm-response.json');
  fs.writeFileSync(
    fixturePath,
    content === LLM_RESPONSE
      ? JSON.stringify(Array.from({ length: 10 }, (_, index) => [
          JSON.stringify({ note_type: 'decision', title: `Expire check ${index}`, summary: `Fixed redirect case ${index}.` }),
          FAITHFUL_RESPONSE,
        ]).flat())
      : content,
  );
  return fixturePath;
}

function ingest(dataDir: string, events: Array<Record<string, unknown>>): void {
  const stdin = events.map((e) => JSON.stringify(e) + '\n').join('');
  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);
}

function drain(dataDir: string, diagnosticsDir: string, fixturePath: string, vaultDir?: string): ReturnType<typeof spawnSync> {
  const args = ['drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--provider-fixture', fixturePath];
  if (vaultDir !== undefined) {
    args.push('--vault', vaultDir);
  }
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

test('drain: a backlog of healthy + skip + quarantine sessions drains in one run; cursors advance; summary matches', () => {
  const root = tempDir('cli-drain-backlog-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  // Two eligible sessions, one skip session — all distillable in one pass.
  ingest(dataDir, eligibleEvents('sess-a'));
  ingest(dataDir, eligibleEvents('sess-b'));
  ingest(dataDir, skipEvents('sess-skip'));

  const result = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);

  // Two notes minted, both exported under vault/generated/**.
  const notes = noteRevisions(dataDir);
  assert.equal(notes.length, 2, 'two eligible sessions must mint two notes');
  const files = generatedFiles(vaultDir);
  assert.equal(files.length, 2, 'both notes must be exported under vault/generated/**');
  for (const f of files) {
    assert.ok(f.split(path.sep).includes('generated'), `${f} must live under generated/`);
    assert.equal(f.split(path.sep).includes('curated'), false, 'nothing may land under curated/');
  }

  // Summary counts match: 2 distilled, 1 skipped, 0 quarantined, 2 exported.
  assert.match(result.stdout, /sessions distilled: 2/);
  assert.match(result.stdout, /sessions skipped: 1/);
  assert.match(result.stdout, /sessions quarantined: 0/);
  assert.match(result.stdout, /notes exported: 2/);

  // Cursors advanced: a distiller cursor per event log, one exporter cursor.
  for (const sess of ['sess-a', 'sess-b', 'sess-skip']) {
    assert.ok(
      fs.existsSync(path.join(dataDir, 'cursors', 'distiller', `${sess}.json`)),
      `a distiller cursor should exist for ${sess}`,
    );
  }
  assert.ok(fs.existsSync(path.join(dataDir, 'cursors', 'exporter', 'notes.json')), 'an exporter cursor should exist');
});

test('drain: an immediate second drain over the same backlog is a provable no-op (log + vault byte-identical)', () => {
  const root = tempDir('cli-drain-noop-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  ingest(dataDir, eligibleEvents('sess-a'));
  ingest(dataDir, eligibleEvents('sess-b'));

  const first = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(first.status, 0, `first drain should exit 0; stderr: ${first.stderr}`);

  const notesAfterFirst = snapshot(path.join(dataDir, 'notes'));
  const vaultAfterFirst = snapshot(vaultDir);

  const second = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(second.status, 0, `second drain should exit 0; stderr: ${second.stderr}`);
  assert.match(second.stdout, /Nothing pending/, 'the second drain must report nothing pending');

  assertIdentical(notesAfterFirst, snapshot(path.join(dataDir, 'notes')), 'note log');
  assertIdentical(vaultAfterFirst, snapshot(vaultDir), 'vault');
  assert.equal(noteRevisions(dataDir).length, 2, 'the second drain mints no new note');
});

test('drain: a quarantine-destined session does not block healthy sessions in the same run', () => {
  const root = tempDir('cli-drain-quarantine-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');

  // A non-JSON fixture makes distill() throw for EVERY eligible session, so a
  // single drain quarantines nothing yet (attempts climb). To prove the healthy
  // path is not blocked by a poison session, use a good fixture and a session
  // whose corrupt mid-file line is quarantined immediately while the rest
  // distill. Splice a corrupt complete line into one session's event log.
  const goodFixture = writeFixture(root);
  ingest(dataDir, eligibleEvents('sess-healthy'));
  ingest(dataDir, eligibleEvents('sess-poison'));

  const poisonLog = path.join(dataDir, 'events', 'sess-poison.ndjson');
  const lines = fs.readFileSync(poisonLog, 'utf8').split('\n').filter((l) => l.length > 0);
  const corruptLine = '{"schema_version":1,"type":"prompt","event_id":"BROKEN' + ',,,';
  fs.writeFileSync(poisonLog, [...lines.slice(0, 5), corruptLine, ...lines.slice(5)].join('\n') + '\n');

  const result = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(result.status, 0, `drain should exit 0 despite a poison session; stderr: ${result.stderr}`);

  // Both sessions still distill (the corrupt line is dropped from provenance,
  // its bytes quarantined) and both notes export.
  assert.equal(noteRevisions(dataDir).length, 2, 'the healthy AND the de-poisoned session both distill');
  assert.equal(generatedFiles(vaultDir).length, 2, 'both surviving notes export');
  assert.match(result.stdout, /sessions quarantined: 1/, 'the corrupt line is reported as one quarantine');
  assert.match(result.stdout, /sessions distilled: 2/);
  assert.match(result.stdout, /notes exported: 2/);
});

test('drain: a session with several corrupt lines counts as ONE quarantined session, not one per line', () => {
  const root = tempDir('cli-drain-multi-corrupt-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  // One session, THREE corrupt complete lines spliced into its event log. The
  // summary counts distinct quarantined SESSIONS, so this must read as 1, not 3
  // — the "sessions quarantined" noun would otherwise be a lie.
  ingest(dataDir, eligibleEvents('sess-poison'));
  const poisonLog = path.join(dataDir, 'events', 'sess-poison.ndjson');
  const lines = fs.readFileSync(poisonLog, 'utf8').split('\n').filter((l) => l.length > 0);
  const bad = (n: number): string => `{"schema_version":1,"type":"prompt","event_id":"BROKEN${n}` + ',,,';
  const spliced = [
    ...lines.slice(0, 3),
    bad(1),
    ...lines.slice(3, 5),
    bad(2),
    ...lines.slice(5, 7),
    bad(3),
    ...lines.slice(7),
  ].join('\n') + '\n';
  fs.writeFileSync(poisonLog, spliced);

  const result = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /sessions quarantined: 1/, 'three corrupt lines in one session is ONE quarantined session');
  // The surviving events still distilled — the session was not lost.
  assert.equal(noteRevisions(dataDir).length, 1, 'the surrounding valid events still distill');
});

test('drain: a tombstoned note has its generated file removed on the next drain', () => {
  const root = tempDir('cli-drain-tombstone-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const vaultDir = path.join(root, 'vault');
  const goodFixture = writeFixture(root);

  ingest(dataDir, eligibleEvents('sess-a'));
  const first = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(first.status, 0, `first drain should exit 0; stderr: ${first.stderr}`);
  assert.equal(generatedFiles(vaultDir).length, 1, 'the note is exported');

  // A later revision may change its title, which changes the readable filename.
  // Export must remove the old suffix-matched name before materializing the new one.
  const note = noteRevisions(dataDir)[0];
  const revised = {
    ...note,
    revision_id: `${note.revision_id}-renamed`,
    previous_revision_id: note.revision_id,
    created_at: '2098-01-01T00:00:00.000Z',
    title: 'Renamed exported note',
  } as NoteRevision;
  appendNote(dataDir, revised);

  const renamed = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(renamed.status, 0, `rename drain should exit 0; stderr: ${renamed.stderr}`);
  const renamedFiles = generatedFiles(vaultDir);
  assert.equal(renamedFiles.length, 1, 'a title revision must replace its prior generated filename');
  assert.match(path.basename(renamedFiles[0]), /^renamed-exported-note--/);

  // Tombstone the renamed export (latest-record-wins → the tombstone is the
  // winner). The next drain must remove it the way the indexer drops it from
  // the index.
  appendNote(dataDir, {
    kind: 'note_tombstone',
    schema_version: 1,
    note_id: revised.note_id,
    revision_id: `${revised.revision_id}-tomb`,
    previous_revision_id: revised.revision_id,
    reason: 'test tombstone',
    created_at: '2099-01-01T00:00:00.000Z',
    source: { kind: 'cli' },
  });

  const second = drain(dataDir, diagnosticsDir, goodFixture, vaultDir);
  assert.equal(second.status, 0, `second drain should exit 0; stderr: ${second.stderr}`);
  assert.equal(generatedFiles(vaultDir).length, 0, "the tombstoned note's generated file must be removed");
  assert.match(second.stdout, /notes removed: 1/, 'the removal is reported in the summary');
});

test('drain: without --vault, distill happens but no vault is written anywhere', () => {
  const root = tempDir('cli-drain-novault-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const goodFixture = writeFixture(root);

  ingest(dataDir, eligibleEvents('sess-a'));

  const before = snapshot(root);
  const result = drain(dataDir, diagnosticsDir, goodFixture); // no --vault
  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);

  assert.equal(noteRevisions(dataDir).length, 1, 'distill still happens without a vault');
  assert.match(result.stdout, /sessions distilled: 1/);
  assert.doesNotMatch(result.stdout, /notes exported/, 'no export line is printed without a vault');

  // No exporter cursor and no vault-shaped dir was created anywhere under root.
  assert.equal(
    fs.existsSync(path.join(dataDir, 'cursors', 'exporter')),
    false,
    'no exporter cursor may exist when --vault is absent',
  );
  const after = snapshot(root);
  const generated = [...after.keys()].filter((rel) => rel.split(path.sep).includes('generated'));
  assert.deepEqual(generated, [], `no generated/ file may be written without a vault, found: ${generated.join(', ')}`);
  // Sanity: the run did write SOMETHING (notes/cursors/diagnostics), so `before`
  // vs `after` divergence is expected — we only assert the negative above.
  assert.ok(after.size > before.size, 'the drain must have written notes/cursors/diagnostics');
});
