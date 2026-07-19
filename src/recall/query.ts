import Database from 'better-sqlite3';
import { DEFAULT_SCORING_CONFIG, weightedCandidateScore, type ScoredCandidate, type ScoringConfig } from './scoring.ts';

const RESULT_CAP = 5;

// RRF constant. Score = Σ 1/(k+rank); a larger k flattens the curve so neither
// channel dominates fusion. k=60 is the value from Cormack et al. (SIGIR 2009) and
// the field-standard default (Elasticsearch/OpenSearch ship 60).
const RRF_K = 60;
// How many neighbours the KNN channel fetches. Wider than RESULT_CAP so hybrid can
// SURFACE a cross-language note BM25 never matched, then let fusion + floor decide.
// ponytail: k=50 is an unscoped nearest-neighbour fetch — scope is applied after,
// so in a corpus with 50+ out-of-scope near neighbours an in-scope note past rank
// 50 goes unseen by the KNN channel. Move to a scope-filtered KNN if multi-project
// corpora grow that dense; at note scale this ceiling never bites.
const KNN_FETCH = 50;
// Per-channel KNN floor (§6: "apply per-channel floors before fusion"). vec0
// returns plain L2 distance; on unit-norm embeddings that is √(2·(1−cosine)), so
// this cutoff of 0.8 ≈ cosine ≥ 0.68. A neighbour beyond it is a distractor and
// never enters fusion — this is what keeps hybrid from resurrecting below-floor notes.
const KNN_DISTANCE_FLOOR = 0.8;

type FtsRow = {
  note_id: string;
  origin: string;
  note_type: string;
  created_at: string;
  valid_at: string | null;
  invalid_at: string | null;
  superseded_by: string | null;
  invalidation_kind: string | null;
  project_slug: string;
  is_global: number;
  raw_score: number;
};

export type RecallOptions = { projectSlug?: string; global?: boolean; origin?: string; limit?: number };

// Reciprocal Rank Fusion of a note's per-channel ranks (1-based). Absent from a
// channel = no contribution. The raw fused score sits on a tiny 1/(k+rank) scale;
// RRF_SCORE_SCALE lifts it onto BM25's magnitude so the existing relevance floor
// (a post-weight threshold) stays meaningful — this is the spec's "re-derive a
// fused-score floor" made concrete, and it is what the negative fixture validates.
const RRF_SCORE_SCALE = RRF_K + 1;

type ChannelRanks = { bm25?: number; knn?: number };

function rrfScore(ranks: ChannelRanks): number {
  const parts = [ranks.bm25, ranks.knn].filter((rank): rank is number => rank !== undefined);
  return parts.reduce((sum, rank) => sum + 1 / (RRF_K + rank), 0) * RRF_SCORE_SCALE;
}

/**
 * Exact brute-force KNN over the vec0 table (§6: no ANN at note scale). Returns
 * note_id → 1-based rank by cosine distance. Missing table / empty vector →
 * empty map, so recall degrades to BM25-only (fail-soft). KNN is unscoped here;
 * scope is enforced later against the FTS row set, so a KNN hit that is out of
 * scope simply never fuses in.
 */
function knnRanks(db: Database.Database, queryVector: number[] | undefined): Map<string, number> {
  const ranks = new Map<string, number>();
  if (queryVector === undefined || queryVector.length === 0) return ranks;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_vectors'").get() === undefined) {
    return ranks;
  }
  const rows = db
    .prepare('SELECT note_id, distance FROM note_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance')
    .all(JSON.stringify(queryVector), KNN_FETCH) as Array<{ note_id: string; distance: number }>;
  // Per-channel floor before fusion: drop neighbours past the distance cutoff so a
  // distractor never earns a fusion rank at all.
  rows
    .filter((row) => row.distance <= KNN_DISTANCE_FLOOR)
    .forEach((row, index) => ranks.set(row.note_id, index + 1));
  return ranks;
}

