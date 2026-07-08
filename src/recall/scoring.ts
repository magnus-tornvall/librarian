export type ScoredCandidate = {
  note_id: string;
  raw_bm25: number;
  origin: string;
  note_type: string;
  created_at: string;
  is_project_match: boolean;
};

export type ScoringConfig = {
  originWeights: Record<string, number>;
  typeWeights: Record<string, number>;
  relevanceFloor: number;
  recencyHalfLifeDays: number;
  projectBoost: number;
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  originWeights: { human: 1.5, opencode: 1.0, email: 0.6 },
  typeWeights: {
    curated: 1.4,
    decision: 1.2,
    project_summary: 1.0,
    fact: 0.9,
    daily: 0.7,
    episode: 0.7,
  },
  // ponytail: placeholder v1 floor — §5 says this gets tuned against fixtures, not this task.
  relevanceFloor: 0.1,
  recencyHalfLifeDays: 90,
  projectBoost: 1.5,
};

export function weightedCandidateScore(c: ScoredCandidate, config: ScoringConfig, nowIso: string): number {
  // Clamp negative age (a future-dated created_at, e.g. clock skew across machines) to 0
  // rather than letting it invert the decay term into an amplifier.
  const ageDays = Math.max(0, (Date.parse(nowIso) - Date.parse(c.created_at)) / (1000 * 60 * 60 * 24));
  return (
    c.raw_bm25 *
    (c.is_project_match ? config.projectBoost : 1) *
    Math.exp(-ageDays / config.recencyHalfLifeDays) *
    (config.originWeights[c.origin] ?? 1) *
    (config.typeWeights[c.note_type] ?? 1)
  );
}

export function scoreCandidate(c: ScoredCandidate, config: ScoringConfig, nowIso: string): number {
  const score = weightedCandidateScore(c, config, nowIso);
  return score < config.relevanceFloor ? 0 : score;
}

export function rankAndFilter(
  candidates: ScoredCandidate[],
  config: ScoringConfig,
  nowIso: string,
): Array<ScoredCandidate & { score: number }> {
  return candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, config, nowIso) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}
