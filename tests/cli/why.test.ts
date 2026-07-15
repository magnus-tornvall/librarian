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

function tempRoot(): { root: string; dataDir: string; diagnosticsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-why-'));
  return { root, dataDir: path.join(root, 'data'), diagnosticsDir: path.join(root, 'diagnostics') };
}

function runCli(args: string[], stdin = ''): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

function note(index: number, overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `fact:why-${index}`,
    revision_id: `rev-${index}`,
    created_at: `2026-07-06T12:${String(index).padStart(2, '0')}:00.000Z`,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'fact',
    title: `Why title ${index}`,
    scope: { project_slug: 'alpha' },
    provenance: {},
    links: [],
    body: { summary: `Why summary ${index} about narwhal routing.` },
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

function snapshotDir(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) {
    return {};
  }
  const walk = (current: string): string[] =>
    fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(current, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  return Object.fromEntries(walk(dir).sort().map((file) => [path.relative(dir, file), fs.readFileSync(file, 'utf8')]));
}

test('why reads real pull and push traces, supports JSON, and handles missing traces', () => {
  const t = tempRoot();
  appendNote(t.dataDir, note(1));
  for (let i = 2; i < 32; i += 1) {
    appendNote(t.dataDir, note(i, { body: { summary: `Unrelated filler note ${i}.` } }));
  }

  const recall = runCli(['recall', 'narwhal', '--project', 'alpha', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(recall.status, 0, `recall should exit 0; stderr: ${recall.stderr}`);
  const pullTrace = readTraces(t.diagnosticsDir).find((trace) => trace.path === 'pull' && trace.query === 'narwhal');
  assert.ok(pullTrace, 'recall must produce the happy-path trace consumed by why');

  const why = runCli(['why', pullTrace.injection_id, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(why.status, 0, `why should exit 0; stderr: ${why.stderr}`);
  assert.match(why.stdout, new RegExp(`Injection: ${pullTrace.injection_id}`));
  assert.match(why.stdout, /Path: pull/);
  assert.match(why.stdout, /Query: narwhal/);
  assert.match(why.stdout, /Config: .*relevanceFloor/);
  assert.match(why.stdout, /fact:why-1: raw=.* -> post=.* shipped/);

  const json = runCli(['why', pullTrace.injection_id, '--json', '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(json.status, 0, `why --json should exit 0; stderr: ${json.stderr}`);
  assert.deepEqual(JSON.parse(json.stdout), pullTrace);

  const inject = runCli(['inject', '--project', 'alpha', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir], 'narwhal');
  assert.equal(inject.status, 0, `inject should exit 0; stderr: ${inject.stderr}`);
  const pushId = inject.stdout.match(/injection_id="([^"]+)"/)?.[1];
  assert.ok(pushId);
  const pushWhy = runCli(['why', pushId, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(pushWhy.status, 0, `why should render push trace; stderr: ${pushWhy.stderr}`);
  assert.match(pushWhy.stdout, /Path: push/);

  const missing = runCli(['why', 'missing-id', '--diagnostics-dir', t.diagnosticsDir]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /trace not found — diagnostics may have been deleted/);
});

test('why-not explains floor, scope, and BM25 misses without writing diagnostics', () => {
  const t = tempRoot();
  for (let i = 0; i < 12; i += 1) {
    appendNote(t.dataDir, note(i, { body: { summary: `commonfloor token appears in every alpha note ${i}.` } }));
  }
  appendNote(t.dataDir, note(50, { note_id: 'fact:why-scope', scope: { project_slug: 'beta' } }));
  appendNote(t.dataDir, note(60, { note_id: 'fact:why-miss', body: { summary: 'No matching animal token here.' } }));

  const recall = runCli(['recall', 'narwhal', '--project', 'alpha', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(recall.status, 0, `recall should seed diagnostics; stderr: ${recall.stderr}`);
  const beforeDiagnostics = snapshotDir(t.diagnosticsDir);

  const floor = runCli(['why-not', 'commonfloor', 'fact:why-0', '--project', 'alpha', '--data-dir', t.dataDir]);
  assert.equal(floor.status, 0, `why-not floor should exit 0; stderr: ${floor.stderr}`);
  assert.match(floor.stdout, /Rank: \d+/);
  assert.match(floor.stdout, /Raw Score: /);
  assert.match(floor.stdout, /Post-weight Score: /);
  assert.match(floor.stdout, /Gate: below_floor/);

  const scope = runCli(['why-not', 'narwhal', 'fact:why-scope', '--project', 'alpha', '--data-dir', t.dataDir]);
  assert.equal(scope.status, 0, `why-not scope should exit 0; stderr: ${scope.stderr}`);
  assert.match(scope.stdout, /Gate: scope_mismatch/);

  const miss = runCli(['why-not', 'narwhal', 'fact:why-miss', '--project', 'alpha', '--data-dir', t.dataDir]);
  assert.equal(miss.status, 0, `why-not miss should exit 0; stderr: ${miss.stderr}`);
  assert.match(miss.stdout, /not matched by BM25 at all/);

  assert.deepEqual(snapshotDir(t.diagnosticsDir), beforeDiagnostics, 'why-not must not write diagnostics');
});

test('why-not reports the undamped score for a year-old decision', () => {
  const t = tempRoot();
  appendNote(t.dataDir, note(1, {
    note_id: 'decision:old-permanent',
    note_type: 'decision',
    created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    body: { summary: 'Permanent credential rotation decision.' },
  }));
  for (let i = 0; i < 5; i += 1) {
    appendNote(t.dataDir, note(10 + i, { body: { summary: `Unrelated filler ${i}.` } }));
  }

  const result = runCli(['why-not', 'permanent credential', 'decision:old-permanent', '--project', 'alpha', '--data-dir', t.dataDir]);
  assert.equal(result.status, 0, `why-not should exit 0; stderr: ${result.stderr}`);
  const raw = Number(result.stdout.match(/Raw Score: ([\d.]+)/)?.[1]);
  const weighted = Number(result.stdout.match(/Post-weight Score: ([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(raw) && Number.isFinite(weighted));
  assert.ok(Math.abs(weighted - raw * 1.8) < 0.0002, `expected undamped score, got ${result.stdout}`);
  assert.match(result.stdout, /Gate: shipped/);
});

test('why-not budget gate matches the pull-path limit of 10, not the scoring cap of 5', () => {
  const t = tempRoot();
  // 8 notes all clear the floor for "narwhal"; ranks 6-8 are cut by the scoring RESULT_CAP (5)
  // but shipped by the pull path (limit 10). why-not must report them as shipped, not budget.
  for (let i = 0; i < 8; i += 1) {
    appendNote(t.dataDir, note(i, { body: { summary: `narwhal routing note ${i} narwhal narwhal.` } }));
  }
  // Decoys without the term keep BM25 IDF positive (a term in every doc scores zero).
  for (let i = 20; i < 50; i += 1) {
    appendNote(t.dataDir, note(i, { note_id: `fact:decoy-${i}`, body: { summary: `Unrelated filler note ${i}.` } }));
  }

  const recall = runCli(['recall', 'narwhal', '--project', 'alpha', '--limit', '10', '--json', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(recall.status, 0, `recall should exit 0; stderr: ${recall.stderr}`);
  const shipped = (JSON.parse(recall.stdout) as Array<{ note_id: string }>).map((row) => row.note_id);
  assert.ok(shipped.length >= 6, `pull path should ship 6+ notes; got ${shipped.length}`);

  for (const noteId of shipped) {
    const result = runCli(['why-not', 'narwhal', noteId, '--project', 'alpha', '--data-dir', t.dataDir]);
    assert.equal(result.status, 0, `why-not should exit 0; stderr: ${result.stderr}`);
    assert.match(result.stdout, /Gate: shipped/, `why-not must report ${noteId} as shipped, not cut, since recall ships it`);
  }
});
