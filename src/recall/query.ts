import Database from 'better-sqlite3';
import { DEFAULT_SCORING_CONFIG, rankAndFilter, type ScoredCandidate, type ScoringConfig } from './scoring.ts';

const RESULT_CAP = 5;

type FtsRow = {
  note_id: string;
  origin: string;
  note_type: string;
  created_at: string;
  raw_score: number;
};

export function recall(
  db: Database.Database,
  query: string,
  opts: { projectSlug?: string; global?: boolean },
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  nowIso: string = new Date().toISOString(),
): Array<ScoredCandidate & { score: number }> {
  if (!opts.projectSlug && !opts.global) {
    return []; // push-path rule: require project match or explicit global scope
  }

  const rows = db
    .prepare(
      'SELECT note_id, origin, note_type, created_at, bm25(notes_fts) as raw_score FROM notes_fts WHERE notes_fts MATCH ?',
    )
    .all(query) as FtsRow[];

  const candidates: ScoredCandidate[] = rows.map((row) => ({
    note_id: row.note_id,
    // FTS5's bm25() is lower-is-better; negate so scoreCandidate's higher-is-better math holds.
    raw_bm25: -row.raw_score,
    origin: row.origin,
    note_type: row.note_type,
    created_at: row.created_at,
    // ponytail: notes_fts doesn't store per-row project scope yet, so this always misses —
    // real gap, backfilling scope data is a later task, not this one.
    is_project_match: false,
  }));

  return rankAndFilter(candidates, config, nowIso).slice(0, RESULT_CAP);
}
