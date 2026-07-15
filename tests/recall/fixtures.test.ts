import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../../src/index/schema.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import { recall } from '../../src/recall/query.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import { DEFAULT_SCORING_CONFIG } from '../../src/recall/scoring.ts';

/**
 * Recall calibration gate (§9). Black-box, fixture-driven: this file contains NO
 * per-case logic. It auto-discovers every fixtures/recall/**\/*.json, and for each
 * one seeds a fresh temp note log, runs the REAL indexNotes() -> recall() path, and
 * applies the fixture's assertions. Adding recall coverage means adding a JSON file
 * under fixtures/recall/ — never editing this runner (that is the DoD).
 *
 * It exercises real index/recall behavior end to end (note log -> FTS index ->
 * recall), not rankAndFilter() in isolation, so scope enforcement, tombstones,
 * latest-revision-wins, recency decay, and the relevance floor are all in play.
 */

const FIXTURE_ROOT = path.join(import.meta.dirname, '..', '..', 'fixtures', 'recall');

// A fixed default clock so recency decay is deterministic across machines when a
// fixture omits "now". Fixtures date their notes relative to this.
const DEFAULT_NOW = '2026-07-06T12:00:00.000Z';

type NoteSeed = {
  kind?: 'note_revision' | 'note_tombstone' | 'note_supersession' | 'note_corroboration';
  note_id: string;
  revision_id?: string;
  previous_revision_id?: string;
  note_type?: string;
  origin?: string;
  created_at: string;
  scope?: { project_slug?: string; global?: boolean };
  title?: string;
  body?: { summary?: string; bullets?: string[]; details?: string };
  superseded_by?: string;
  reason?: string;
  corroborated_by?: { session_id: string; event_range?: { from_event_id: string; to_event_id: string } };
};

type Fixture = {
  name: string;
  query: string;
  opts: { projectSlug?: string; global?: boolean };
  now?: string;
  notes: NoteSeed[];
  expect?: {
    include?: string[];
    exclude?: string[];
    orderedBefore?: Array<[string, string]>;
    maxResults?: number;
    empty?: boolean;
  };
  reason?: string;
};

/** Recursively collect every *.json under fixtures/recall/ (nested dirs allowed). */
function discoverFixtureFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...discoverFixtureFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Turn a terse NoteSeed into the full record the note log expects, stamping the
 *  mechanical fields (schema_version, revision_id, identity, provenance, links,
 *  distiller) so fixtures only declare what actually affects recall. */
function materializeNote(seed: NoteSeed): Record<string, unknown> {
  if (seed.kind === 'note_tombstone') {
    assert.ok(
      seed.previous_revision_id,
      `fixture note ${seed.note_id}: a note_tombstone seed must set previous_revision_id`,
    );
    return {
      kind: 'note_tombstone',
      schema_version: 1,
      note_id: seed.note_id,
      revision_id: seed.revision_id ?? `${seed.note_id}::tomb`,
      previous_revision_id: seed.previous_revision_id,
      created_at: seed.created_at,
      source: { kind: 'human' },
    };
  }
  if (seed.kind === 'note_supersession') {
    assert.ok(seed.superseded_by, `fixture note ${seed.note_id}: a note_supersession seed must set superseded_by`);
    return {
      kind: 'note_supersession', schema_version: 1, note_id: seed.note_id, superseded_by: seed.superseded_by,
      revision_id: seed.revision_id ?? `${seed.note_id}::supersession`, created_at: seed.created_at,
      reason: seed.reason, source: { kind: 'cli' },
    };
  }
  if (seed.kind === 'note_corroboration') {
    assert.ok(seed.corroborated_by, `fixture note ${seed.note_id}: a note_corroboration seed must set corroborated_by`);
    return {
      kind: 'note_corroboration', schema_version: 1, note_id: seed.note_id,
      revision_id: seed.revision_id ?? `${seed.note_id}::corroboration`, created_at: seed.created_at,
      corroborated_by: seed.corroborated_by, source: { kind: 'novelty_gate' },
    };
  }

  assert.ok(seed.note_type, `fixture note ${seed.note_id}: note_type is required`);
  assert.ok(seed.origin, `fixture note ${seed.note_id}: origin is required`);
  assert.ok(seed.title, `fixture note ${seed.note_id}: title is required`);
  assert.ok(seed.body?.summary, `fixture note ${seed.note_id}: body.summary is required`);

  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: seed.note_id,
    revision_id: seed.revision_id ?? `${seed.note_id}::rev`,
    created_at: seed.created_at,
    identity: { mode: 'episodic' },
    source: { origin: seed.origin, distiller: 'llm' },
    note_type: seed.note_type,
    title: seed.title,
    scope: seed.scope ?? {},
    provenance: {},
    links: [],
    body: seed.body,
  };
}

