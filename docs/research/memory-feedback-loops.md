# Librarian — Feedback loops on memory output (research round)

**Date:** 2026-07-31 (revised twice same day after author challenges — see §12). **Status:** research,
not a settled decision. Companion to `docs/specs/librarian-design-consolidated.md` (§4 logs/consumers,
§5 decisions register, §6 recall/injection contract, §7 rendering, §8 diagnostics isolation, §10
schemas, §12 items 12.2/12.5/12.11, §15 open items) and to issues #91, #109, #171, #172, #179, #182.
If this document disagrees with the spec, the spec wins.

**Do not relitigate:** §8's diagnostics isolation (self-observation never becomes memory except
through a human curated note), 12.3's closure (no worth multiplier without a flowing note-granular
outcome signal), 12.8's closure, the §5 embeddings ruling (embeddings fetch candidates, never decide
verdicts), #172's addressability rule for *closing* a note's validity, and §15's deferral of entity
identity. This document is written inside those rulings; §9 names the three places where a
recommendation needs a spec amendment rather than an exemption.

**Question that prompted this:** *When I learn something new, that knowledge can trigger further
realizations when combined with what I already knew. How do other memory implementations handle
this? What does memory research say? What feedback loops can we apply on librarian output — events,
notes, or both? Which are likely to be cost effective? Why should we apply differently-sized loops?*

**Author's design constraint, which reframed the answer (2026-07-31):** loop sizing must be designed
for years of usage and tens of thousands of events, not for today's corpus. And the mechanism is
**not** notes-derived-from-notes: *notes are relevant for finding and building context, but only to
look up which **events** to include when learning from a bigger set of events.* A distill session
produces a note that references events; two weeks later a bigger loop finds that note, resolves it
back to its events, and includes those events in the data pool for that larger distillation.

---

## 1. Answer in one paragraph

