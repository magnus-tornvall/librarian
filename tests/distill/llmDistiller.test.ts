import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { distill } from '../../src/distill/llmDistiller.ts';
import { makeFixtureProvider } from '../../src/distill/provider.ts';
import type { NoteRevision } from '../../src/note.ts';

const FIXTURE = path.join(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'events',
  'session-001.ndjson',
);

function loadFixtureEvents(): Array<Record<string, unknown>> {
  return readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Expire check before redirect',
  summary: 'Fixed login redirect loop by checking token expiry before redirect.',
});

const SESSION_ID = '01J8X7QK40M8Q3N6P0R5S7TVWX';
const ORIGIN = 'opencode';

test('distill returns a NoteRevision stamped llm, with the passed origin', async () => {
  const events = loadFixtureEvents();
  const note = await distill(events, SESSION_ID, makeFixtureProvider(LLM_RESPONSE), ORIGIN);

  assert.equal(note.kind, 'note_revision');
  assert.equal(note.source.distiller, 'llm');
  assert.equal(note.source.origin, ORIGIN);
});

test('provenance.event_ids has length 4 matching the input events', async () => {
  const events = loadFixtureEvents();
  const note = await distill(events, SESSION_ID, makeFixtureProvider(LLM_RESPONSE), ORIGIN);

  assert.equal(note.provenance.event_ids?.length, 4);
  assert.deepEqual(
    note.provenance.event_ids,
    events.map((e) => e.event_id),
  );
  assert.equal(note.provenance.session_id, SESSION_ID);
});

test('identity and note_id are stamped mechanically as episodic under the note type', async () => {
  const events = loadFixtureEvents();
  const note = await distill(events, SESSION_ID, makeFixtureProvider(LLM_RESPONSE), ORIGIN);

  assert.equal(note.identity.mode, 'episodic');
  assert.ok(note.note_id.startsWith(`${note.note_type}:`));
  // ULID suffix: 26 Crockford-base32 chars.
  const suffix = note.note_id.slice(note.note_type.length + 1);
  assert.match(suffix, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(note.revision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(note.note_id.slice(note.note_type.length + 1), note.revision_id);
});

test('the LLM judgment (type/title/summary) is merged into the note', async () => {
  const events = loadFixtureEvents();
  const note = await distill(events, SESSION_ID, makeFixtureProvider(LLM_RESPONSE), ORIGIN);

  assert.equal(note.note_type, 'decision');
  assert.equal(note.title, 'Expire check before redirect');
  assert.equal(
    note.body.summary,
    'Fixed login redirect loop by checking token expiry before redirect.',
  );
});

test('the LLM cannot dictate identity/provenance even if it tries', async () => {
  const events = loadFixtureEvents();
  // A hostile response smuggling identity fields — they must be ignored.
  const hostile = JSON.stringify({
    note_type: 'decision',
    title: 'x',
    summary: 'y',
    note_id: 'attacker:HIJACKED',
    revision_id: 'HIJACKED',
    provenance: { event_ids: ['forged'] },
  });
  const note = await distill(events, SESSION_ID, makeFixtureProvider(hostile), ORIGIN);

  assert.ok(note.note_id.startsWith(`${note.note_type}:`));
  assert.notEqual(note.note_id, 'attacker:HIJACKED');
  assert.notEqual(note.revision_id, 'HIJACKED');
  assert.deepEqual(
    note.provenance.event_ids,
    events.map((e) => e.event_id),
  );
});

test('fenced ```json response from the provider is parsed', async () => {
  const events = loadFixtureEvents();
  const fenced = '```json\n' + LLM_RESPONSE + '\n```';
  const note = await distill(events, SESSION_ID, makeFixtureProvider(fenced), ORIGIN);
  assert.equal(note.note_type, 'decision');
  assert.equal(note.title, 'Expire check before redirect');
});

test('malformed JSON from the provider throws (no retry in this task)', async () => {
  const events = loadFixtureEvents();
  await assert.rejects(() =>
    distill(events, SESSION_ID, makeFixtureProvider('not json at all'), ORIGIN),
  );
});

test('explicit none returns a decline and defaults a missing or invalid reason', async () => {
  const events = loadFixtureEvents();
  assert.deepEqual(
    await distill(events, SESSION_ID, makeFixtureProvider('{"note_type":"none"}'), ORIGIN),
    { kind: 'declined', reason: '' },
  );
  assert.deepEqual(
    await distill(events, SESSION_ID, makeFixtureProvider('{"note_type":"none","reason":42}'), ORIGIN),
    { kind: 'declined', reason: '' },
  );
});

test('project summaries are project-scoped deterministic revisions chained to the latest revision', async () => {
  const events = loadFixtureEvents();
  const response = JSON.stringify({
    note_type: 'project_summary',
    title: 'Librarian status',
    summary: 'The project summary was refreshed.',
  });
  const previous = {
    kind: 'note_revision',
    schema_version: 1,
    note_id: 'project:librarian:summary',
    revision_id: '01J8X7QK40M8Q3N6P0R5S7TVWY',
    created_at: '2026-07-01T00:00:00.000Z',
    identity: { mode: 'deterministic', key: 'project:librarian:summary' },
    source: { origin: ORIGIN, distiller: 'llm' },
    note_type: 'project_summary',
    title: 'Earlier status',
    scope: { project_slug: 'librarian' },
    provenance: {},
    links: [],
    body: { summary: 'Earlier summary.' },
  } satisfies NoteRevision;

  const note = await distill(events, SESSION_ID, makeFixtureProvider(response), ORIGIN, [previous]);

  assert.equal(note.note_id, 'project:librarian:summary');
  assert.equal(note.previous_revision_id, previous.revision_id);
  assert.deepEqual(note.scope, {
    project_slug: 'librarian',
    git_root: '/Users/magnus/dev/librarian',
    git_remote: 'git@github.com:magnus-tornvall/librarian.git',
  });
});