function loadFixture(file: string): Fixture {
  const raw = fs.readFileSync(file, 'utf8');
  const fixture = JSON.parse(raw) as Fixture;
  assert.ok(fixture.name, `${file}: fixture is missing "name"`);
  assert.equal(typeof fixture.query, 'string', `${file}: fixture "query" must be a string`);
  assert.ok(fixture.opts, `${file}: fixture is missing "opts"`);
  assert.ok(Array.isArray(fixture.notes), `${file}: fixture "notes" must be an array`);
  return fixture;
}

/** Seed a fixture's notes into a fresh temp log, index them, and run recall(). */
function runRecallFixture(fixture: Fixture): Array<{ note_id: string; score: number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fixture-'));
  const dataDir = path.join(root, 'data');
  const cursorPath = path.join(dataDir, 'cursor.json');

  for (const seed of fixture.notes) {
    appendNote(dataDir, materializeNote(seed));
  }

  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, dataDir, cursorPath);

  return recall(db, fixture.query, fixture.opts, DEFAULT_SCORING_CONFIG, fixture.now ?? DEFAULT_NOW);
}

function applyAssertions(fixture: Fixture, results: Array<{ note_id: string; score: number }>): void {
  const ids = results.map((r) => r.note_id);
  const expect = fixture.expect ?? {};

  if (expect.empty === true) {
    // §6 push austerity: an empty recall is a valid, expected outcome.
    assert.deepEqual(results, [], `${fixture.name}: expected an empty recall (${fixture.reason ?? ''})`);
  }

  for (const id of expect.include ?? []) {
    assert.ok(ids.includes(id), `${fixture.name}: expected result to INCLUDE ${id}, got [${ids.join(', ')}]`);
  }

  for (const id of expect.exclude ?? []) {
    assert.ok(
      !ids.includes(id),
      `${fixture.name}: expected result to EXCLUDE distractor ${id}, got [${ids.join(', ')}] (${fixture.reason ?? ''})`,
    );
  }

  for (const [before, after] of expect.orderedBefore ?? []) {
    const iBefore = ids.indexOf(before);
    const iAfter = ids.indexOf(after);
    assert.ok(iBefore !== -1, `${fixture.name}: orderedBefore expects ${before} to be present, got [${ids.join(', ')}]`);
    assert.ok(iAfter !== -1, `${fixture.name}: orderedBefore expects ${after} to be present, got [${ids.join(', ')}]`);
    assert.ok(
      iBefore < iAfter,
      `${fixture.name}: expected ${before} to rank strictly before ${after}, got [${ids.join(', ')}]`,
    );
  }

  if (typeof expect.maxResults === 'number') {
    assert.ok(
      results.length <= expect.maxResults,
      `${fixture.name}: expected at most ${expect.maxResults} results, got ${results.length}`,
    );
  }
}

const fixtureFiles = discoverFixtureFiles(FIXTURE_ROOT);

// Guard the guard: if auto-discovery silently found nothing, the whole gate would be
// vacuously green. Fail loudly instead — the DoD requires >= 4 negative fixtures.
test('recall fixture auto-discovery finds fixture files', () => {
  assert.ok(
    fixtureFiles.length >= 4,
    `expected >= 4 recall fixtures under ${FIXTURE_ROOT}, found ${fixtureFiles.length}`,
  );
});

for (const file of fixtureFiles) {
  const fixture = loadFixture(file);
  test(`recall fixture: ${fixture.name} [${path.relative(FIXTURE_ROOT, file)}]`, () => {
    const results = runRecallFixture(fixture);
    applyAssertions(fixture, results);
  });
}
