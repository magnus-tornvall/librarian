# Librarian — scope-aware KNN: why post-filtering fails, and the two candidate schemas

**Date:** 2026-08-01 (extracted from issue #182, opened 2026-07-31). **Status:** analysis; the fork in
§4 is deliberately left to the implementer, to be settled by fixture rather than by argument.
Companion to `docs/specs/librarian-design-consolidated.md` §5 (search ruling), §6 (recall contract),
§4 (derived index, recall cost). Layer-3 reading for #182 — the issue body carries the contract, this
carries the reasoning.

---

## 1. The mechanism

`note_vectors` is created with no partition or metadata columns (`src/index/indexer.ts:85`):

```sql
CREATE VIRTUAL TABLE note_vectors USING vec0(note_id TEXT PRIMARY KEY, embedding float[N])
```

`knnRanks` takes only `(db, queryVector)` — no scope argument — and asks for a fixed `k`
(`src/recall/query.ts:16,60-68`):

```ts
const KNN_FETCH = 50;
...
.prepare('SELECT note_id, distance FROM note_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance')
```

Scope is applied only later, when the KNN-only ids are joined back to FTS
(`src/recall/query.ts:189-197`):

```sql
... WHERE note_id IN (…knnOnlyIds) AND (project_slug = ? OR is_global = 1)
```

So the pipeline is **rank globally → discard out-of-scope**. Classic post-filtering.

## 2. Why it degrades monotonically

`k` is a constant while the corpus is not, so the fraction of the corpus the vector channel can see
shrinks with every note added:

| Notes in index | Global top-50 covers | In-scope survivors (20 projects, even spread) |
|---|---|---|
| 68 (at time of writing) | ~74% of the corpus | most of the project's notes — **harmless, which is why no test catches it** |
| 500 | 10% | ~2–3 |
| 3000 | 1.7% | **often 0** |

The failure is not uniform either: the global top-50 is filled by whichever projects are semantically
closest to the query, so a quiet project loses its candidates to a loud one. The precise lost case is
the one hybrid search was bought for — a Swedish query against an English note in a low-traffic
project, where the note is a real neighbour globally but ranks below 50.

## 3. Why it is silent

Two things make this present as normal operation rather than as an error:

1. BM25 still returns rows, so recall looks fine. It has just quietly reverted to lexical-only —
   which is exactly the capability §5's search ruling bought vectors to add.
2. The trace's `embedding` field distinguishes `ok` / `timeout` / `error` / `disabled` (§6) but has no
   state for *"KNN ran and every neighbour was out of scope"*. A scope-starved query reports `ok` with
   zero contribution.

This is not a regression from a recent change. The shape has been there since the vector channel
landed; 68 notes is simply too small to expose it. That is why closing it needs a fixture that
manufactures scale rather than waiting for the store to reach it.

## 4. The fork: partition key vs metadata column

`package.json:32` already pins `sqlite-vec` **0.1.9**, and partition keys plus metadata columns (with
KNN `WHERE` support) landed in **0.1.6** — the capability is present and unused. **Verify actual 0.1.9
behaviour with a fixture before committing to either shape** (§6 discipline: fixtures decide, not
assumption).

- **Partition key** — `vec0(note_id TEXT PRIMARY KEY, project_slug TEXT partition key, embedding
  float[N])`. Pre-filters before any vector comparison. **The catch:** §6 requires "project match OR
  explicit global scope", and global notes sit in a different partition (`project_slug = ''`), so one
  KNN cannot serve both. The likely shape is **two KNN queries — the project partition and the global
  partition, each with its own `k` — merged before RRF.** That is arguably better than the status quo
  regardless: per-partition recall becomes independent, so a loud project can no longer starve a quiet
  one *or* the global pool.
- **Metadata column** — `project_slug` as an ordinary metadata column usable in the KNN `WHERE`.
  Likely simpler for the `OR` semantics, possibly weaker pre-filtering than a partition key.

## 5. Why raising `k` is not the fix

Raising `KNN_FETCH` trades one silent degradation for a slower one and still scales wrong; the
constant only stops mattering once the search is scope-aware. Setting `k = COUNT(*)` is exact but
makes every query O(corpus), against §4's cost intent for the recall path.

## 6. Migration is free

The index is a derived artifact (§4) — deletion is safe and self-healing — so migration is just
bumping `INDEX_SCHEMA_VERSION` (`src/index/schema.ts:3`, currently 5). The existing
`unsupported index schema version` guard already forces a rebuild rather than a mis-read.

## 7. Spin-offs (not part of #182)

Two findings surfaced alongside this one and are separable. Neither shares a touchpoint with the fix,
so all three can proceed in parallel.

- **Diagnostics gap.** Record the in-scope KNN candidate count, or add a state distinguishing "KNN
  ran, nothing in scope", so this class of collapse is visible in `librarian why` / `librarian stats`
  instead of presenting as `embedding: "ok"`. Without it, the next instance of this bug is equally
  silent. Worth closing in the same pass if cheap; worth its own issue if not.
- **Embedded text is mis-specified for its channel.** `buildSearchText` (`src/index/indexer.ts:8-19`)
  concatenates title + summary + bullets + `body.details` + `project_slug` + link targets, and the
  same string feeds both FTS and the embedder (`indexer.ts:120`). That dilutes long notes — curated
  notes keep human markdown verbatim in `details`, so the highest-weighted class is the most diluted
  — and embeds a project slug as if it were language, inflating same-project similarity. Per §7 the
  fix belongs at the renderer: BM25 keeps `search_text`, vectors get a gist rendering.

Independent of the memory-feedback-loops research round. That work would *depend* on this being
correct (pool selection for a cross-project lens is exactly a scoped vector query), but this bug
stands on its own and should not wait for it. Note: #182 cited
`docs/research/memory-feedback-loops.md` §7 for the `buildSearchText` reasoning; that file is not in
the tree as of this extraction — verify before relying on the citation.
