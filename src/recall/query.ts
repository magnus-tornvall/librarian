import Database from 'better-sqlite3';
import { DEFAULT_SCORING_CONFIG, weightedCandidateScore, type ScoredCandidate, type ScoringConfig } from './scoring.ts';

const RESULT_CAP = 5;

type FtsRow = {
  note_id: string;
  origin: string;
  note_type: string;
  created_at: string;
  project_slug: string;
  is_global: number;
  raw_score: number;
};

export type RecallOptions = { projectSlug?: string; global?: boolean; origin?: string; limit?: number };

export type RecallTraceCandidate = ScoredCandidate & {
  score: number;
  cut_reason?: 'below_floor' | 'budget';
};

export type RecallWithTraceResult = {
  results: Array<ScoredCandidate & { score: number }>;
  candidates: RecallTraceCandidate[];
};

function ftsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function plainTextFtsQuery(query: string): string | undefined {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) {
    return undefined;
  }
  return terms.map(ftsTerm).join(' AND ');
}

export function recall(
  db: Database.Database,
  query: string,
  opts: RecallOptions,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  nowIso: string = new Date().toISOString(),
): Array<ScoredCandidate & { score: number }> {
  return recallWithTrace(db, query, opts, config, nowIso).results;
}

export function recallWithTrace(
  db: Database.Database,
  query: string,
  opts: RecallOptions,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  nowIso: string = new Date().toISOString(),
): RecallWithTraceResult {
  if (!opts.projectSlug && !opts.global) {
    return { results: [], candidates: [] }; // push-path rule: require project match or explicit global scope
  }

  const ftsQuery = plainTextFtsQuery(query);
  if (ftsQuery === undefined) {
    return { results: [], candidates: [] };
  }

  // Scope gate enforced in SQL, not post-filtered in JS, so an out-of-scope note
  // never even becomes a candidate (§6 "require project match or explicit global
  // scope"). A note is eligible iff it matches the requested project scope OR the
  // caller explicitly opted into global scope and the note is global-scoped.
  // A note that is neither project-matched nor global is unreachable by design —
  // this is what makes cross-project / cross-repo leakage fixtures (§9) provable.
  const scopeClauses: string[] = [];
  const params: unknown[] = [ftsQuery];
  if (opts.projectSlug) {
    scopeClauses.push('project_slug = ?');
    params.push(opts.projectSlug);
  }
  if (opts.global) {
    scopeClauses.push('is_global = 1');
  }
  const filterClauses = [`(${scopeClauses.join(' OR ')})`];
  if (opts.origin !== undefined) {
    filterClauses.push('origin = ?');
    params.push(opts.origin);
  }

  const rows = db
    .prepare(
      `SELECT note_id, origin, note_type, created_at, project_slug, is_global, bm25(notes_fts) as raw_score
       FROM notes_fts
       WHERE notes_fts MATCH ? AND ${filterClauses.join(' AND ')}`,
    )
    .all(...params) as FtsRow[];

  const candidates: ScoredCandidate[] = rows.map((row) => ({
    note_id: row.note_id,
    // FTS5's bm25() is lower-is-better; negate so scoreCandidate's higher-is-better math holds.
    raw_bm25: -row.raw_score,
    origin: row.origin,
    note_type: row.note_type,
    created_at: row.created_at,
    // A project-scoped query that matched this note's project earns the §6 project
    // boost; a global-scope-only hit does not. Scope now lives in the index, so this
    // is a real signal rather than the old hard-coded false.
    is_project_match: opts.projectSlug !== undefined && row.project_slug === opts.projectSlug,
  }));

  const limit = opts.limit ?? RESULT_CAP;
  const scored = candidates
    .map((candidate) => ({ ...candidate, score: weightedCandidateScore(candidate, config, nowIso) }))
    .sort((a, b) => b.score - a.score);
  const aboveFloor = scored.filter((candidate) => candidate.score >= config.relevanceFloor && candidate.score > 0);
  const shipped = aboveFloor.slice(0, limit);
  const shippedIds = new Set(shipped.map((candidate) => candidate.note_id));
  const budgetCutIds = new Set(aboveFloor.slice(limit).map((candidate) => candidate.note_id));
  const traceCandidates: RecallTraceCandidate[] = scored.map((candidate) => {
    if (shippedIds.has(candidate.note_id)) {
      return candidate;
    }
    if (budgetCutIds.has(candidate.note_id)) {
      return { ...candidate, cut_reason: 'budget' };
    }
    return { ...candidate, cut_reason: 'below_floor' };
  });

  return { results: shipped, candidates: traceCandidates };
}
