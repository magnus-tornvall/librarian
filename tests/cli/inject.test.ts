import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll } from '../../src/log/ndjson.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import type { InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';
import type { NoteRevision } from '../../src/note.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempRoot(): { root: string; dataDir: string; diagnosticsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-inject-'));
  return { root, dataDir: path.join(root, 'data'), diagnosticsDir: path.join(root, 'diagnostics') };
}

function runCli(args: string[], stdin = ''): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

function note(index: number, overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `fact:inject-${index}`,
    revision_id: `rev-${index}`,
    created_at: `2026-07-06T10:${String(index).padStart(2, '0')}:00.000Z`,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'decision',
    title: `Inject title ${index}`,
    scope: { project_slug: 'alpha' },
    provenance: {},
    links: [],
    body: { summary: `Inject summary ${index} about wombat failover.` },
    ...overrides,
  };
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

function snapshotNotes(dataDir: string): Record<string, string> {
  const notesDir = path.join(dataDir, 'notes');
  if (!fs.existsSync(notesDir)) {
    return {};
  }
  return Object.fromEntries(
    fs
      .readdirSync(notesDir)
      .filter((name) => name.endsWith('.ndjson'))
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(notesDir, name), 'utf8')]),
  );
}

test('inject CLI renders §6 block, writes matching push trace, and leaves note log unchanged', () => {
  const t = tempRoot();
  appendNote(t.dataDir, note(1));
  for (let i = 0; i < 8; i += 1) {
    appendNote(t.dataDir, note(20 + i, { body: { summary: `Unrelated filler ${i}.` } }));
  }
  const beforeNotes = snapshotNotes(t.dataDir);

  const result = runCli(['inject', '--project', 'alpha', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir], 'wombat\nfailover');
  assert.equal(result.status, 0, `inject should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /^<librarian-memory injection_id="[^"]+" indexed_through="[^"]+">/);
  assert.match(result.stdout, /Possibly relevant prior context\. Prefer current repository evidence and current user instructions if they conflict\./);
  assert.match(result.stdout, /1\. \[decision · llm\/opencode · 2026-07-06 · medium authority\] Inject title 1/);
  assert.match(result.stdout, /src: fact:inject-1#rev-1/);
  assert.match(result.stdout, /<\/librarian-memory>\n$/);

  const injectionId = result.stdout.match(/injection_id="([^"]+)"/)?.[1];
  assert.ok(injectionId);
  const trace = readTraces(t.diagnosticsDir).find((row) => row.injection_id === injectionId);
  assert.ok(trace, 'inject must write a trace with the emitted injection_id');
  assert.equal(trace.path, 'push');
  assert.equal(trace.indexed_through, result.stdout.match(/indexed_through="([^"]+)"/)?.[1]);
  assert.deepEqual(trace.shipped_note_ids, ['fact:inject-1']);
  assert.ok(trace.candidates.every((candidate) => typeof candidate.raw_score === 'number' && typeof candidate.post_weight_score === 'number'));
  assert.ok(trace.config_snapshot);
  assert.deepEqual(snapshotNotes(t.dataDir), beforeNotes, 'inject must not mutate the note log');
});

test('inject CLI enforces push cap and budget, records budget cuts, and fail-closes empty cases', () => {
  const t = tempRoot();
  const longSummary = `${'wombat '.repeat(20)}${'context '.repeat(25)}`;
  for (let i = 0; i < 9; i += 1) {
    appendNote(t.dataDir, note(i, { body: { summary: `${longSummary}${i}` } }));
  }
  for (let i = 0; i < 30; i += 1) {
    appendNote(t.dataDir, note(30 + i, { body: { summary: `Unrelated filler ${i}.` } }));
  }

  const capped = runCli(['inject', '--project', 'alpha', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir], 'wombat');
  assert.equal(capped.status, 0, `capped inject should exit 0; stderr: ${capped.stderr}`);
  assert.ok((capped.stdout.match(/^\d+\. \[/gm) ?? []).length <= 5, 'push block must ship at most five entries');
  assert.ok(capped.stdout.length <= 2400, 'push block must stay under the 600-token chars/4 budget');
  const cappedId = capped.stdout.match(/injection_id="([^"]+)"/)?.[1];
  const cappedTrace = readTraces(t.diagnosticsDir).find((trace) => trace.injection_id === cappedId);
  assert.ok(cappedTrace);
  assert.ok(cappedTrace.candidates.some((candidate) => candidate.cut_reason === 'budget'));

  const noScope = runCli(['inject', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir], 'wombat');
  assert.equal(noScope.status, 0, `no-scope inject should exit 0; stderr: ${noScope.stderr}`);
  assert.equal(noScope.stdout, '');

  const floorRoot = tempRoot();
  for (let i = 0; i < 12; i += 1) {
    appendNote(floorRoot.dataDir, note(i, { body: { summary: `commonfloor token in every note ${i}` } }));
  }
  const belowFloor = runCli(['inject', '--project', 'alpha', '--data-dir', floorRoot.dataDir, '--diagnostics-dir', floorRoot.diagnosticsDir], 'commonfloor');
  assert.equal(belowFloor.status, 0, `below-floor inject should exit 0; stderr: ${belowFloor.stderr}`);
  assert.equal(belowFloor.stdout, '');
  assert.ok(readTraces(floorRoot.diagnosticsDir).some((trace) => trace.candidates.some((candidate) => candidate.cut_reason === 'below_floor')));
});

test('inject --session-start returns project brief and curated notes, or empty when absent', () => {
  const t = tempRoot();
  appendNote(
    t.dataDir,
    note(1, {
      note_id: 'project:alpha:summary',
      revision_id: 'summary-rev',
      note_type: 'project_summary',
      title: 'Alpha project summary',
      body: { summary: 'Alpha summary brief for session start.' },
    }),
  );
  appendNote(
    t.dataDir,
    note(2, {
      note_id: 'curated:alpha-runbook',
      revision_id: 'curated-rev',
      source: { origin: 'human', distiller: 'human', source_path: 'curated/alpha.md' },
      note_type: 'curated',
      title: 'Alpha curated runbook',
      body: { summary: 'Curated alpha runbook for startup context.' },
    }),
  );

  const result = runCli(['inject', '--session-start', '--project', 'alpha', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(result.status, 0, `session-start inject should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /project_summary · llm\/opencode · 2026-07-06 · medium authority/);
  assert.match(result.stdout, /curated · human\/human · 2026-07-06 · high authority/);
  assert.match(result.stdout, /src: project:alpha:summary#summary-rev/);
  assert.match(result.stdout, /src: curated:alpha-runbook#curated-rev/);

  const empty = tempRoot();
  const emptyResult = runCli(['inject', '--session-start', '--project', 'alpha', '--data-dir', empty.dataDir, '--diagnostics-dir', empty.diagnosticsDir]);
  assert.equal(emptyResult.status, 0, `empty session-start inject should exit 0; stderr: ${emptyResult.stderr}`);
  assert.equal(emptyResult.stdout, '');
});
