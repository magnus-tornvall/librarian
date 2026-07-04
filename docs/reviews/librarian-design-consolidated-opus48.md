# Context, Memory & Total Token Efficiency — Research Report for Librarian

*Generated: 2026-07-04 | Sources: ~40 across 4 parallel research sweeps | Confidence: High on the core claims, Medium on the 2026 preprints (flagged inline)*

> **Scope.** Evidence gathered specifically to pressure-test [`librarian-design-consolidated.md`](../specs/librarian-design-consolidated.md). The question the design cares about is not "does memory help per message" but **"does injected memory reduce the total tokens and improve correctness across the whole task-completion loop."** That framing is answered directly in §5 and the design-implications table.
>
> **Verification note.** Several 2026 arXiv IDs (`2601.*`–`2606.*`) postdate the assistant knowledge cutoff (Jan 2026) and could not be independently verified. They are marked **⚠ provisional** and are never used to carry a conclusion on their own — only to corroborate a peer-reviewed result. The load-bearing claims all rest on 2024–2025 peer-reviewed work.

---

## Executive summary

1. **The single most important finding for Librarian is a vindication of its smallness.** Model accuracy degrades as the input grows — *well before* the context window fills ("context rot"). On LongMemEval, focused ~300-token prompts substantially **outperform** ~113,000-token full prompts. Librarian's ~500-token per-prompt injection budget is not a compromise; it is what the research says you *should* do.

2. **Precision beats volume, and near-miss distractors are the real enemy.** In the SIGIR-2024 "Power of Noise" study, a *single* distracting (relevant-looking but non-answer-bearing) passage measurably lowers accuracy, and accuracy falls monotonically as more are added (−18.61 points reported). This means Librarian's top-5 recall is only safe if those 5 are genuinely high-signal — an irrelevant note injected is *worse than injecting nothing*. It argues for a relevance floor and for keeping fail-closed behavior.

3. **Verbatim memory beats LLM-summarized memory.** A controlled ablation (⚠ provisional, but consistent with the peer-reviewed lossy-distillation argument) found raw verbatim chunks beat LLM-extracted/summarized artifacts by 15.9 pts (LoCoMo) and 22.0 pts (LongMemEval). This directly supports two Librarian decisions: **boosting human-authored records above distiller output**, and the **curated importer preserving the human body verbatim with no LLM normalization**. It also warns that the distiller's summaries carry a real accuracy cost — mitigated by keeping provenance/event linkage so verbatim source is recoverable.

4. **The whole-task economics favor memory only under three conditions** — the injected context is (a) *small and high-signal*, (b) *stable enough to be cache-resident*, and (c) *demonstrably prevents re-derivation* that would otherwise dominate cost. Librarian's design satisfies (a) and (c) by construction; (b) is a placement decision worth making explicit (§5, §6).

5. **BM25-only for v1 is defensible; the highest-ROI upgrade is re-ranking, not vector search.** Re-ranking (cross-encoders) is repeatedly cited as the best effort-to-impact lever for demoting distractors — which §2 shows is the failure mode that hurts correctness most. The `search_text`/schema escape hatch for vector is correct to keep, but if you add one thing after v1, a re-ranking pass beats adding vectors.

---

## 1. Adding context degrades correctness ("context rot")

