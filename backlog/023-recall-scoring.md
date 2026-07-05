# 023 — src/recall/scoring.ts

**Phase:** 3 — Walking skeleton
**Dependencies:** none (scaffold merged). Pure function — workable immediately.
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §6 ("Scoring (deterministic, in code): BM25 → RRF-style fusion where applicable → project/global boost → recency decay → weights → relevance floor")
**Do not relitigate:** the scoring pipeline's stage order is fixed (project/global boost, then recency decay, then weights, then floor — as written above); the default weight maps and half-life are given in §6/§5 — use those exact numbers unless a fixture later proves they need tuning (none do yet, this is v1). RRF fusion is explicitly "where applicable" — with a single retrieval source (BM25 only, no vector arm yet), there's nothing to fuse; skip that stage rather than building fusion logic for one input. Loading scoring config from `~/.librarian/config.json` is not part of this task; this module exposes defaults and accepts an explicit `ScoringConfig`, and later wiring can decide where that config came from.

## Context

Depends on 002 only — this is a pure function module, no I/O, no SQLite. Deliberately separated from `query.ts` (024) so the scoring math is unit-testable... except §14 says no unit tests. Resolve that tension the way §14 intends: this "test" still only exercises the module through its one public function with realistic input/output pairs (a black-box test of a small box), not internal-state inspection — that's consistent with the black-box convention, just at finer grain because this module's box is inherently small.

## Task

Create `src/recall/scoring.ts` exporting:
```ts
export type ScoredCandidate = {
  note_id: string; raw_bm25: number; origin: string; note_type: string;
  created_at: string; is_project_match: boolean;
};
export type ScoringConfig = {
  originWeights: Record<string, number>; // e.g. { human: 1.5, opencode: 1.0, email: 0.6 }
  typeWeights: Record<string, number>;   // e.g. { curated: 1.4, decision: 1.2, project_summary: 1.0, fact: 0.9, daily: 0.7, episode: 0.7 }
  relevanceFloor: number;
  recencyHalfLifeDays: number; // 90 per §5
  projectBoost: number;
};
export const DEFAULT_SCORING_CONFIG: ScoringConfig;
export function scoreCandidate(c: ScoredCandidate, config: ScoringConfig, nowIso: string): number // 0 if below floor
export function rankAndFilter(candidates: ScoredCandidate[], config: ScoringConfig, nowIso: string): Array<ScoredCandidate & { score: number }>
```
`scoreCandidate`: `raw_bm25 * (is_project_match ? config.projectBoost : 1) * exp(-ageDays / config.recencyHalfLifeDays) * (config.originWeights[c.origin] ?? 1) * (config.typeWeights[c.note_type] ?? 1)`, then `0` if the result is below `config.relevanceFloor`. `rankAndFilter`: score every candidate, drop the zeros, sort descending.

Fill `DEFAULT_SCORING_CONFIG` with the exact maps from §6's example (`{ human: 1.5, opencode: 1.0, email: 0.6 }` × `{ curated: 1.4, decision: 1.2, project_summary: 1.0, fact: 0.9, daily: 0.7, episode: 0.7 }`), `recencyHalfLifeDays: 90`, and pick a `relevanceFloor` that's clearly a placeholder-but-reasonable v1 number (document in a comment that §5 says this gets "tuned against fixtures" — this task isn't the tuning pass).

Create `tests/recall/scoring.test.ts`: a project-matching, recent, `human`-origin, `curated`-type candidate outranks a non-matching, old, `email`-origin, `daily`-type candidate even with a lower raw BM25 score; a candidate with `raw_bm25: 0` (or very low) is filtered out by the floor.

## Done-check

```
npm test
```
Expect: `tests/recall/scoring.test.ts` passes.
