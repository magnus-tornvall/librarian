import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../../src/index/schema.ts';
import { recall, recallWithTrace, whyNot } from '../../src/recall/query.ts';
import { DEFAULT_SCORING_CONFIG } from '../../src/recall/scoring.ts';

const NOW = '2026-07-05T00:00:00.000Z';

function seededDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // note-1 and the decoys are global-scoped so the { global: true } queries below can reach them
  // (recall enforces project match or explicit global scope — a scopeless row is unreachable).
  insert.run('note-1', 'rev-1', 'human', 'curated', '2026-07-01T00:00:00.000Z', '', 1, 'librarian recall scoring pipeline');
  // Decoy rows: FTS5's bm25() IDF term collapses to ~0 in a tiny corpus where a term
  // appears in half the documents, so a realistic-sized corpus is needed for a nonzero score.
  for (let i = 0; i < 5; i += 1) {
    insert.run(`decoy-${i}`, `decoy-rev-${i}`, 'human', 'fact', '2026-07-01T00:00:00.000Z', '', 1, `unrelated filler content ${i}`);
  }
  return db;
}

test('a matching note is returned with { global: true }', () => {
  const db = seededDb();
  const results = recall(db, 'librarian', { global: true }, undefined, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].note_id, 'note-1');
});

test('{} (neither project nor global) returns [] even when the note would match', () => {
  const db = seededDb();
  const results = recall(db, 'librarian', {}, undefined, NOW);
  assert.deepEqual(results, []);
});

test('a no-match query returns [], not an error', () => {
  const db = seededDb();
  const results = recall(db, 'nonexistenttermxyz', { global: true }, undefined, NOW);
  assert.deepEqual(results, []);
});

test('syntax-like punctuation queries are treated as plain text, not raw FTS syntax', () => {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('plain-text-note', 'r', 'human', 'curated', '2026-07-01T00:00:00.000Z', '', 1, 'foo bar c operator or payload');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`decoy-${i}`, `dr-${i}`, 'human', 'fact', '2026-07-01T00:00:00.000Z', '', 1, `unrelated filler content ${i}`);
  }

  for (const query of ['foo-bar', 'foo:bar', '"foo bar', '(foo bar)', 'foo OR bar', 'C++']) {
    const results = recall(db, query, { global: true }, undefined, NOW);
    assert.equal(results[0]?.note_id, 'plain-text-note', `${query} should search as plain text`);
  }
});

test('a query with no FTS terms returns [] instead of issuing broad or invalid MATCH', () => {
  const db = seededDb();
  assert.deepEqual(recall(db, '--- "" ()', { global: true }, undefined, NOW), []);
});

test('recallWithTrace records below-floor candidates with their pre-floor weighted score', () => {
  const db = seededDb();
  const result = recallWithTrace(
    db,
    'librarian',
    { global: true },
    { ...DEFAULT_SCORING_CONFIG, relevanceFloor: 999 },
    NOW,
  );

  assert.deepEqual(result.results, []);
  const candidate = result.candidates.find((row) => row.note_id === 'note-1');
  assert.ok(candidate, 'the matching candidate should still appear in trace diagnostics');
  assert.equal(candidate.cut_reason, 'below_floor');
  assert.ok(candidate.score > 0, 'trace score should be the pre-floor weighted score, not the floored zero');
});

test('recall excludes a future-valid note and why-not names its unopened interval', () => {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, valid_at, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('future-note', 'r', 'human', 'curated', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '', 1, 'narwhal launch plan');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`decoy-${i}`, 'r', 'human', 'fact', NOW, NOW, '', 1, `unrelated filler ${i}`);
  }

  assert.deepEqual(recall(db, 'narwhal', { global: true }, undefined, NOW), []);
  const result = whyNot(db, 'narwhal', 'future-note', { global: true }, undefined, NOW);
  assert.ok(result.matched);
  assert.equal(result.gate, 'not_yet_valid');
});

test('why-not ranks active notes exactly as recall does when a superseded row scores first', () => {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, valid_at, invalid_at, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('superseded', 'r', 'human', 'curated', NOW, NOW, '2026-07-04T00:00:00.000Z', '', 1, 'platypus routing');
  insert.run('active', 'r', 'opencode', 'fact', NOW, NOW, null, '', 1, 'platypus routing');
  for (let i = 0; i < 10; i += 1) {
    insert.run(`decoy-${i}`, 'r', 'human', 'fact', NOW, NOW, null, '', 1, `unrelated filler ${i}`);
  }

  assert.deepEqual(recall(db, 'platypus', { global: true, limit: 1 }, undefined, NOW).map((row) => row.note_id), ['active']);
  const result = whyNot(db, 'platypus', 'active', { global: true, limit: 1 }, undefined, NOW);
  assert.ok(result.matched);
  assert.equal(result.rank, 1);
  assert.equal(result.gate, 'shipped');
});