The foundational result is **Lost in the Middle** (Liu et al., TACL 2024): accuracy follows a **U-shaped curve** by the position of the needed information — high at the start/end, degrading **>30%** when it sits in the middle. Replicated across GPT-3.5-Turbo, GPT-4, Claude 1.3, LongChat-13B, MPT-30B, and Cohere Command ([Lost in the Middle](https://arxiv.org/pdf/2307.03172), [ACL Anthology](https://aclanthology.org/2024.tacl-1.9/)).

**Chroma's "Context Rot" report** (July 2025, 18 models incl. Claude Opus 4/Sonnet 4, GPT-4.1, o3, Gemini 2.5) sharpens it: models do not process context uniformly — the 10,000th token is not handled as reliably as the 100th, and degradation begins **well before the context-window limit** ([Context Rot](https://www.trychroma.com/research/context-rot)). Concrete findings:

- Even **a single distractor** lowers performance vs. baseline; four distractors degrade it further, non-uniformly.
- Models perform **worse** on a logically coherent haystack than on a shuffled one — coherence invites over-reading.
- On **LongMemEval**, focused ~300-token prompts substantially outperform ~113,000-token full prompts; Claude models showed the largest gaps.
- Low question↔target semantic similarity (reasoning-dependent retrieval) rots fastest.

The retrieval-vs-reasoning distinction is the cleanest, best-supported result in the literature (three independent benchmarks agree): simple keyword retrieval survives long context reasonably; **reasoning, multi-hop, and non-lexical association collapse much earlier**. RULER shows near-perfect needle-in-haystack scores mask sharp drops on multi-hop tracing/aggregation ([RULER](https://arxiv.org/html/2404.06654v1)). NoLiMa (Adobe, ICML 2025) removes lexical overlap and finds **11 of 12 models fall below 50% of their short-context baseline at 32K tokens**; GPT-4o drops from 99.3% to 69.7% ([NoLiMa](https://arxiv.org/abs/2502.05167)).

**Distractors follow a power law.** GSM-DC (EMNLP 2025) measures step accuracy vs. irrelevant-context count: Grok-3-Beta 43%→19%, GPT-4.1 26%→2% at 15 distractors, with the exponent growing with reasoning depth; irrelevant context also suppresses self-verification ([GSM-DC](https://aclanthology.org/2025.emnlp-main.674/)).

Drew Breunig's widely-cited taxonomy names four failure modes — **poisoning** (a hallucination enters context and snowballs), **distraction** (history dominates training knowledge; Gemini 2.5 Pokémon agent repeats past actions beyond ~100k tokens), **confusion** (superfluous tools/content degrade output), and **clash** (conflicting info across turns; ~39% average drop when info is sharded across turns) ([How Contexts Fail](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html)).

**→ Librarian bearing:** the ~500-token cap, the 10-turn mini-brief, and the distill-skip heuristic (fewer low-signal notes in the index) are all pulling in the research-endorsed direction. The design's instinct to keep injection tiny is correct and load-bearing.

## 2. Retrieval quality: precision over volume

**The Power of Noise** (Cuconasu et al., SIGIR 2024) is the key study on *what a retriever should return*. Classifying passages as relevant / distracting / random on NQ-open with Llama2 under an oracle setup ([Power of Noise](https://arxiv.org/pdf/2401.14887)):

- **Distracting docs are actively harmful** — even one causes a noticeable drop; accuracy declines monotonically (−18.61 points reported). The retriever's own highest-scoring non-answer passages are what hurt.
- **Position confirms lost-in-the-middle:** accuracy is highest when the gold passage is **adjacent to the query**.
- The headline "adding random noise improves accuracy up to 35%" is a 2024-era, oracle-setup curiosity — **do not operationalize it.** The robust, portable takeaway is *precision over volume; near-miss distractors are the enemy.*

Precision-vs-recall practitioner consensus: fewer, higher-precision chunks usually win ("five highly relevant passages typically outperform twenty marginally relevant ones"); typical sweet spot k≈5–15, task-dependent, with a *turning point* rather than a monotonic rule ([Redis](https://redis.io/blog/rag-metrics/), [Chroma chunking](https://www.trychroma.com/research/evaluating-chunking)).

**Re-ranking is the highest-ROI lever.** Cross-encoders reorder candidates to demote distractors; reported +10–25% accuracy, 30–50% retrieval-precision gains, Cohere Rerank cited at +40% ([BigData Boutique](https://bigdataboutique.com/blog/rag-reranking-improving-retrieval-quality-with-cross-encoders)). Caveat from the same sources: retrieval-metric gains don't automatically convert to answer-quality gains — measure downstream. But given §2's finding that distractors are the dominant harm, demoting them is exactly the right target.

**Hybrid BM25+vector + RRF improves retrieval:** RRF fuses ranked lists by rank consistency (sidesteps incompatible score scales); reported +38% MAP@10 over BM25 alone; shipped in OpenSearch 2.19 ([RRF/OpenSearch](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/), [hybrid dense-sparse](https://ceur-ws.org/Vol-4173/T3-7.pdf)). Magnitudes are dataset-specific; direction is robust.

**→ Librarian bearing:** top-5 is inside the sensible range, but §2 says the *floor* matters more than the *cap*. A low-relevance note injected to fill 5 slots is a distractor and costs correctness. Recommend a **BM25-score relevance floor** and keeping fail-closed on untagged notes. Order results so the top hit sits nearest the user prompt. RRF is already in the design conceptually; when you move past v1, **re-ranking beats adding vectors** as the first upgrade.

## 3. Recency / freshness weighting

Librarian's `exp(-ageDays/90)` decay is well-supported. A 2025 study decoupling temporal RAG into a tractable *freshness* problem and a hard *topic-evolution* problem found a **simple recency prior achieves accuracy 1.00 on freshness tasks** ([Solving Freshness in RAG](https://arxiv.org/html/2509.19376)). Time-decay via half-life blended into similarity is standard and shipping in products (Ragie recency bias). A counter-view argues freshness/conflict resolution should be **deterministic, not LLM-reasoned** (⚠ provisional [2606.01435](https://arxiv.org/pdf/2606.01435)) — which is exactly what Librarian does by computing decay in code, not in the distiller. **No change indicated;** the 90-day half-life is a reasonable heuristic knob to leave tunable.

## 4. Agent memory systems: what actually helps

**Be skeptical of the leaderboard.** The loud efficiency numbers come almost entirely from vendors benchmarking their own products, and the two loudest (Mem0, Zep) publicly accuse each other of rigged evaluations ([Zep critique of Mem0](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/); Zep's own repo has a [self-correction issue](https://github.com/getzep/zep-papers/issues/5) alleging its 84% LoCoMo claim collapses to 58.44% under corrected eval). Discount single-vendor LoCoMo numbers. LoCoMo conversations are also only ~16–26K tokens — inside modern windows, so they barely test memory under pressure.

What survives skepticism:

- **Memory clearly helps on procedural/agentic tasks.** Memp (⚠ provisional [2508.06433](https://arxiv.org/html/2508.06433v2)): steps-to-completion fell 25.2→20.2 on average; ALFWorld 87.14% success at 15 steps *with* procedural memory vs 39.28% at 23.8 steps without (GPT-4o). This is the strongest "memory reduces total work" signal.
- **On conversational QA, memory helps only vs. a naive baseline.** Notably, Letta found a **filesystem + iterative search beat the dedicated memory layers** (74.0% LoCoMo vs 68.5% Mem0-graph) — a result that undercuts the whole memory-product category ([Letta benchmark](https://www.letta.com/blog/benchmarking-ai-agent-memory/)). And Mem0's *own* tables show a full-context baseline (~73%) beating Mem0's best (~68%).
- **LongMemEval** (ICLR 2025) is the most credible neutral instrument: long-context LLMs show a **30–60% accuracy drop** as history grows, and memory-design optimizations (session decomposition, fact-augmented expansion, time-aware queries) materially improve recall+QA ([LongMemEval](https://arxiv.org/abs/2410.10813)).
- **Memory can hurt.** MemoryArena (⚠ provisional [2602.16313](https://arxiv.org/html/2602.16313v1)): external memory/RAG helped *only* where context exceeded effective capacity; elsewhere it added latency (external-memory systems 99–133s vs long-context 34–82s) and redundancy without payoff. "Attention dilution" — more history makes models worse at the current question even when the answer is present.

**Verbatim > summarized (the decisive one for the distiller).** A controlled ablation holding model/retriever/reranker/judge constant, swapping only stored representation, found **raw verbatim chunks beat LLM-extracted artifacts by 15.9 pts (LoCoMo) and 22.0 pts (LongMemEval)** via "lossy distillation" — the extracted pipeline never beat naive RAG (⚠ provisional [2601.00821](https://arxiv.org/pdf/2601.00821)). This is consistent with the peer-reviewed Power-of-Noise / information-loss line, so the *direction* is trustworthy even if the exact deltas aren't. A countervailing result: well-designed distillation can recover ~96% of verbatim performance at ~1/11th the tokens *if it supplements rather than replaces* verbatim (⚠ provisional [2603.13017](https://arxiv.org/pdf/2603.13017)).

**→ Librarian bearing:** three design decisions are directly endorsed — (1) **boost human-authored above distilled**; (2) **curated importer preserves the human body verbatim, no LLM normalization**; (3) provenance links from notes back to `event_id`s. The warning: the distiller's summaries pay a lossy-compression tax. Keep the event provenance strong so verbatim source is recoverable, and treat distilled notes as a *supplement to*, not a *replacement for*, retrievable raw signal. No study directly compares human-authored vs LLM-summarized memory — that specific comparison is a gap, but the closest proxy (verbatim-human-text vs LLM-extraction) favors the human text, backing the human-boost.

## 5. The whole-task token economics (the actual question)

Three quantified terms decide whether memory pays for itself across a task:

**(1) Injection cost per turn** — small, and can be made **90% cheaper (Anthropic) / 50% cheaper (OpenAI)** via prompt caching *if the injected prefix is stable*. Anthropic cache reads ≈ 0.10× input, min cacheable block 1,024 tokens, 5-min/1-hr TTL; the write premium repays after a single hit ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI caching](https://openai.com/index/api-prompt-caching/)). **A mutating prefix busts the cache and forfeits the discount.**

**(2) Re-derivation cost avoided** — the prize. Bounding agent trajectories saves **28.6–44.1%** of tokens (⚠ provisional, via [Unblocked](https://getunblocked.com/blog/why-ai-agents-burn-tokens/)); multi-agent systems burn **~15×** the tokens of a single chat, much of it re-deriving established facts (attributed to Anthropic); a no-memory coding session spends a practitioner-estimated **5,000–20,000 tokens reconstructing project context** ([Augment Code](https://www.augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints)). SWE-bench anchors: ~35 API calls per trajectory with history growing each turn; input tokens are the majority of agentic spend even with caching on.

**(3) Memory overhead** — retrieval latency (2–4× in MemoryArena) and redundant/distracting context; wins only when context genuinely exceeds capacity (§4).

**Net whole-task answer:** memory is a net win when the injected context is *small, stable/cacheable, and prevents re-exploration that would otherwise dominate cost* — and a net loss when it is large, mutating, or retrieved indiscriminately. Anthropic's context-engineering guidance converges on the same principle: *"find the smallest set of high-signal tokens that maximize the likelihood of some desired outcome"*; every new token depletes a finite "attention budget" ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

**Honest gap:** no peer-reviewed, apples-to-apples "tokens-to-completion, memory vs no-memory, same tasks" number exists yet. Mem0's ~73% per-query token reduction is *per-query accounting* vs re-feeding full history, not end-to-end. Microsoft's STATE-Bench is the right instrument (measures average cost-to-complete incl. turns and redundant calls) but has published only no-memory baselines so far ([STATE-Bench](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/)). Two eye-catching figures (22–32% cost / 28–40% turns saved; a 24,008-run 59.2%/14.4% breakdown) **could not be traced to a primary source and are excluded.**

## 6. Context engineering practices (Anthropic, corroborated)

- **Just-in-time retrieval:** keep lightweight identifiers (paths, queries, links), load at runtime — rather than pre-loading. Mirrors Librarian's design where recall is a read-time query, not a baked-in blob.
- **Compaction, recall-first:** summarize a near-full trace, "maximizing recall first, then iterate to improve precision." Corroborated across Anthropic + JetBrains + academic work.
- **Observation masking ≈ summarization at half the cost:** replacing stale tool outputs with placeholders while keeping reasoning traces "halves cost while matching task-completion rate" (⚠ provisional vendor, [mem0 compression](https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract))).
- **Structured note-taking outside the window** (Claude-plays-Pokémon) enables horizons impossible if all state stayed in-context — the conceptual case for a Librarian at all.

---

## Design-implications table (research → Librarian decision)

| Librarian decision | Research verdict | Action |
|---|---|---|
| ~500-tok per-prompt injection; 10-turn mini-brief | **Strongly endorsed.** Focused ~300-tok > 113k-tok on LongMemEval; attention budget is finite. | Keep. Do not grow the budget "to be safe." |
| Top-5 recall | Endorsed *if high-signal*. One distractor measurably hurts (−18.6 pts). | Add a **BM25 relevance floor**; inject <5 when quality is low. Keep fail-closed. |
| Recall boosts human-authored above distilled | **Endorsed.** Verbatim beats LLM-extracted by 15.9–22 pts (⚠ provisional but consistent with peer-reviewed lossy-distillation). | Keep. Consider widening the boost margin. |
| Curated importer preserves verbatim body, no LLM normalization | **Endorsed** — same result. | Keep. This is a correctness feature, not just fidelity. |
| Distiller LLM-summarizes events → notes | Works, but pays a lossy-compression tax. | Keep strong `provenance.event_ids`; treat notes as *supplement to* recoverable verbatim, not replacement. |
| BM25 FTS5 only in v1; vector deferred | Defensible. | Keep. **First upgrade should be re-ranking, not vector** — it targets the distractor failure mode directly. |
| RRF fusion, project/global boost | Endorsed (RRF +38% MAP@10 over BM25 alone). | Keep. |
| `exp(-ageDays/90)` recency decay in code | **Endorsed.** Simple recency prior solves freshness; keeping it deterministic (not LLM) is right. | Keep; leave half-life tunable. |
| Session-start digest | Endorsed; it targets the 5–20k-tok re-establishment cost. | **Place it as a stable, cache-resident prefix** to earn the 90%/50% cache discount. |
| Per-prompt recall (changes each turn) | Correct to keep ephemeral, but it busts the cache. | Position volatile recall *after* the cacheable prefix; accept it pays full price. |
| Distill-skip heuristic | Endorsed — fewer low-signal notes = fewer future distractors. | Keep. |
| Fail-closed on untagged notes | Endorsed — injecting an unqualified note risks a distractor. | Keep. |

## Key takeaways

1. **Librarian's core instinct — keep memory small, high-signal, and human-biased — is exactly what the 2024–2025 peer-reviewed research prescribes.** The design is well-aligned with the evidence, not fighting it.
2. **The one correctness risk to actively guard is a low-relevance note filling a recall slot.** A distractor is worse than an empty slot. Add a relevance floor; don't force top-5.
3. **The distiller's summarization is the one place the design accepts a measured accuracy tax.** Strong provenance and the human-boost are the right mitigations; keep raw signal recoverable.
4. **When you extend recall, add re-ranking before vector search** — it attacks the distractor problem that the evidence says hurts most.
5. **To win the whole-task token argument, make the session-start digest a stable cacheable prefix.** That converts the "inject every turn" cost into a ~90% discount and is where the multi-turn economics actually turn positive.

## Methodology

Four parallel research agents, ~12–15 web searches each (WebSearch) plus deep-reads (WebFetch) of primary sources (Anthropic engineering blog, arXiv PDFs, Chroma report). Sub-questions: (1) context rot / long-context degradation; (2) agent memory systems & measured effects; (3) RAG retrieval-quality & context engineering; (4) whole-task token economics. Vendor self-benchmarks flagged; 2026 preprints postdating the knowledge cutoff marked ⚠ provisional and used only to corroborate peer-reviewed results, never to carry a conclusion alone. Two unverifiable figures excluded.

## Sources

**Context degradation:** [Lost in the Middle (TACL 2024)](https://arxiv.org/pdf/2307.03172) · [Context Rot / Chroma](https://www.trychroma.com/research/context-rot) · [RULER](https://arxiv.org/html/2404.06654v1) · [NoLiMa (ICML 2025)](https://arxiv.org/abs/2502.05167) · [GSM-DC (EMNLP 2025)](https://aclanthology.org/2025.emnlp-main.674/) · [How Contexts Fail](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html)

**Retrieval quality:** [The Power of Noise (SIGIR 2024)](https://arxiv.org/pdf/2401.14887) · [Chroma chunking](https://www.trychroma.com/research/evaluating-chunking) · [Redis RAG metrics](https://redis.io/blog/rag-metrics/) · [Reranking cross-encoders](https://bigdataboutique.com/blog/rag-reranking-improving-retrieval-quality-with-cross-encoders) · [RRF / OpenSearch](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/) · [Solving Freshness in RAG](https://arxiv.org/html/2509.19376)

**Memory systems:** [MemGPT](https://arxiv.org/abs/2310.08560) · [Letta benchmark](https://www.letta.com/blog/benchmarking-ai-agent-memory/) · [Mem0 paper](https://arxiv.org/html/2504.19413v1) · [Zep](https://arxiv.org/abs/2501.13956) · [Zep critique of Mem0](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) · [LongMemEval (ICLR 2025)](https://arxiv.org/abs/2410.10813) · [Generative Agents](https://ar5iv.labs.arxiv.org/html/2304.03442) · Memp ⚠[2508.06433](https://arxiv.org/html/2508.06433v2) · Verbatim-chunks ⚠[2601.00821](https://arxiv.org/pdf/2601.00821) · MemoryArena ⚠[2602.16313](https://arxiv.org/html/2602.16313v1)

**Token economics:** [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [OpenAI prompt caching](https://openai.com/index/api-prompt-caching/) · [SWE-Bench Pro](https://arxiv.org/pdf/2509.16941) · [Microsoft STATE-Bench](https://opensource.microsoft.com/blog/2026/05/19/introducing-state-bench-a-benchmark-for-ai-agent-memory/) · [RetrievalAttention](https://arxiv.org/pdf/2409.10516) · [Unblocked: why agents burn tokens](https://getunblocked.com/blog/why-ai-agents-burn-tokens/)
