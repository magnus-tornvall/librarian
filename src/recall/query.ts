import Database from 'better-sqlite3';
import { DEFAULT_SCORING_CONFIG, weightedCandidateScore, type ScoredCandidate, type ScoringConfig } from './scoring.ts';

const RESULT_CAP = 5;

type FtsRow = {
  note_id: string;
  origin: string;
  note_type: string;
  created_at: string;
  last_corroborated_at: string | null;
  valid_at: string | null;
  invalid_at: string | null;
  superseded_by: string | null;
  project_slug: string;
  is_global: number;
  raw_score: number;
};

export type RecallOptions = { projectSlug?: string; global?: boolean; origin?: string; limit?: number };

export type RecallTraceCandidate = ScoredCandidate & {
  score: number;
  cut_reason?: 'below_floor' | 'budget' | 'superseded' | 'ttl_expired';
};

export type WhyNotResult =
  | {
      matched: true;
      note_id: string;
      rank: number;
      raw_score: number;
      post_weight_score: number;
      gate: 'shipped' | 'below_floor' | 'budget' | 'scope_mismatch' | 'superseded' | 'not_yet_valid' | 'ttl_expired';
      superseded_by?: string;
    }
  | { matched: false; note_id: string; gate: 'not_matched_by_bm25' };

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

export function expiryReferenceTimestamp(candidate: Pick<ScoredCandidate, 'created_at'> & { last_corroborated_at?: string | null }): string {
  return candidate.last_corroborated_at && candidate.last_corroborated_at > candidate.created_at
    ? candidate.last_corroborated_at
    : candidate.created_at;
}

function isTtlExpired(candidate: Pick<ScoredCandidate, 'note_type' | 'created_at'> & { last_corroborated_at?: string | null }, config: ScoringConfig, nowIso: string): boolean {
  const ttlDays = config.ttlDays[candidate.note_type] ?? Infinity;
  // Inclusive of the expiry instant (>=): a note is expired exactly at reference + ttlDays.
  // This is deliberately tighter than the invalid_at open-interval check (strict >), since TTL
  // is a shelf-life cutoff, not an open validity window.
  return Date.parse(nowIso) >= Date.parse(expiryReferenceTimestamp(candidate)) + ttlDays * 24 * 60 * 60 * 1000;
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
      `SELECT note_id, origin, note_type, created_at, last_corroborated_at, valid_at, invalid_at, superseded_by, project_slug, is_global, bm25(notes_fts) as raw_score
       FROM notes_fts
       WHERE notes_fts MATCH ? AND ${filterClauses.join(' AND ')}`,
    )
    .all(...params) as FtsRow[];

  const candidates = rows.map((row) => ({
    note_id: row.note_id,
    // FTS5's bm25() is lower-is-better; negate so scoreCandidate's higher-is-better math holds.
    raw_bm25: -row.raw_score,
    origin: row.origin,
    note_type: row.note_type,
    created_at: row.created_at,
    last_corroborated_at: row.last_corroborated_at,
    // A project-scoped query that matched this note's project earns the §6 project
    // boost; a global-scope-only hit does not. Scope now lives in the index, so this
    // is a real signal rather than the old hard-coded false.
    is_project_match: opts.projectSlug !== undefined && row.project_slug === opts.projectSlug,
    valid_at: row.valid_at ?? row.created_at,
    invalid_at: row.invalid_at,
  }));

  const limit = opts.limit ?? RESULT_CAP;
  const scored = candidates
    .map(({ valid_at, invalid_at, ...candidate }) => ({ ...candidate, valid_at, invalid_at, score: weightedCandidateScore(candidate, config, nowIso) }))
    .sort((a, b) => b.score - a.score);
  const active = scored.filter((candidate) =>
    candidate.valid_at <= nowIso &&
    (candidate.invalid_at === null || candidate.invalid_at > nowIso) &&
    !isTtlExpired(candidate, config, nowIso),
  );
  const aboveFloor = active.filter((candidate) => candidate.score >= config.relevanceFloor && candidate.score > 0);
  const shipped = aboveFloor.slice(0, limit);
  const shippedIds = new Set(shipped.map((candidate) => candidate.note_id));
  const budgetCutIds = new Set(aboveFloor.slice(limit).map((candidate) => candidate.note_id));
  const traceCandidates: RecallTraceCandidate[] = scored.map((candidate) => {
    const { valid_at: _validAt, invalid_at: _invalidAt, ...traceCandidate } = candidate;
    if (candidate.invalid_at !== null && candidate.invalid_at <= nowIso) {
      return { ...traceCandidate, cut_reason: 'superseded' };
    }
    if (isTtlExpired(candidate, config, nowIso)) {
      return { ...traceCandidate, cut_reason: 'ttl_expired' };
    }
    if (shippedIds.has(candidate.note_id)) {
      return traceCandidate;
    }
    if (budgetCutIds.has(candidate.note_id)) {
      return { ...traceCandidate, cut_reason: 'budget' };
    }
    return { ...traceCandidate, cut_reason: 'below_floor' };
  });

  return { results: shipped, candidates: traceCandidates };
}

