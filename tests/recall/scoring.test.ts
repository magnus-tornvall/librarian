import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCORING_CONFIG,
  rankAndFilter,
  scoreCandidate,
  type ScoredCandidate,
} from '../../src/recall/scoring.ts';

const NOW = '2026-07-05T00:00:00.000Z';

function daysBefore(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 24 * 60 * 60 * 1000).toISOString();
}

test('a project-matching, recent, human/curated candidate outranks a non-matching, old, email/daily candidate at lower raw BM25', () => {
  const projectMatch: ScoredCandidate = {
    note_id: 'a',
    raw_bm25: 2,
    origin: 'human',
    note_type: 'curated',
    created_at: daysBefore(NOW, 1),
    is_project_match: true,
  };
  const nonMatch: ScoredCandidate = {
    note_id: 'b',
    raw_bm25: 5,
    origin: 'email',
    note_type: 'daily',
    created_at: daysBefore(NOW, 200),
    is_project_match: false,
  };

  const ranked = rankAndFilter([nonMatch, projectMatch], DEFAULT_SCORING_CONFIG, NOW);

  assert.deepEqual(
    ranked.map((c) => c.note_id),
    ['a', 'b'],
  );
});

test('a near-zero-BM25 candidate is dropped by the relevance floor', () => {
  const candidate: ScoredCandidate = {
    note_id: 'c',
    raw_bm25: 0.01,
    origin: 'opencode',
    note_type: 'project_summary',
    created_at: NOW,
    is_project_match: false,
  };

  assert.equal(scoreCandidate(candidate, DEFAULT_SCORING_CONFIG, NOW), 0);
  assert.deepEqual(rankAndFilter([candidate], DEFAULT_SCORING_CONFIG, NOW), []);
});
