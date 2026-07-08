import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendNote } from '../../src/log/noteLog.ts';
import { readAll } from '../../src/log/ndjson.ts';
import type { InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';
import type { NoteRevision } from '../../src/note.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

function note(index: number, overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `fact:recall-cli-${index}`,
    revision_id: `rev-${index}`,
    created_at: `2026-07-05T09:${String(index).padStart(2, '0')}:00.000Z`,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'fact',
    title: `Recall CLI title ${index}`,
    scope: { project_slug: 'alpha' },
    provenance: {},
    links: [],
    body: { summary: `Recall CLI summary ${index} with platypus search term.` },
    ...overrides,
  };
}

function seedRecallCorpus(dataDir: string): void {
  for (let i = 0; i < 11; i += 1) {
    appendNote(dataDir, note(i));
  }
  appendNote(dataDir, note(11, { note_id: 'fact:email-origin', source: { origin: 'email', distiller: 'llm' } }));
  appendNote(
    dataDir,
    note(99, {
      note_id: 'fact:punctuation-query',
      revision_id: 'rev-punctuation',
      created_at: '2026-07-05T09:59:00.000Z',
      title: 'Punctuation query title',
      body: { summary: 'The recall CLI should find foo bar syntax safely.' },
    }),
  );
  for (let i = 12; i < 42; i += 1) {
    appendNote(
      dataDir,
      note(i, {
        note_id: `fact:decoy-${i}`,
        body: { summary: `Unrelated filler content ${i}.` },
      }),
    );
  }
}

function readTraces(diagnosticsDir: string): InjectionTrace[] {
  const injectionsDir = path.join(diagnosticsDir, 'injections');
  if (!fs.existsSync(injectionsDir)) {
    return [];
  }
  return fs
    .readdirSync(injectionsDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .flatMap((name) => readAll(path.join(injectionsDir, name)) as InjectionTrace[]);
}

test('recall CLI returns hydrated JSON, enforces filters/caps, fail-closes without scope, and writes pull trace', () => {
  const root = tempDir('cli-recall-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  seedRecallCorpus(dataDir);

  const capped = runCli([
    'recall',
    'platypus',
    '--project',
    'alpha',
    '--limit',
    '50',
    '--json',
    '--data-dir',
    dataDir,
    '--diagnostics-dir',
    diagnosticsDir,
  ]);
  assert.equal(capped.status, 0, `recall should exit 0; stderr: ${capped.stderr}`);
  const cappedPayload = JSON.parse(capped.stdout) as Array<Record<string, unknown>>;
  assert.equal(cappedPayload.length, 10, 'pull recall must cap requested limits at 10');
  for (const field of ['note_id', 'title', 'summary', 'note_type', 'origin', 'created_at', 'project_slug', 'is_global', 'score']) {
    assert.ok(field in cappedPayload[0], `JSON result must include ${field}`);
  }
  assert.equal(cappedPayload[0].project_slug, 'alpha');
  assert.equal(cappedPayload[0].is_global, false);
  const cappedTrace = readTraces(diagnosticsDir).find((trace) => trace.query === 'platypus');
  assert.ok(cappedTrace, 'capped recall should write a trace');
  assert.equal(cappedTrace.shipped_note_ids.length, 10);
  assert.ok(
    cappedTrace.candidates.filter((candidate) => candidate.cut_reason === 'budget').length >= 2,
    'trace should include candidates cut by the pull-path result budget',
  );

  const originFiltered = runCli([
    'recall',
    'platypus',
    '--project',
    'alpha',
    '--origin',
    'email',
    '--json',
    '--data-dir',
    dataDir,
    '--diagnostics-dir',
    diagnosticsDir,
  ]);
  assert.equal(originFiltered.status, 0, `origin-filtered recall should exit 0; stderr: ${originFiltered.stderr}`);
  const originPayload = JSON.parse(originFiltered.stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(originPayload.map((row) => row.note_id), ['fact:email-origin']);
  assert.equal(originPayload[0].origin, 'email');

  const failClosed = runCli([
    'recall',
    'platypus',
    '--json',
    '--data-dir',
    dataDir,
    '--diagnostics-dir',
    diagnosticsDir,
  ]);
  assert.equal(failClosed.status, 0, `bare recall should exit 0; stderr: ${failClosed.stderr}`);
  assert.deepEqual(JSON.parse(failClosed.stdout), []);

  const punctuation = runCli([
    'recall',
    'foo-bar',
    '--project',
    'alpha',
    '--json',
    '--data-dir',
    dataDir,
    '--diagnostics-dir',
    diagnosticsDir,
  ]);
  assert.equal(punctuation.status, 0, `punctuation recall should exit 0; stderr: ${punctuation.stderr}`);
  const punctuationPayload = JSON.parse(punctuation.stdout) as Array<Record<string, unknown>>;
  assert.equal(punctuationPayload[0]?.note_id, 'fact:punctuation-query');

  const traces = readTraces(diagnosticsDir);
  assert.ok(
    traces.some((trace) => trace.path === 'pull' && trace.query === 'platypus' && trace.shipped_note_ids.length > 0),
    'recall CLI must write a diagnostics trace marked as pull',
  );
});
