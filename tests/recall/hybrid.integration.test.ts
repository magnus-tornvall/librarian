import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openIndexWrite } from '../../src/index/database.ts';
import { embedIndexedNotes, indexNotes } from '../../src/index/indexer.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import { recall, whyNot } from '../../src/recall/query.ts';
import { DEFAULT_SCORING_CONFIG } from '../../src/recall/scoring.ts';
import type { EmbeddingProvider } from '../../src/embedding/provider.ts';

/**
 * Hybrid recall (§6, issue #104): BM25 + exact KNN → RRF. Black-box through the
 * real note-log → index → embed → recall path with a canned-vector fake provider.
 * Vectors are unit 2-D so cosine is controllable; the query vector is passed to
 * recall()/whyNot() the same way the pull path passes the embedded query.
 */

const MODEL = { name: 'fixture-embed', digest: 'sha256:v1' };
const NOW = '2026-07-18T12:00:00.000Z';

function dirs(): { dataDir: string; indexDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-'));
  return { dataDir: path.join(root, 'data'), indexDir: path.join(root, 'index') };
}

function note(noteId: string, title: string, summary: string): Record<string, unknown> {
  return {
    kind: 'note_revision', schema_version: 1, note_id: noteId, revision_id: `${noteId}-r1`,
    created_at: NOW, identity: { mode: 'episodic' }, source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'fact', title, scope: { project_slug: 'alpha' }, provenance: {}, links: [],
    body: { summary },
  };
}

/** Fake provider: each note gets a fixed unit vector keyed by a marker in its text. */
function provider(vectorFor: (text: string) => number[]): EmbeddingProvider {
  return { async model() { return MODEL; }, async embed(input) { return vectorFor(input); } };
}

async function seed(
  notes: Array<{ id: string; title: string; summary: string }>,
  vectorFor: (text: string) => number[],
): Promise<ReturnType<typeof openIndexWrite>> {
  const { dataDir, indexDir } = dirs();
  for (const n of notes) appendNote(dataDir, note(n.id, n.title, n.summary));
  const db = openIndexWrite(indexDir);
  indexNotes(db, dataDir);
  await embedIndexedNotes(db, provider(vectorFor), MODEL, NOW);
  return db;
}

test('Swedish query recalls an English note via the KNN channel (cross-language, the supersession case)', async () => {
  // The English note and the Swedish query share NO lexical tokens, so BM25 alone
  // returns nothing — only the semantic (KNN) channel can bridge them.
  const db = await seed(
    [
      { id: 'fact:deploy-en', title: 'Deployment', summary: 'The service deploys to production every friday' },
      { id: 'fact:cats', title: 'Cats', summary: 'the office cat sleeps on the keyboard' },
    ],
    (text) => (text.includes('deploys to production') ? [1, 0] : [0, 1]),
  );
  try {
    const swedishQueryVector = [1, 0]; // "utplacering till produktion" ≈ the English note
    const bm25Only = recall(db, 'utplacering till produktion', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW);
    assert.deepEqual(bm25Only.map((r) => r.note_id), [], 'BM25 alone cannot bridge the languages');

    const hybrid = recall(db, 'utplacering till produktion', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW, swedishQueryVector);
    assert.deepEqual(hybrid.map((r) => r.note_id), ['fact:deploy-en'], 'KNN surfaces the English note');
  } finally {
    db.close();
  }
});

