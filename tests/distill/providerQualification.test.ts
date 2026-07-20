import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAllNotes } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures', 'provider-qualification');
const LINK_TYPES = new Set(['note', 'entity', 'project', 'file', 'url']);
const NOTE_TYPES = new Set(['fact', 'decision', 'project_summary', 'person', 'daily', 'episode', 'curated']);

type Expected = {
  outcome?: 'note' | 'noop';
  note_type?: NoteRevision['note_type'];
  identity_mode?: NoteRevision['identity']['mode'];
  note_id?: string;
  project_slug: string;
  session_id: string;
  from_event_id: string;
  to_event_id: string;
  required_links?: NoteRevision['links'];
};

const fixtureDirs = fs.readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(FIXTURES, entry.name))
  .sort();

function runCli(args: string[], stdin = ''): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  assert.equal(typeof value, 'string', `${field}: expected a string`);
  assert.ok(value.length > 0, `${field}: expected a non-empty string`);
}

function validateNote(value: unknown): asserts value is NoteRevision {
  assert.ok(typeof value === 'object' && value !== null, 'note: expected an object');
  const note = value as Partial<NoteRevision>;
  assert.equal(note.kind, 'note_revision', 'kind');
  assert.equal(note.schema_version, 1, 'schema_version');
  nonEmpty(note.note_id, 'note_id');
  nonEmpty(note.revision_id, 'revision_id');
  nonEmpty(note.created_at, 'created_at');
  assert.ok(NOTE_TYPES.has(note.note_type ?? ''), 'note_type: expected a supported type');
  nonEmpty(note.title, 'title');
  assert.ok(note.identity?.mode === 'episodic' || note.identity?.mode === 'deterministic', 'identity.mode');
  nonEmpty(note.source?.origin, 'source.origin');
  assert.equal(note.source?.distiller, 'llm', 'source.distiller');
  assert.ok(typeof note.scope === 'object' && note.scope !== null, 'scope');
  assert.ok(typeof note.provenance === 'object' && note.provenance !== null, 'provenance');
  nonEmpty(note.body?.summary, 'body.summary');
  assert.ok(Array.isArray(note.links), 'links: expected an array');
  note.links.forEach((link, index) => {
    assert.ok(LINK_TYPES.has(link.target_type), `links[${index}].target_type`);
    nonEmpty(link.target, `links[${index}].target`);
    assert.ok(link.relation === undefined || typeof link.relation === 'string', `links[${index}].relation`);
  });
}

test('provider qualification discovers at least three fixtures', () => {
  assert.ok(fixtureDirs.length >= 3, `expected at least 3 fixtures, found ${fixtureDirs.length}`);
});

for (const fixtureDir of fixtureDirs) {
  const name = path.basename(fixtureDir);
  test(`provider qualification: ${name}`, () => {
    try {
      const expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8')) as Expected;
      const events = fs.readFileSync(path.join(fixtureDir, 'events.ndjson'), 'utf8');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `librarian-qualify-${name}-`));
      const dataDir = path.join(root, 'data');
      const diagnosticsDir = path.join(root, 'diagnostics');

      const collect = runCli(['collect', '--data-dir', dataDir], events);
      assert.equal(collect.status, 0, `collect exited ${collect.status}: ${collect.stderr}`);

      const provider = process.env.QUALIFY_PROVIDER;
      const model = process.env.QUALIFY_MODEL;
      if (provider === 'opencode' && !model) {
        assert.fail('QUALIFY_MODEL is required when QUALIFY_PROVIDER=opencode');
      }
      const providerArgs = provider
        ? ['--provider', provider, ...(model ? ['--model', model] : [])]
        : ['--provider-fixture', path.join(fixtureDir, 'response.json'), '--model', 'fixture/qualification'];
      const command = expected.outcome === 'noop' ? 'drain' : 'distill';
      const distilled = runCli([
        command,
        '--data-dir', dataDir,
        '--diagnostics-dir', diagnosticsDir,
        ...providerArgs,
      ]);
      assert.equal(distilled.status, 0, `distill exited ${distilled.status}: ${distilled.stderr}`);

      const notes = readAllNotes(dataDir);
      if (expected.outcome === 'noop') {
        assert.match(distilled.stdout, /sessions noops: 1/, 'drain reports one noop');
        assert.equal(notes.length, 0, `NOOP lands no note, found ${notes.length}`);
        const verdictDir = path.join(diagnosticsDir, 'distill');
        const verdicts = fs.readdirSync(verdictDir)
          .flatMap((file) => fs.readFileSync(path.join(verdictDir, file), 'utf8').trim().split('\n'))
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(verdicts.filter((verdict) => verdict.decision === 'noop').length, 1, 'one noop verdict');
        const cursor = JSON.parse(fs.readFileSync(path.join(dataDir, 'cursors', 'distiller', `${expected.session_id}.json`), 'utf8')) as { byte_offset: number };
        assert.equal(cursor.byte_offset, fs.statSync(path.join(dataDir, 'events', `${expected.session_id}.ndjson`)).size, 'cursor advances');
        const rerun = runCli(['drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, ...providerArgs]);
        assert.equal(rerun.status, 0, `re-run exited ${rerun.status}: ${rerun.stderr}`);
        assert.match(rerun.stdout, /^Nothing pending/, 're-run reports no pending work');
        assert.equal(readAllNotes(dataDir).length, 0, 're-run distills nothing');
        return;
      }
      assert.equal(notes.length, 1, `note lands: expected 1 note, found ${notes.length}`);
      validateNote(notes[0]);
      const note = notes[0];
      assert.equal(note.note_type, expected.note_type, 'note_type routes as expected');
      assert.equal(note.identity.mode, expected.identity_mode, 'identity.mode routes as expected');
      if (expected.note_id) assert.equal(note.note_id, expected.note_id, 'deterministic note_id');
      assert.equal(note.scope.project_slug, expected.project_slug, 'scope.project_slug');
      assert.equal(note.scope.global, undefined, 'project-scoped notes are not global');
      assert.equal(note.provenance.session_id, expected.session_id, 'provenance.session_id');
      assert.deepEqual(note.provenance.event_range, {
        from_event_id: expected.from_event_id,
        to_event_id: expected.to_event_id,
      }, 'provenance.event_range covers the session');
      if (model || !provider) {
        assert.equal(note.source.model, model ?? 'fixture/qualification', 'source.model');
      }
      for (const required of expected.required_links ?? []) {
        assert.ok(
          note.links.some((link) => link.target_type === required.target_type && link.target === required.target),
          `links includes ${required.target_type}:${required.target}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`${name}: ${message}`);
    }
  });
}