test('recall preserves a year-old decision while an episode keeps the 90-day decay', () => {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('old-decision', 'r', 'opencode', 'decision', '2025-07-05T00:00:00.000Z', 'alpha', 0, 'permanent token strategy');
  insert.run('old-episode', 'r', 'opencode', 'episode', '2025-07-05T00:00:00.000Z', 'alpha', 0, 'permanent token strategy');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`decoy-${i}`, `r-${i}`, 'opencode', 'fact', NOW, 'alpha', 0, `unrelated filler ${i}`);
  }

  const results = recall(db, 'permanent token', { projectSlug: 'alpha' }, undefined, NOW);
  assert.deepEqual(results.map((row) => row.note_id), ['old-decision']);

  const decision = whyNot(db, 'permanent token', 'old-decision', { projectSlug: 'alpha' }, undefined, NOW);
  const episode = whyNot(db, 'permanent token', 'old-episode', { projectSlug: 'alpha' }, undefined, NOW);
  assert.ok(decision.matched && episode.matched);
  assert.equal(decision.post_weight_score, decision.raw_score * 1.5 * 1.2);
  assert.equal(episode.post_weight_score, episode.raw_score * 1.5 * 0.7 * Math.exp(-365 / 90));
  assert.equal(episode.gate, 'below_floor');
});

// --- Scope enforcement (§6 "require project match or explicit global scope") ---
// Scope now lives in notes_fts (project_slug / is_global), so recall filters on it
// in SQL. These tests pin that gate directly, independent of the fixture runner.

/** A corpus where one distinctive term "platypus" is carried by both a project-only
 *  note (project alpha) and a global note, over a realistic decoy corpus. */
function scopedDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // project_slug='alpha', is_global=0 — reachable only via { projectSlug: 'alpha' }.
  insert.run('alpha-note', 'r', 'opencode', 'decision', '2026-07-01T00:00:00.000Z', 'alpha', 0, 'platypus alpha decision');
  // is_global=1 — reachable only via { global: true }.
  insert.run('global-note', 'r', 'human', 'curated', '2026-07-01T00:00:00.000Z', '', 1, 'platypus global runbook');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`decoy-${i}`, `dr-${i}`, 'human', 'fact', '2026-07-01T00:00:00.000Z', '', 1, `unrelated filler content ${i}`);
  }
  return db;
}

test('{ projectSlug } reaches a project-scoped note but NOT a global-only note', () => {
  const db = scopedDb();
  const results = recall(db, 'platypus', { projectSlug: 'alpha' }, undefined, NOW);
  assert.deepEqual(
    results.map((r) => r.note_id),
    ['alpha-note'],
    'a project query must return the project note and must not leak the global-only note',
  );
});

test('{ global: true } reaches a global note but NOT a project-only note', () => {
  const db = scopedDb();
  const results = recall(db, 'platypus', { global: true }, undefined, NOW);
  assert.deepEqual(
    results.map((r) => r.note_id),
    ['global-note'],
    'a global query must return the global note and must not leak the project-only note',
  );
});

test('a project note is invisible to a DIFFERENT project (no cross-project leakage)', () => {
  const db = scopedDb();
  const results = recall(db, 'platypus', { projectSlug: 'beta' }, undefined, NOW);
  assert.deepEqual(results, [], 'project beta must not see project alpha notes');
});

test('{ projectSlug, global } admits both the project note and the global note', () => {
  const db = scopedDb();
  const results = recall(db, 'platypus', { projectSlug: 'alpha', global: true }, undefined, NOW);
  assert.deepEqual(
    results.map((r) => r.note_id).sort(),
    ['alpha-note', 'global-note'],
    'requesting both scopes admits both the project and global notes',
  );
});

test('is_project_match earns the project boost only for the matching project scope', () => {
  const db = new Database(':memory:');
  migrate(db);
  const insert = db.prepare(
    'INSERT INTO notes_fts (note_id, revision_id, origin, note_type, created_at, project_slug, is_global, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Two notes with IDENTICAL origin/note_type/vintage/lexis; the ONLY difference is that
  // the first is project-matched (earns the §6 project boost) and the second is global-only.
  // So the project match — nothing else — must rank it strictly first, proving is_project_match
  // is a real per-row signal now, not the old hard-coded false.
  insert.run('proj-match', 'r', 'human', 'curated', '2026-07-01T00:00:00.000Z', 'alpha', 0, 'platypus shared payload');
  insert.run('global-only', 'r', 'human', 'curated', '2026-07-01T00:00:00.000Z', '', 1, 'platypus shared payload');
  for (let i = 0; i < 5; i += 1) {
    insert.run(`decoy-${i}`, `dr-${i}`, 'human', 'fact', '2026-07-01T00:00:00.000Z', '', 1, `unrelated filler content ${i}`);
  }

  const results = recall(db, 'platypus', { projectSlug: 'alpha', global: true }, undefined, NOW);
  const projMatch = results.find((r) => r.note_id === 'proj-match');
  const globalOnly = results.find((r) => r.note_id === 'global-only');
  assert.ok(projMatch, 'the project-matched note must be recalled');
  assert.ok(globalOnly, 'the global-only note must also be recalled (honest comparison)');
  assert.ok(
    projMatch.score > globalOnly.score,
    `the project-matched note (${projMatch.score.toFixed(4)}) must outscore the global-only note (${globalOnly.score.toFixed(4)}) via the project boost`,
  );
  assert.equal(results[0].note_id, 'proj-match', 'the project-matched note must rank first via the project boost');
});