test('fail-soft: no query vector → BM25-only, floor holds (identical to pre-hybrid)', async () => {
  const db = await seed(
    [
      { id: 'fact:bm', title: 'Backups', summary: 'nightly backups run at 2am for the alpha service database' },
      { id: 'fact:other', title: 'Firewall', summary: 'the firewall blocks inbound traffic on port 8080' },
      { id: 'fact:third', title: 'Cache', summary: 'the cache evicts entries after one hour idle' },
    ],
    () => [1, 0],
  );
  try {
    // Endpoint-down is modelled as "no vector reaches recall" — the pull path passes
    // undefined and hybrid must degrade to EXACTLY the pure-BM25 result set + order.
    const bm25Only = recall(db, 'nightly backups', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW);
    assert.deepEqual(bm25Only.map((r) => r.note_id), ['fact:bm'], 'the lexical hit ships on the BM25-only path');

    // Same query WITH a vector that is orthogonal to every note: KNN contributes
    // nothing past its distance floor, so the result is byte-identical to BM25-only.
    const withDeadVector = recall(db, 'nightly backups', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW, [0, 1]);
    assert.deepEqual(withDeadVector.map((r) => r.note_id), bm25Only.map((r) => r.note_id), 'a non-matching vector cannot change the BM25 result');

    const miss = recall(db, 'quantum entanglement', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW);
    assert.deepEqual(miss.map((r) => r.note_id), [], 'a lexical non-match still returns nothing without a vector');
  } finally {
    db.close();
  }
});

test('negative: hybrid does not resurrect a below-floor distractor', async () => {
  // The distractor is neither a strong BM25 match nor a near KNN neighbour (its
  // vector is orthogonal to the query). The per-channel floors must keep it dead.
  const db = await seed(
    [
      { id: 'fact:target', title: 'Migration', summary: 'database migration playbook for the alpha service' },
      { id: 'fact:distractor', title: 'Lunch', summary: 'the cafeteria menu rotates weekly with soup options' },
    ],
    (text) => (text.includes('migration playbook') ? [1, 0] : [0, 1]),
  );
  try {
    const queryVector = [1, 0]; // aligned with the target only
    const results = recall(db, 'migration playbook', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW, queryVector);
    const ids = results.map((r) => r.note_id);
    assert.ok(ids.includes('fact:target'), 'the real match ships');
    assert.ok(!ids.includes('fact:distractor'), 'the orthogonal below-floor distractor is NOT resurrected by hybrid');
  } finally {
    db.close();
  }
});

test('why-not replays the hybrid reach: a KNN-only note is explained, not reported as a BM25 miss', async () => {
  const db = await seed(
    [{ id: 'fact:deploy-en', title: 'Deployment', summary: 'the service deploys to production every friday' }],
    () => [1, 0],
  );
  try {
    const queryVector = [1, 0];
    // Without the recorded vector, why-not can only see the BM25 channel → honest miss.
    const bm25Only = whyNot(db, 'utplacering till produktion', 'fact:deploy-en', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW);
    assert.deepEqual(bm25Only, { matched: false, note_id: 'fact:deploy-en', gate: 'not_matched_by_bm25' });

    // Re-embedding with the recorded digest's vector lets why-not replay the KNN reach.
    const replayed = whyNot(db, 'utplacering till produktion', 'fact:deploy-en', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW, queryVector);
    assert.equal(replayed.matched, true);
    if (replayed.matched) assert.equal(replayed.gate, 'shipped', 'the KNN-reached note explains as shipped, not a BM25 miss');
  } finally {
    db.close();
  }
});

test('12.1 knowledge-update: a contradiction is NOT NOOPed with embeddings on (novelty gate stays BM25)', async () => {
  // Two notes on the same topic with opposite facts embed as near neighbours (same
  // vector). Recall must still surface BOTH — hybrid must not collapse the newer,
  // contradicting note into the old one the way a cosine-NOOP gate would.
  const db = await seed(
    [
      { id: 'fact:kamal-old', title: 'Deploy tool', summary: 'we chose Kamal for deploys' },
      { id: 'fact:kamal-new', title: 'Deploy tool', summary: 'we abandoned Kamal for deploys' },
    ],
    () => [1, 0], // identical vectors: the embedding model sees them as the same topic
  );
  try {
    const queryVector = [1, 0];
    const results = recall(db, 'Kamal deploys', { projectSlug: 'alpha' }, DEFAULT_SCORING_CONFIG, NOW, queryVector);
    const ids = results.map((r) => r.note_id);
    assert.ok(ids.includes('fact:kamal-old') && ids.includes('fact:kamal-new'),
      'both the old and the contradicting note survive hybrid recall — no cosine NOOP');
  } finally {
    db.close();
  }
});