export type RecallTraceCandidate = ScoredCandidate & {
  score: number;
  bm25_rank?: number;
  knn_rank?: number;
  cut_reason?: 'below_floor' | 'budget' | 'superseded' | 'ttl_expired';
};

export type WhyNotResult =
  | {
      matched: true;
      note_id: string;
      rank: number;
      raw_score: number;
      post_weight_score: number;
      gate: 'shipped' | 'below_floor' | 'budget' | 'scope_mismatch' | 'superseded' | 'flagged' | 'expired' | 'not_yet_valid' | 'ttl_expired';
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

export function expiryReferenceTimestamp(candidate: Pick<ScoredCandidate, 'created_at'>): string {
  return candidate.created_at;
}

function isTtlExpired(candidate: Pick<ScoredCandidate, 'note_type' | 'created_at'>, config: ScoringConfig, nowIso: string): boolean {
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
  queryVector?: number[],
): Array<ScoredCandidate & { score: number }> {
  return recallWithTrace(db, query, opts, config, nowIso, queryVector).results;
}

export function recallWithTrace(
  db: Database.Database,
  query: string,
  opts: RecallOptions,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  nowIso: string = new Date().toISOString(),
  queryVector?: number[],
): RecallWithTraceResult {
  if (!opts.projectSlug && !opts.global) {
    return { results: [], candidates: [] }; // push-path rule: require project match or explicit global scope
  }

  // Scope gate enforced in SQL, not post-filtered in JS, so an out-of-scope note
  // never even becomes a candidate (§6 "require project match or explicit global
  // scope"). A note is eligible iff it matches the requested project scope OR the
  // caller explicitly opted into global scope and the note is global-scoped.
  // A note that is neither project-matched nor global is unreachable by design —
  // this is what makes cross-project / cross-repo leakage fixtures (§9) provable.
  const scopeClauses: string[] = [];
  const scopeParams: unknown[] = [];
  if (opts.projectSlug) {
    scopeClauses.push('project_slug = ?');
    scopeParams.push(opts.projectSlug);
  }
  if (opts.global) scopeClauses.push('is_global = 1');
  const originClause = opts.origin !== undefined ? ' AND origin = ?' : '';
  const originParams = opts.origin !== undefined ? [opts.origin] : [];

  // Two channels feed RRF: BM25 (lexical) and exact KNN (semantic). A cross-
  // language query lexically matches nothing, so KNN must be able to SURFACE a
  // note BM25 never returned — the candidate set is the union of both channels.
  const knn = knnRanks(db, queryVector);

  const ftsQuery = plainTextFtsQuery(query);
  const bm25Rows = ftsQuery === undefined
    ? []
    : (db
        .prepare(
          `SELECT note_id, origin, note_type, created_at, valid_at, invalid_at, superseded_by, invalidation_kind, project_slug, is_global, bm25(notes_fts) as raw_score
           FROM notes_fts
           WHERE notes_fts MATCH ? AND (${scopeClauses.join(' OR ')})${originClause}`,
        )
        .all(ftsQuery, ...scopeParams, ...originParams) as FtsRow[]);

  if (bm25Rows.length === 0 && knn.size === 0) {
    return { results: [], candidates: [] };
  }

  // Metadata for KNN-only hits (the cross-language wins) lives in notes_fts, not
  // the vec table. Fetch it with the same scope/origin gate so an out-of-scope or
  // wrong-origin semantic neighbour is dropped, never leaked past recall's §6 rule.
  const bm25Ids = new Set(bm25Rows.map((row) => row.note_id));
  const knnOnlyIds = [...knn.keys()].filter((id) => !bm25Ids.has(id));
  const knnRows = knnOnlyIds.length === 0
    ? []
    : (db
        .prepare(
          `SELECT note_id, origin, note_type, created_at, valid_at, invalid_at, superseded_by, invalidation_kind, project_slug, is_global, 0 as raw_score
           FROM notes_fts
           WHERE note_id IN (${knnOnlyIds.map(() => '?').join(', ')}) AND (${scopeClauses.join(' OR ')})${originClause}`,
        )
        .all(...knnOnlyIds, ...scopeParams, ...originParams) as FtsRow[]);

  // BM25 rank is 1-based over the scoped FTS rows, best (least-negative bm25) first.
  const bm25Ranked = [...bm25Rows].sort((a, b) => a.raw_score - b.raw_score);
  const bm25RankById = new Map(bm25Ranked.map((row, index) => [row.note_id, index + 1]));

  const candidates = [...bm25Rows, ...knnRows].map((row) => {
    const ranks: ChannelRanks = { bm25: bm25RankById.get(row.note_id), knn: knn.get(row.note_id) };
    return {
      note_id: row.note_id,
      // RRF fused rank score feeds the existing weight/decay pipeline in place of raw
      // BM25 (§6: "RRF → the existing weights/decay pipeline"). No query vector ⇒ KNN
      // absent ⇒ single-channel RRF, whose ordering is monotonic in BM25 rank, so the
      // weighted ordering (recency, project boost, …) is preserved exactly as before.
      raw_bm25: rrfScore(ranks),
      // True BM25 magnitude, kept only for the per-channel floor gate below — the
      // relevance floor is a magnitude threshold that RRF's rank scale would erase.
      bm25_magnitude: -row.raw_score,
      bm25_rank: ranks.bm25,
      knn_rank: ranks.knn,
      origin: row.origin,
      note_type: row.note_type,
      created_at: row.created_at,
      is_project_match: opts.projectSlug !== undefined && row.project_slug === opts.projectSlug,
      valid_at: row.valid_at ?? row.created_at,
      invalid_at: row.invalid_at,
    };
  });

  const limit = opts.limit ?? RESULT_CAP;
  const scored = candidates
    .map(({ valid_at, invalid_at, bm25_magnitude, ...candidate }) => ({
      ...candidate,
      valid_at,
      invalid_at,
      bm25_magnitude,
      // Weighted RRF score = final ORDER key (recency/boost/origin/type applied to the
      // fused base). Floor is gated on bm25_magnitude, not this — so fusion reorders
      // but never resurrects a below-floor lexical distractor.
      score: weightedCandidateScore(candidate, config, nowIso),
    }))
    .sort((a, b) => b.score - a.score);
  const active = scored.filter((candidate) =>
    candidate.valid_at <= nowIso &&
    (candidate.invalid_at === null || candidate.invalid_at > nowIso) &&
    !isTtlExpired(candidate, config, nowIso),
  );
  // Per-channel floor before fusion (§6): a note survives if its BM25 magnitude
  // clears the relevance floor OR it is a within-distance KNN hit. Fusion never
  // rescues a note that fails both — the "no resurrected distractor" rule.
  // ponytail: the BM25 channel now floors on RAW magnitude, where pre-hybrid recall
  // floored on the post-weight score. A note whose raw BM25 clears the floor but
  // whose weighted score would not (e.g. email×daily×decay) now ships where it was
  // once cut. Accepted: relevanceFloor is a placeholder slated for fixture tuning
  // (see scoring.ts), and per-channel-before-fusion is the spec's chosen shape.
  // Tighten to weightedCandidateScore({raw_bm25: bm25_magnitude}) if a fixture shows
  // the widening matters.
  const aboveFloor = active.filter((candidate) =>
    (candidate.bm25_magnitude >= config.relevanceFloor && candidate.bm25_magnitude > 0) || candidate.knn_rank !== undefined,
  );
  const shipped = aboveFloor.slice(0, limit);
  const shippedIds = new Set(shipped.map((candidate) => candidate.note_id));
  const budgetCutIds = new Set(aboveFloor.slice(limit).map((candidate) => candidate.note_id));
  const traceCandidates: RecallTraceCandidate[] = scored.map((candidate) => {
    const { valid_at: _validAt, invalid_at: _invalidAt, bm25_magnitude: _bm25Magnitude, ...traceCandidate } = candidate;
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
  queryVector?: number[],
): WhyNotResult {
  // Hybrid replay (§6): re-run BOTH channels with the recorded query vector so a
  // note the pull path reached only via KNN is explained, not falsely reported as
  // "not matched by BM25". No vector supplied ⇒ BM25-only, honestly.
  const knn = knnRanks(db, queryVector);
  const ftsQuery = plainTextFtsQuery(query);
  const rows = ftsQuery === undefined
    ? []
    : (db
        .prepare(
          `SELECT note_id, origin, note_type, created_at, valid_at, invalid_at, superseded_by, invalidation_kind, project_slug, is_global, bm25(notes_fts) as raw_score
           FROM notes_fts
           WHERE notes_fts MATCH ?`,
        )
        .all(ftsQuery) as FtsRow[]);

  const bm25Ids = new Set(rows.map((row) => row.note_id));
  const knnOnlyIds = [...knn.keys()].filter((id) => !bm25Ids.has(id));
  const knnRows = knnOnlyIds.length === 0
    ? []
    : (db
        .prepare(
          `SELECT note_id, origin, note_type, created_at, valid_at, invalid_at, superseded_by, invalidation_kind, project_slug, is_global, 0 as raw_score
           FROM notes_fts
           WHERE note_id IN (${knnOnlyIds.map(() => '?').join(', ')})`,
        )
        .all(...knnOnlyIds) as FtsRow[]);

  const allRows = [...rows, ...knnRows];
  const target = allRows.find((row) => row.note_id === noteId);
  if (target === undefined) {
    return { matched: false, note_id: noteId, gate: 'not_matched_by_bm25' };
  }

  // BM25 rank is 1-based over the BM25 rows; KNN rank comes from the vec channel.
  const bm25Ranked = [...rows].sort((a, b) => a.raw_score - b.raw_score);
  const bm25RankById = new Map(bm25Ranked.map((row, index) => [row.note_id, index + 1]));

  const scopedRows = allRows.filter((row) => inScope(row, opts));
  const scored = (inScope(target, opts) ? scopedRows : allRows)
    .map((row) => ({
      note_id: row.note_id,
      // RRF fused score feeds the weight pipeline (mirrors recall); bm25_magnitude is
      // the separate floor gate. Ordering/rank below match the pull path exactly.
      raw_bm25: rrfScore({ bm25: bm25RankById.get(row.note_id), knn: knn.get(row.note_id) }),
      bm25_magnitude: -row.raw_score,
      knn_rank: knn.get(row.note_id),
      origin: row.origin,
      note_type: row.note_type,
      created_at: row.created_at,
      valid_at: row.valid_at ?? row.created_at,
      invalid_at: row.invalid_at,
      is_project_match: opts.projectSlug !== undefined && row.project_slug === opts.projectSlug,
    }))
    .map(({ bm25_magnitude, ...candidate }) => ({ ...candidate, bm25_magnitude, score: weightedCandidateScore(candidate, config, nowIso) }))
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
  let gate: 'shipped' | 'below_floor' | 'budget' | 'scope_mismatch' | 'superseded' | 'flagged' | 'expired' | 'not_yet_valid' | 'ttl_expired';
  if (target.invalid_at !== null && target.invalid_at <= nowIso) {
    // invalidation_kind names why the interval closed: a flag record (#106), a supersession, or the
    // revision's own validity window expiring. Never label intrinsic expiry as a human flag action.
    gate = target.invalidation_kind === 'flag' ? 'flagged'
      : target.invalidation_kind === 'intrinsic' ? 'expired'
      : 'superseded';
  } else if (target.valid_at !== null && target.valid_at > nowIso) {
    gate = 'not_yet_valid';
  } else if (isTtlExpired(target, config, nowIso)) {
    gate = 'ttl_expired';
  } else if (!inScope(target, opts)) {
    gate = 'scope_mismatch';
  } else if ((scoredTarget.bm25_magnitude < config.relevanceFloor || scoredTarget.bm25_magnitude <= 0) && scoredTarget.knn_rank === undefined) {
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