function inScope(row: Pick<FtsRow, 'project_slug' | 'is_global'>, opts: RecallOptions): boolean {
  return (opts.projectSlug !== undefined && row.project_slug === opts.projectSlug) || (opts.global === true && row.is_global === 1);
}

export function whyNot(
  db: Database.Database,
  query: string,
  noteId: string,
  opts: RecallOptions,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  nowIso: string = new Date().toISOString(),
): WhyNotResult {
  const ftsQuery = plainTextFtsQuery(query);
  if (ftsQuery === undefined) {
    return { matched: false, note_id: noteId, gate: 'not_matched_by_bm25' };
  }

  const rows = db
    .prepare(
      `SELECT note_id, origin, note_type, created_at, last_corroborated_at, valid_at, invalid_at, superseded_by, project_slug, is_global, bm25(notes_fts) as raw_score
       FROM notes_fts
       WHERE notes_fts MATCH ?`,
    )
    .all(ftsQuery) as FtsRow[];
  const target = rows.find((row) => row.note_id === noteId);
  if (target === undefined) {
    return { matched: false, note_id: noteId, gate: 'not_matched_by_bm25' };
  }

  const scopedRows = rows.filter((row) => inScope(row, opts));
  const scored = (inScope(target, opts) ? scopedRows : rows)
    .map((row) => ({
      note_id: row.note_id,
      raw_bm25: -row.raw_score,
      origin: row.origin,
      note_type: row.note_type,
      created_at: row.created_at,
      last_corroborated_at: row.last_corroborated_at,
      valid_at: row.valid_at ?? row.created_at,
      invalid_at: row.invalid_at,
      is_project_match: opts.projectSlug !== undefined && row.project_slug === opts.projectSlug,
    }))
    .map((candidate) => ({ ...candidate, score: weightedCandidateScore(candidate, config, nowIso) }))
    .sort((a, b) => b.score - a.score);
  const scoredTarget = scored.find((row) => row.note_id === noteId);
  if (scoredTarget === undefined) {
    throw new Error(`internal error: matched note disappeared from scoring: ${noteId}`);
  }

  const active = scored.filter((row) =>
    row.valid_at <= nowIso &&
    (row.invalid_at === null || row.invalid_at > nowIso) &&
    !isTtlExpired(row, config, nowIso),
  );
  const rank = active.findIndex((row) => row.note_id === noteId) + 1;
  let gate: 'shipped' | 'below_floor' | 'budget' | 'scope_mismatch' | 'superseded' | 'not_yet_valid' | 'ttl_expired';
  if (target.invalid_at !== null && target.invalid_at <= nowIso) {
    gate = 'superseded';
  } else if (target.valid_at !== null && target.valid_at > nowIso) {
    gate = 'not_yet_valid';
  } else if (isTtlExpired(target, config, nowIso)) {
    gate = 'ttl_expired';
  } else if (!inScope(target, opts)) {
    gate = 'scope_mismatch';
  } else if (scoredTarget.score < config.relevanceFloor || scoredTarget.score <= 0) {
    gate = 'below_floor';
  } else if (rank > (opts.limit ?? RESULT_CAP)) {
    gate = 'budget';
  } else {
    gate = 'shipped';
  }

  return {
    matched: true,
    note_id: noteId,
    rank,
    raw_score: scoredTarget.raw_bm25,
    post_weight_score: scoredTarget.score,
    gate,
    ...(gate === 'superseded' && target.superseded_by !== null ? { superseded_by: target.superseded_by } : {}),
  };
}