The idea is real and both literatures have names for it: **consolidation** (write-side synthesis at a
slower timescale than acquisition) and **associativity** (linking at read time). The author's
mechanism — notes as an *index* into the event log, bigger loops replaying the indexed events — is
also a named idea, and a better one than what most agent-memory systems ship: it is the
**hippocampal indexing theory** of memory (the fast store holds pointers; consolidation replays the
pointed-to traces, not a summary of them), and in retrieval engineering it is **parent-document /
small-to-big retrieval** and **ReadAgent's gist-then-look-up-the-page** loop. It matters that this is
the shape, because it converts the two expensive objections to consolidation into non-issues:
provenance stays event-grounded so `note show --with-provenance` keeps working, and the faithfulness
verifier keeps a source to verify against. It also inherits the one mitigation the model-collapse
literature actually endorses — **re-ground in the real data instead of replacing it with your own
output** — so errors do not compound across loop generations the way they do in reflection trees.
Librarian already has every piece: notes stamp the full `provenance.event_ids` list plus a range, and
`provenanceEvents()` (`src/cli.ts:782`) already hydrates verbatim events from a note for the
drill-down tool. What is missing is a second consumer, a deterministic pool builder, and three small
spec amendments. The real design problems are not the ones I raised in the first draft: they are the
re-distill invariant (which currently forbids exactly this), the novelty gate (which will silently
eat the loop's output), the **note-invisible event problem** (events from skipped/NOOP'd sessions are
unreachable by a note-indexed pool — the very 25 sessions from #179), and pool budgeting in rendered
tokens rather than calendar windows. On the retrieval question the answer is also cheaper than
expected (§7): a window pool is a SQL filter, not a search; the vector channel has a live
scope-starvation bug that gets worse with every note (#182) plus an embedded-text mis-specification;
and the relatedness signal worth building is an exact provenance join, not a fancier vector space.

## 2. Vocabulary: four loops that get conflated, plus the non-loop

| # | Loop kind | What it changes | Reads | Librarian status |
|---|---|---|---|---|
| 1 | **Acquisition** | events → a new note | one session delta | Shipped (gated admission pipeline, §5) |
| 2 | **Correction / validity** | closes or replaces an existing note | events + one addressed note | Partial: supersede/flag/12.2 shipped; #172, #91 pending |
| 3a | **Consolidation by summarization** | derives a note *from notes* | notes only | Does not exist — **and should not** (§4, §7) |
| 3b | **Consolidation by replay** | derives a note from a *larger event pool*, selected via notes | notes → events | Does not exist. **The recommendation.** |
| 4 | **Policy / tuning** | weights, gates, prompts — writes no memory | diagnostics | Shipped (`librarian stats`, 12.10) |
| — | *Read-side association* | what a query returns; writes nothing | `links` on retrieved notes | Not built; `links` exist and recall ignores them |

Splitting 3a from 3b is the whole content of this revision. They are usually discussed as one thing
("reflection", "consolidation", "memory evolution") and they have opposite risk profiles.

## 3. How other implementations handle it

| System | Shape | Reads notes or source? | Notable |
|---|---|---|---|
| **Generative Agents** (2023) | reflection tree; importance-sum > 150, ~2–3×/day | **notes** (observations *and* prior reflections) | Ablation: believability 29.89 → 26.88 without reflection — the strongest pro-synthesis result in the field, and a 3a design |
| **A-MEM** (2025) | per-note link generation + rewrites neighbours' context/tags | **notes** | 2 LLM calls per event; up to 6× multi-hop; 85–93% fewer memory-operation tokens |
| **Mem0** | ADD / UPDATE / DELETE / NOOP against similar memories | notes | **Deliberately no abstraction layer** — correction is the entire loop |
| **Zep / Graphiti** | bi-temporal edge invalidation + community summaries | notes | Label propagation chosen over Leiden *because* it extends incrementally, delaying full recompute |
| **RAPTOR** | recursive cluster → summarize → recurse | **notes (summaries of summaries)** | +20% absolute on QuALITY; a pure 3a tree |
| **GraphRAG → LazyGraphRAG** | entity graph + community summaries → *deferred* to query time | notes → source | ~$33k index (early 2024) → vector-RAG indexing cost (~0.1%), global queries up to 700× cheaper. The field's own correction of over-eager write-time synthesis |
| **HippoRAG 2** | dual-node KG (phrases + **passages**), Personalized PageRank | index ranks, **source passages are returned** | +7 F1 on associative tasks over embedding retrievers, beating the summarization systems while indexing more cheaply. Evidence for 3b over 3a |
| **ReadAgent** | gist memory per page, then **look up the original pages** | gist → **source** | 3.5–20× effective context window. This is the author's mechanism at document scale |
| **Parent-document / small-to-big retrieval** | index small chunks, feed the **parent document** | index → **source** | Mainstream RAG practice; the granularity of the index is deliberately not the granularity of the context |
| **MemWalker** | navigate a summary tree down to the **leaf segment** | tree → **source** | Summaries are routing structure, not the answer substrate |
| **Letta sleep-time compute** | offline "learned context" from raw context on idle | **source** | ~5× fewer test-time tokens; pays off only when a context serves multiple related queries |
| **MemoryOS** | STM→MTM→LPM, promotion by **heat** (visit frequency × length), not clock | notes | +49% F1 vs GPT-4o-mini baselines on LoCoMo. Note the trigger: usage, not cadence |
| **TiMem** (ACL 2026) | temporal memory tree, cross-level consolidation | notes | 75.30 LoCoMo / 76.88 LongMemEval-S **with 52.20% shorter recalled memory** |
| **Consumer products** | background curation (ChatGPT "Dreaming", reported 2026-06; Claude.ai project summaries) | notes | Direction of travel is *correction*, not abstraction |

**The pattern that decides this document:** every system that returns to the source — HippoRAG 2,
ReadAgent, MemWalker, parent-document retrieval, LazyGraphRAG's retreat from write-time summarization
— either wins on quality against the summarization systems or wins on cost by an order of magnitude.
The systems that summarize summaries pay the full indexing bill up front and inherit drift. The
author's proposal is on the winning side of that split, and it is the side librarian's own §6 already
endorses on the read path: *"distilled notes are a supplement to recoverable verbatim source, not a
replacement [endorsed — distillation pays a measured lossy-compression tax; supplement-not-replace
recovers most verbatim performance at a fraction of the tokens]."* **The proposal is that endorsed
principle applied to the write side.**

## 4. What memory research claims — and what it doesn't

**For replay-based consolidation specifically:**

- **Hippocampal indexing theory** (Teyler & DiScenna 1986; Teyler & Rudy 2007): the hippocampal trace
  is an *index* into distributed neocortical patterns; retrieval and replay reactivate those patterns
  rather than reading a stored digest of them. This is the author's mechanism, and it is a closer
  mapping than the one my first draft used (a summary note being rewritten). It also predicts the
  right division of labour: the index must be cheap, addressable and lossy; the trace must be
  verbatim and durable — which is exactly librarian's note log / event log split.
- **Complementary learning systems** (McClelland et al. 1995, and the bidirectional-interaction work
  since): fast pattern-separating store, slow generalizing store, exchange by replay during off-task
  periods. Generalization belongs to the slow store. An argument for **two** timescales — the count
  above two must be justified by something other than the theory.
- **Sleep inspires insight** (Wagner, Gais, Haider, Verleger & Born, *Nature* 2004): >2× as many
  subjects gained insight into a hidden rule after 8h sleep than after matched wakefulness — insight
  as *restructuring* of an existing representation. The closest thing in the literature to the
  intuition in the question. **The clause that matters more than the result:** no benefit without
  prior training. Consolidation amplifies what was encoded; it cannot recover what was never
  captured. Applied here: replay over intent-only tool events replays a record that never contained
  the failure. That is #179, and it gates the value of every loop below.

**Bounding it:**

- **Model collapse / recursive-training literature:** recursive training on own output loses
  distribution tails and drifts, with error growing per iteration; the mitigation that provably works
  is **accumulating real data rather than replacing it** (finite error bound instead of unbounded).
  This is the sharpest technical argument for 3b over 3a: **replay re-grounds every pass in the
  sacred event log, so loop generations do not compose their own errors.** A reflection tree
  composes them by construction.
- **HaluMem** (operation-level hallucination benchmark for memory systems): systems hallucinate at
  *both* the extraction and update stages, and upstream errors propagate and amplify downstream.
  Every consolidation layer is another extraction stage — which is an argument for *few* layers, not
  for none, and for each layer reading source rather than the layer below it.
- **MemEvoBench / "Your Agent May Misevolve":** biased memory accumulation produces gradual
  behavioural drift; risks are self-generated by routine evolution; static prompt defenses are
  insufficient. Consistent with §6's "labels are a prior, not a guard."
- **Semantic drift under reconsolidation:** the 2026 agent-native-memory analysis (arXiv 2606.24775)
  puts it bluntly — repeated summarization distorts facts; allowing reconsolidation allows
  distortion. (Full text returned 403; this and the next bullet come from indexed excerpts.)
- **A negative result on stacking loops:** the same line of evaluation reports reflection *on top of*
  planning yielding no further gains and possibly weakening routing.
- **Memory poisoning:** a wrong memory is self-reinforcing — decisions taken from it mint descendants
  that corroborate it, and the original error becomes progressively harder to isolate. Replay
  weakens this too: the descendants are re-derived from events, not from the wrong note.

## 5. Sizing for steady state, not for today's corpus

The first draft leaned on a corpus count (68 notes / 260 sessions from #179's probe) to argue there
was little to consolidate. That argument is **withdrawn as an architectural input** — it was a
sequencing observation and it cannot constrain a design that must hold for a decade. What replaces
it is an extrapolation and a budget.

Order-of-magnitude from #179's probe: **7266 tool events across 260 sessions** of dogfooding — call
it ~10² events per session, and (at that observed cadence) ~10⁴–10⁵ events per year, growing.
Post-#179 each `command` / `vcs_*` event also carries captured output, so **bytes per event rise
sharply while count rises linearly** — the pool budget must be computed on *rendered tokens*, never
on event counts.

That gives the honest definition of loop size, which is neither a calendar nor a note count:

| Loop | Pool source | Order of events | Rendered budget | Cadence that follows |
|---|---|---|---|---|
| **Delta** (shipped) | one session's pending delta | 10¹–10² | small | per boundary |
| **Window** | notes for one project in a window + salient events in that window | 10²–10³ | ~10–30k tokens | days–weeks |
| **Theme** | notes matching a lens across projects + selector-matched events | 10³–10⁴ | needs aggressive selection to fit at all | months |
| **Corpus** | everything | 10⁵+ | **does not fit, ever** | never — this is why selection is the design |

**Size is a budget, not a clock.** The cadence is derived: run the loop when its deterministic pool
builder has accumulated roughly a budget's worth of material. That also makes the loop's cost
predictable for a decade instead of growing with the log — the property a calendar-driven loop
cannot have.

## 6. The replay loop, concretely

### 6.1 The pieces that already exist

- Every note stamps `provenance.session_id`, the **full `event_ids` list**, and an `event_range`
  (`src/distill/llmDistiller.ts:149-153`). The index is already there, at event granularity.
- `provenanceEvents(dataDir, note)` (`src/cli.ts:782`) already resolves a note back to its **verbatim
  events**, preferring `event_ids` and falling back to the range. The pool builder is a function that
  already ships — it was written for `note show --with-provenance`.
- Events live at `data/events/{session_id}.ndjson`, so hydrating K notes costs K distinct file reads.
  The §4 hot-path contract governs *injection* only; a background replay pass is free to read logs.
- Redaction and the memory-echo guard both ran **before append**, so replayed events carry no secrets
  and no `<librarian-memory>` blocks. Replay inherits both guarantees for free.
- `valid_at` / `invalid_at` are already in the note schema, and the renderer (§7) already does
  field elision and indexed compact text with ordinal→ULID mapping for collector-stamped provenance.

So the mechanism is: **recall over notes → resolve to event ids → hydrate verbatim events → render →
the existing distill judgment + admission pipeline → a note whose provenance is real events.**

### 6.2 The four real problems (none of which are the ones I raised first time)

**P1 — The re-distill invariant currently forbids this.** §5: *"idempotency is by provenance, not
content: a re-distill of an already-provenanced event range is a bug."* The replay loop re-reads
already-provenanced events **by design**. As written, an agent picking up the work would correctly
refuse it. The fix is not an exemption but a sharpening: **idempotency is per-consumer.** §4 already
models "independent cursor-tracking consumers"; the acquisition distiller must never re-distill its
own range, and a replay consumer with its own cursor, lock and note-type space re-reading events is
its function, not a bug. This is the same disambiguation problem #179 flagged for 12.3, and it needs
the same treatment: fix the spec line before an agent reads it.

**P2 — The novelty gate will silently eat the loop's output.** `findNearDuplicate`
(`src/distill/noveltyGate.ts`) runs a BM25 near-duplicate query, project-scoped, against the whole
index. A note derived from the same events its seed notes came from overlaps them lexically by
construction → duplicate verdict → NOOP → the loop reports "nothing found" while working perfectly.
This is the single most likely way the feature ships broken and looks fine. Three options, in
increasing order of preference:

1. Exclude the seed note ids from the gate's candidate set (smallest change; leaves the gate blind to
   *other* prior consolidations).
2. Scope the gate by note type, so consolidation output is only checked against consolidation output.
3. **Give the loop deterministic ids, so its output is a *revision* and skips the gate the way every
   other deterministic-ID revision already does** (§5: "revisions are supposed to overlap their
   prior"). This is the option that also solves note-count growth at 10-year scale.

**P3 — Keys without entity resolution: name the lens, not the topic.** Option 3 needs a deterministic
key, and keying by *topic* is the deferred entity-resolution problem (§15). The way out: derive the
key from the **pool definition** rather than from the content — `consolidation:{project_slug}:{lens}`,
where a lens is a small, finite, human-configured selector (`failures`, `conventions`, `decisions`,
`summary`). The lens names *how the pool was built*, which is known before the LLM is called, so no
resolution is needed and the note count is bounded by projects × lenses instead of growing with
history. Two consequences worth recording: `project:{slug}:summary` becomes simply the `summary`
lens (the smallest instance of the general loop, not a separate feature), and this is the first place
where claude-mem's declined **mode system** (§5) genuinely fits — not as a per-origin acquisition
profile, which is what was declined, but as a *loop selector*. That is a different trigger and it
arguably fires here.

**P4 — Note-invisible events (the most important critique of the proposal as stated).** If notes are
the *only* index into events, then every event from a session that was **skipped** by the heuristic
or **NOOP'd** by the worth judgment is permanently unreachable by every larger loop — no note points
at it. This is not marginal: skip and noop rates are first-class counters in `librarian stats`
precisely because they are large. And it is the #179 case exactly — 25 sessions hit the same ABI
failure and produced **zero notes**, so a purely note-indexed pool can never see any of them. The
loop would be structurally blind to the very pattern that motivated the whole discussion.

The fix is to accept that notes are a **precision** index, not a complete one, and give the pool
builder a second, **event-side selector** that does not depend on a note existing: salient events in
the window (`hints.possibly_salient`, including post-#179 `command_failed`), or events from sessions
with no note at all. Two sources, deterministic, both recorded in the verdict:

```
pool = notes(scope, window, lens) → provenanceEvents()      # precision, note-indexed
     ∪ events(scope, window, selector)                       # recall, note-independent
     → dedupe by event_id → order by ULID → truncate to budget (record the cut)
```

### 6.3 Two smaller details that are cheap now and expensive later

- **Provenance must be allowed to span sessions.** `provenance` is single-session-shaped today
  (`session_id` + one `event_range`), and `provenanceEvents()` throws without a `session_id`. A
  replay note's events come from many sessions. This is the one genuine schema change the design
  needs — and it is far smaller and better-motivated than the `derived_from: note_ids[]` my first
  draft feared. Shape to settle on the issue: `event_ids` grouped per session (e.g.
  `provenance.sessions: [{ session_id, event_ids }]`), with `provenanceEvents()` extended to
  multi-session and the single-session form kept working (unknown-field tolerance + read-time
  defaults, per §11's precedent).
- **`valid_at` must be the pool's time span, not "now".** A note minted today from two-year-old
  events would otherwise beat the older, more accurate note on recency decay. The bi-temporal fields
  are already in the schema; the loop just has to stamp them honestly.
- **Locking.** The distiller lock is one lock per data dir. A long replay pass must not hold the lock
  that gates ordinary acquisition — separate lock, separate cursor, and acquisition wins on
  contention.

## 7. Finding the notes: is BM25 + embeddings the right selector?

Asked directly: *is BM25 + the current embeddings good enough to find the notes that seed a pool, or
would a purpose-built sqlite-vec table tuned for patterns help?* Three answers, in decreasing order of
how much they change the plan.

### 7.1 For the loop worth building first, similarity is not the tool

A window pool for `consolidation:{slug}:{lens}` is a **filter**, not a search:

```sql
WHERE project_slug = ? AND created_at BETWEEN ? AND ? AND note_type IN (…)
```

Every one of those columns already exists on `notes_fts` (`src/index/schema.ts:19-22` — `UNINDEXED`,
i.e. filterable and returnable but not tokenized). Deterministic, explainable in `why`, no tuning, no
embedding, no relevance floor to re-derive. Similarity only earns its keep for a **cross-project theme
lens**, where the lens cannot be written as a predicate. So the retrieval question does not gate the
first loop at all — which is the cheapest possible answer to it.

### 7.2 The vector channel is mis-specified for its job — two independent defects

**Defect 1 — scope is post-filtered, so KNN starves as the corpus grows (→ #182).** `note_vectors` is
created with no partition or metadata columns (`src/index/indexer.ts:85`), `knnRanks` takes no scope
argument and asks for a fixed global `k = 50` (`src/recall/query.ts:16,60-68`), and scope is applied
only when the KNN-only ids are joined back to FTS (`src/recall/query.ts:189-197`). Rank globally,
discard out-of-scope. At 68 notes the top-50 is ~74% of the corpus and the bug is invisible; at 3000
notes across 20 projects a scoped query often keeps **zero** vector candidates, because the global
top-50 is filled by whichever projects are semantically loudest. Recall then reverts to BM25-only —
losing precisely the cross-language capability §5 bought embeddings for — while the trace still reports
`embedding: "ok"`, since §6's state vocabulary has no value for *"KNN ran, nothing in scope."*
`sqlite-vec` partition keys and metadata columns landed in 0.1.6 and `package.json:32` pins **0.1.9**,
so the fix is available and unused. Filed as **#182** (under #115), including the fork the implementer
must settle: a partition key cannot serve "project match OR global scope" in one query, so the likely
shape is two KNN queries — project partition and global partition — merged before RRF.

**Defect 2 — one vector per note, over text built for a different channel.** `buildSearchText`
(`src/index/indexer.ts:8-19`) concatenates title + summary + bullets + `body.details` +
`project_slug` + link targets, and the same string feeds both FTS and the embedder
(`src/index/indexer.ts:120`). Two consequences:

- **Dilution.** A 0.6b embedding over a long concatenation is a centroid. Curated notes preserve human
  Markdown verbatim in `body.details`, so the highest-weighted note class (`curated: 1.4`) is the most
  diluted of all. Backwards.
- **Slug noise.** A project slug is an identifier, not language. Embedding it inflates similarity
  between any two notes in the same project — redundant once scope is filtered, and actively harmful
  for a cross-project theme lens, where it makes same-project notes look related regardless of topic.

`search_text` was designed for BM25, where a slug token is a useful exact match, then reused for
vectors, where it is noise. This is §7-of-the-spec's category error in miniature (storage optimizes for
machines, prompts for signal-per-token; they meet at the renderer), and the fix belongs at the same
place: **BM25 keeps `search_text`, the vector channel gets a gist rendering** (title + summary +
bullets; no slug, no `details`). A rendering change, not a schema change. Deserves its own issue.

### 7.3 What "tuned for patterns" should actually be — a join, not a vector space

The strongest relatedness signals in librarian are not semantic. They are exact, and they are already
in the logs:

| Relation | Signal | Cost |
|---|---|---|
| co-derived | notes whose `provenance.event_ids` sets overlap | exact join |
| same locus | notes whose events touch the same `files[].path` | exact join |
| same episode | events temporally adjacent within one session | exact join |
| **same failure class** | post-#179: events sharing a normalized stderr signature | exact join — **this is the recurring-ABI-failure case** |

No embedding can beat an exact join on these, they are explainable in `why`, and they are
derived-artifact class (§4): deletable, rebuildable, trivial in SQLite even at 10⁵ events/year. This is
also HippoRAG 2's actual lesson, easy to misread as "better embeddings": its win came from graph
structure plus Personalized PageRank *over* an index, not from a stronger vector model. So the
purpose-built tables worth building are **`note_events(note_id, event_id)`,
`event_files(event_id, path)`, and (post-#179) `event_failures(event_id, signature)`** — not a fancier
`vec0`.

### 7.4 Ranked, with costs

| Option | Cost | Verdict |
|---|---|---|
| Gist rendering for the vector channel | none — a renderer change | ✅ correctness fix |
| Scope-aware KNN (partition key or metadata column) | vec0 shape + `INDEX_SCHEMA_VERSION` bump; index is disposable so rebuild *is* the migration | ✅ #182 |
| Provenance-join tables | new derived tables + an event-log cursor consumer | ✅ the real relatedness engine |
| A second vector per note in a different space (qwen3-embedding supports instruction prefixes, so "what class of problem is this" is expressible) | +1 embed/note, +1 table, +1 digest to pin, 3-channel fusion | ⏸ defer behind a measured miss |
| Bullet-level vectors with max-sim aggregation | N× rows; breaks the note→vector 1:1 that `note_vectors`' PRIMARY KEY encodes | ⏸ defer |
| Event-level embeddings | 10⁴–10⁵ embeds/year on a local 0.6b model, hundreds of MB of vectors | ❌ refuse; a deterministic selector does this job |

### 7.5 The eval that answers it, and one consistency note

"Good enough" is not answerable from intuition, and the cheap eval already exists in the store: the 25
ABI-failure sessions from #179. Hand-label which events belong in a `failures` pool, then measure
**recall@budget** for each selector — window filter / BM25 / KNN / provenance join. Plain-file fixture,
project idiom, no framework. It is only meaningful **post-#179**: before that, every selector scores
zero for the same uninformative reason.

Finally, a consistency worth recording rather than re-deriving later: §5 disqualified embeddings from
deciding novelty verdicts because they score contradictions as near neighbours. For *pool selection*
that property inverts into a virtue — the contradicting note is exactly what the pool wants. Embeddings
are well suited to selecting inputs and unsuited to rendering verdicts, which is the same read/write
asymmetry §8 draws below.

## 8. The honest cost model at steady state

The first draft claimed tokens are not the constraint. At a decade of usage that is wrong, and the
correction matters:

| Cost term | At today's scale | At 10-year scale |
|---|---|---|
| **Tokens per pass** | negligible | **binding** — a theme pool is 10³–10⁴ events with captured output; corpus-wide never fits. This is why the pool budget *is* the design |
| **Risk: a wrong note injected invisibly** | dominant | still dominant, but **lower than 3a's**: each pass re-grounds in events, so errors don't compound across generations |
| **Irreversible surface** | one schema change (multi-session provenance) | same — it is a widening, and it is needed once |
| **Explainability** | **improves**: a replay note drills down to real events, unlike a summary-of-summaries | same |
| **Maintenance** | a second consumer, a pool builder, a lens config, fixtures | lens vocabulary grows slowly; bounded note count keeps `stats` legible |

So the cost-effectiveness ordering is not "loops that write nothing are cheapest" (the first draft's
conclusion) but: **loops whose output is a bounded revision of an addressable note, derived from a
budget-bounded pool of real events, are cheap; loops that mint unbounded new notes, or that read
notes instead of events, are expensive.** Replay is the cheap shape and 3a is the expensive one.

## 9. Why differently-sized loops at all

Because signals settle at different times, and each size can only act on what has settled:

| Signal | Settles after | Only visible to |
|---|---|---|
| A conclusion was corrected mid-work | one session | intra-session loop (#172) |
| A shipped note was wrong | that session's end | boundary loop (12.11 / #91) |
| One project's notes have fragmented or gone stale | days–weeks on that project | window replay |
| A pattern spans many sessions (the recurring failure class) | months | theme replay |
| We are injecting distractors | many injections | policy loop (`stats`) |

A single per-delta loop is structurally blind to everything below the second row. The limit that
comes with it: **a loop is safe at a given size only if its pool builder is deterministic at that
size.** #172's rule survives the replay reframe in a sharpened form — *selection of inputs to a
judgment may be heuristic, because inputs are judged and never mutated; addressing a note whose
validity you intend to close must be structural.* Guessing wrong about which events to replay costs a
weaker note, caught by the existing gates. Guessing wrong about which note to kill destroys a true
memory. The asymmetry is what makes similarity-based pool selection acceptable where
similarity-based closure is not.

## 10. What the spec needs (three amendments, all small)

Per AGENTS.md's routing test — these outlive any single unit of work, so they belong in the spec, and
the rest belongs on issues. No fourth tracking home.

1. **§5 re-distill invariant → per-consumer.** Idempotency binds a consumer to its own cursor; a
   replay consumer re-reading already-provenanced events is its function. Without this, the invariant
   forbids the work (P1).
2. **§10 provenance may span sessions.** Record the widened shape and that the single-session form
   stays valid. Non-retrofittable in spirit — decide it once, before the first replay note exists.
3. **Sharpen #172's addressability rule into a creation/closure split** (§9 above): heuristic
   selection of *inputs*, structural addressing of *targets whose validity closes*. Also record the
   ruling that no note is derived from notes — every note's provenance resolves to events — with 3a
   named as the rejected alternative and the model-collapse reasoning attached.

## 11. Recommendations (ordered)

- **R1 — Ship #179 first.** Unchanged, and now doubly load-bearing: replay quality is bounded by
  event fidelity (no insight without prior training), and captured output changes the pool's token
  math, which is the parameter every larger loop is sized by.
- **R2 — Keep the correction loops ahead of the replay loop.** #172 (gated on #171 as designed), then
  #91 with #109. They are cheap, they are what the cost-effective systems in §3 actually ship, and a
  memory that corrects itself is a better substrate for replay.
- **R3 — Build the replay loop as a second distill consumer.** Own cursor, own lock, deterministic
  two-source pool builder (note-indexed ∪ event-selector), budget in **rendered tokens** with the
  truncation recorded as a cut reason, output as a **revision of `consolidation:{slug}:{lens}`** so it
  skips the novelty gate the way other deterministic revisions do and cannot inflate note count.
  Start with one lens on one project — `summary` is the smallest instance and needs no new key
  vocabulary. Success signals for the issue should include the two silent-failure traps: a fixture
  proving the loop's output is **not** NOOP'd as a near-duplicate of its own seeds (P2), and a
  fixture proving a session that produced **no note** can still contribute events to a pool (P4).
- **R4 — Fix the vector channel before any loop leans on it (§7.2).** #182 (scope-aware KNN) is a live
  silent-degradation bug on its own timeline, not loop work; the gist-rendering split for the embedded
  text is a sibling issue not yet filed. A cross-project theme lens *is* a scoped vector query, so a
  loop built on today's channel would inherit a defect that worsens with every note.
- **R5 — Build relatedness as a join before buying it as a vector (§7.3).** `note_events`,
  `event_files`, and (post-#179) `event_failures` are derived-artifact tables that make "patterns and
  related stuff" an exact query, explainable in `why`. Defer the second embedding space and
  bullet-level vectors behind a measured miss; refuse event-level embeddings.
- **R6 — Read-side one-hop `links` expansion: optional.** Still cheap and still fixture-gated
  ("expansion must not resurrect below-floor distractors"), but a recall nicety rather than the answer
  to associativity. Replay plus the joins in R5 is the answer.
- **R7 — Measure to *tune* the loop, not to permit it.** The first draft gated the loop's existence
  on fragmentation harm; that was wrong for a decade-scale design. What genuinely needs measuring is
  the loop's **parameters**: rendered-tokens-per-pool distribution (sets the budget and the cadence),
  the skip+noop share of sessions (sizes the event-side selector — i.e. how much of the log is
  note-invisible), the duplicate rate of loop output against its seeds (validates the P2 choice), and
  §7.5's recall@budget comparison across selectors on the labelled ABI-failure pool. #171's
  fragmentation probe stays useful as a quality signal.
- **R8 — Still refuse, with reasons that survive:** notes-derived-from-notes with no re-grounding in
  events (3a — model collapse, drift, provenance loss); similarity-addressed *closure* of validity
  (#172); diagnostics → memory (§8 of the spec); usage → ranking (12.3); event-level embeddings
  (§7.4).

## 12. Critique of this round

- **The first draft's central recommendation was wrong**, and wrong in an instructive way: it took
  "consolidation" to mean summarization-of-notes because that is what most of the surveyed systems
  do, then reasoned correctly about that shape and concluded the loop was mostly not worth building.
  The author's reframe (notes index events; replay the events) dissolves the two costs that drove
  that conclusion. Survey-shaped research inherits the field's default architecture as an unexamined
  premise — that is the generalizable failure here.
- **The corpus-count argument is withdrawn** as an architectural input (§5). It was a sequencing
  observation dressed as a design constraint.
- **Domain transfer is still weak.** LoCoMo/LongMemEval/BEAM are conversational-personalization
  benchmarks; librarian is coding-agent memory with an invisible 0–5 push budget. The §3 numbers
  indicate direction, not magnitude, and BEAM is explicitly unsaturated by any current architecture.
- **The strongest pro-synthesis result measures the wrong thing** (Generative Agents' ablation scores
  believability of a simulated character) — and it is a 3a system, so it does not transfer cleanly to
  the recommended shape either.
- **The neuroscience justifies a shape, not a mechanism.** Wagner 2004 is one human study on a
  number-reduction task; a preregistered replication attempt exists (CCN 2024) whose outcome I did
  not read. Hippocampal indexing theory is a strikingly good analogy for note-log/event-log, and an
  analogy is all it is.
- **Two arXiv full texts returned 403**; those claims come from indexed excerpts. The ChatGPT
  "Dreaming" behaviour is third-party reporting, not a vendor doc.
- **Nothing here is measured.** No pool was built, no token count computed, no replay pass run. P2 and
  P4 are read off the code (`noveltyGate.ts`, the skip heuristic, `provenanceEvents`) and are
  predictions, not observations — which is why R3 carries them as fixtures rather than as caveats.
- **§7's defects are likewise read, not reproduced.** The scope-starvation table extrapolates from
  `KNN_FETCH = 50` and an assumed even spread across projects; the real distribution is skewed and the
  threshold where it bites is unmeasured. #182 therefore leads with a fixture that *manufactures* the
  scale and must fail on `main` — an argument that only convinces once it is executable. The dilution
  and slug-noise claims about the embedded text are mechanism arguments with no retrieval measurement
  behind them at all; §7.5's recall@budget comparison is what would settle them.
- **§7.3 risks the same convenience bias flagged above.** "Use the structural signal you already
  have" is again the answer that happens to fit the architecture. It is at least falsifiable the same way: if the
  join-based selectors do not beat BM25/KNN on the labelled pool, they are not worth their tables.

---

## Sources

Agent-memory systems: [Generative Agents](https://arxiv.org/pdf/2304.03442) ·
[A-MEM](https://arxiv.org/html/2502.12110v1) · [Mem0](https://arxiv.org/html/2504.19413v1) ·
[Zep/Graphiti](https://arxiv.org/pdf/2501.13956) ·
[Graphiti engineering notes](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/) ·
[RAPTOR](https://arxiv.org/pdf/2401.18059) ·
[LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) ·
[HippoRAG 2 / From RAG to Memory](https://arxiv.org/abs/2502.14802) ·
[ReadAgent](https://arxiv.org/abs/2402.09727) · [MemWalker](https://gonzoml.substack.com/p/memwalker) ·
[Parent-document retrieval](https://zeroentropy.dev/concepts/parent-document-retrieval/) ·
[Sleep-time compute](https://arxiv.org/html/2504.13171v1) ·
[MemoryOS](https://arxiv.org/abs/2506.06326) · [TiMem](https://aclanthology.org/2026.findings-acl.1091/)

Evaluation and failure modes: [HaluMem](https://arxiv.org/abs/2511.03506) ·
[MemEvoBench](https://arxiv.org/pdf/2604.15774) ·
[Your Agent May Misevolve](https://arxiv.org/abs/2509.26354) ·
[Are We Ready For An Agent-Native Memory System?](https://arxiv.org/abs/2606.24775) ·
[Memory poisoning attack and defense](https://arxiv.org/html/2601.05504v2) ·
[Model collapse / accumulating data](https://openreview.net/forum?id=5B2K4LRgmz) ·
[Agent memory benchmarks 2026](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)

Retrieval mechanics: [sqlite-vec metadata columns, partition keys and KNN filtering (v0.1.6)](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html) ·
[sqlite-vec architecture](https://github.com/asg017/sqlite-vec/blob/main/ARCHITECTURE.md)

Cognitive science: [Sleep inspires insight (Wagner et al., Nature 2004)](https://www.nature.com/articles/nature02223) ·
[Preregistered replication attempt (CCN 2024)](https://2024.ccneuro.org/pdf/29_Paper_authored_CCN_2024.pdf) ·
[Complementary learning systems (McClelland et al. 1995)](https://www.researchgate.net/publication/15575602_Why_There_are_Complementary_Learning_Systems_in_the_Hippocampus_and_Neocortex_Insights_from_the_Successes_and_Failures_of_Connectionist_Models_of_Learning_and_Memory) ·
[Bidirectional CLS interactions](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9606815/)
