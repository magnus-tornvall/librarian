# Librarian — Feedback loops on memory output (research round)

**Date:** 2026-07-31. **Status:** research, not a settled decision. Companion to
`docs/specs/librarian-design-consolidated.md` (§5 decisions register, §6 recall/injection
contract, §8 diagnostics isolation, §12 items 12.2/12.5/12.11, §15 open items) and to issues
#91, #109, #171, #172, #179. If this document disagrees with the spec, the spec wins.

**Do not relitigate:** §8's diagnostics isolation (self-observation never becomes memory except
through a human curated note), 12.3's closure (no worth multiplier without a flowing
note-granular outcome signal), 12.8's closure (lexical overlap is not contradiction detection),
the §5 embeddings ruling (embeddings fetch candidates, never decide verdicts), #172's
addressability rule (validity closes through structural addressing, never guessed relatedness),
and §15's deferral of entity identity / episodic consolidation. This document is written *inside*
those rulings; where a recommendation touches one, it says so explicitly.

**Question that prompted this:** *When I learn something new, that knowledge can trigger further
realizations when combined with what I already knew. How do other memory implementations handle
this? What does memory research say? What feedback loops can we apply on librarian output —
events, notes, or both? Which are likely to be cost effective? Why should we apply
differently-sized loops on the data at all?*

---

## 1. Answer in one paragraph

The idea is real, and both literatures have names for it: **consolidation** (write-side synthesis
running at a slower timescale than acquisition) and **associativity** (linking done at read time).
Every serious agent-memory system implements one or both, and the cognitive-science prior is
strong — complementary learning systems (fast store + slow store + offline replay) and
sleep-dependent insight, where restructuring during an offline period produces explicit insight
that an equal period of waking does not. But the same literature is unusually clear about the
failure mode: consolidation stages hallucinate and their errors propagate downstream, recursive
self-generated content drifts, self-evolving memory degrades safety, and at least one 2026
evaluation finds an extra reflection layer *hurting* a pipeline that already reasons well. For
librarian specifically, three settled invariants make "new notes derived from old notes" the most
expensive loop available (provenance is collector-stamped from events; faithfulness verify is
defined against events; §8 forbids the usage-signal→memory path), while three much cheaper loops
are sitting unbuilt: the deterministic `project:{slug}:summary` note already **is** a slow-store
consolidation slot that nothing currently schedules; every note already carries `links` that
recall never follows; and `librarian stats` already is the policy loop, with the human curated
note as the sanctioned door for genuine insight. And one scale fact governs all of it — per
#179's probe the real store holds **68 notes from 260 sessions**, with 25 sessions hitting the
same node/ABI failure and *zero* notes capturing it. There is very little to consolidate and a
great deal to capture. Fidelity first, then correction loops, then exactly one bounded synthesis
loop on an addressable key.

## 2. Vocabulary: four loops that get conflated, plus the non-loop

"Feedback loop on librarian output" is four different mechanisms with four different risk
profiles. Conflating them is what makes the topic feel large.

| # | Loop kind | What it changes | Unit it acts on | Librarian status |
|---|---|---|---|---|
| 1 | **Acquisition** | events → a new note | event delta | Shipped (gated admission pipeline, §5) |
| 2 | **Correction / validity** | closes or replaces an *existing* note | one addressed note | Partial: supersede/flag/12.2 shipped; #172, #91 pending |
| 3 | **Consolidation / synthesis** | derives a *new, more abstract* note from notes | a set of notes | **Does not exist. The actual subject of this round.** |
| 4 | **Policy / tuning** | changes weights, gates, prompts — writes no memory | the config + the prompt | Shipped (`librarian stats`, 12.10) |
| — | *Read-side association* | changes what a query returns, writes nothing | the candidate set at recall | Not built; `links` exist and are ignored |

The last row is not a loop at all, and that is precisely why it matters: it buys a large share of
what people want from loop 3 (multi-hop, "this connects to that") at a fraction of the cost and
with none of the write-side risk.

**The load-bearing observation for the whole document:** the safety of a loop is decided by *how
it addresses its target*, not by how often it runs. Loop 2 is safe when it addresses a
deterministic key or an exact provenance link (#172's rule) and unsafe when it guesses relatedness.
Loop 3 has the same property, and almost every implementation in §3 addresses its target by
similarity or clustering — i.e. by guessing. That is the same deferred entity-resolution problem
§15 names, wearing a new hat.

## 3. How other implementations handle "new knowledge triggers realizations"

| System | Loop kind | Size / trigger | What it writes | Cost shape | Reported outcome |
|---|---|---|---|---|---|
| **Generative Agents** (Park 2023) | 3 | importance-sum > 150; ~2–3× per simulated day | reflection nodes citing the observations they came from; reflections can reflect on reflections (recursive tree) | 1 question-generation + 1 synthesis call per reflection | Ablation: removing reflection dropped believability from μ=29.89 to μ=26.88 (TrueSkill) — the strongest pro-synthesis result in the field |
| **A-MEM** (Xu 2025) | 2+3 | *per note*, the smallest possible loop | links to neighbours, plus rewritten context/tags on the neighbours ("memory evolution") | 2 LLM calls per memory event | Up to 6× on multi-hop; 85–93% fewer memory-operation tokens vs. baselines |
| **Mem0** | 2 only | per message pair | ADD / UPDATE / DELETE / NOOP against retrieved similar memories | 1 extract + 1 update call | Deliberately *no* abstraction layer — correction is the whole loop |
| **Zep / Graphiti** | 2+3 | continuous per episode; communities refreshed lazily | bi-temporal edge invalidation (invalidate, never discard) + community summaries via label propagation | incremental by design — label propagation was chosen over Leiden *because* it extends dynamically and delays full recompute | Temporal invalidation is the headline feature, not abstraction |
| **RAPTOR** | 3 | offline, whole corpus | recursive cluster → summarize → recurse tree; retrieval reads multiple abstraction levels | full re-index; GMM soft clustering + UMAP | +20% absolute on QuALITY with GPT-4 |
| **GraphRAG** | 3 | offline, whole corpus | entity graph + hierarchical community summaries | one LLM call per chunk; **~$33k** for a large enterprise index in early 2024 | LazyGraphRAG then moved *all* LLM summarization to query time, reaching plain-vector indexing cost (~0.1%) with global queries up to 700× cheaper |
| **HippoRAG 2** | read-side | query time | nothing durable — Personalized PageRank over a KG | cheap offline indexing vs. GraphRAG/RAPTOR/LightRAG | +7 F1 over embedding retrievers on *associative* tasks while beating summarization systems that specialize in sense-making |
| **Letta sleep-time compute** | 3 | between sessions, on idle | "learned context" derived from raw context | pays off only when one context serves *multiple related* queries | ~5× fewer test-time tokens; explicitly **not** worth it for one-off questions |
| **MemoryOS** | 3 | promotion by **heat** (visit frequency × interaction length), not by clock | STM→MTM→LPM; persona/profile updates | tiered, amortized | +49% F1 vs GPT-4o-mini baselines on LoCoMo |
| **TiMem** (ACL 2026 Findings) | 3 | temporal hierarchy levels | temporal memory tree, progressively abstracted persona | consolidation across levels, no fine-tuning | 75.30 LoCoMo / 76.88 LongMemEval-S **and 52.20% shorter recalled memory** |
| **Consumer products** | mostly 2 | background | ChatGPT "Dreaming" (reported June 2026) curates and updates stale entries ("going to Singapore" → "went to Singapore"); Claude.ai synthesizes project summaries; Claude Code = flat markdown | vendor-side | Direction of travel is background *curation*, not abstraction |

Three patterns are worth extracting, because they are what actually transfers:

1. **The systems that win on associativity do it at read time** (HippoRAG 2), and they beat the
   systems that bought associativity with write-time summarization — while spending less offline.
2. **The systems that win on cost do correction at write time and nothing else** (Mem0, Graphiti's
   invalidation). Correction is the cheap half; abstraction is where the money goes.
3. **The measurable win from hierarchy is compression, not accuracy** — TiMem's honest headline is
   52% less recalled memory at equal-or-better accuracy. For librarian, whose push budget is
   already 0–5 notes and ~300–700 tokens, *that win is already banked by the distiller*. This is
   the single most important negative finding in the table.

## 4. What memory research actually claims — and what it doesn't

**For the idea:**

- **Complementary learning systems** (McClelland et al. 1995 and the bidirectional-interaction work
  since): a fast, pattern-separating hippocampal store and a slow, generalizing neocortical store,
  exchanging information through replay during off-task periods. Generalization is a property of the
  *slow* store. This is a direct argument for **two** timescales — not five.
- **Sleep inspires insight** (Wagner, Gais, Haider, Verleger & Born, *Nature* 2004): more than twice
  as many subjects gained insight into a hidden rule after 8h of sleep than after equivalent
  wakefulness, at matched times of day. Insight here is explicitly *restructuring* of an existing
  representation. This is the closest thing in the literature to the intuition in the question.
- **The clause that matters more than the result:** sleep produced no insight benefit *in the absence
  of initial training*. Consolidation amplifies what was encoded; it cannot recover signal that was
  never captured. Applied to librarian: a loop over intent-only tool events restructures a record
  that never contained the failure. That is #179, and it dominates every loop in this document.

**Against, or bounding it:**

- **Model collapse / recursive-training literature:** training on recursively generated output loses
  distribution tails and drifts, with error growing per iteration; the mitigation that works is
  *accumulating* real data rather than replacing it (a finite error bound rather than an unbounded
  one). Notes-derived-from-notes is the same shape at the corpus level.
- **HaluMem** (first operation-level hallucination benchmark for memory systems): systems generate
  and accumulate hallucinations at *both* the extraction and update stages, and those upstream
  errors propagate into QA and amplify. Every consolidation layer is another extraction stage.
- **MemEvoBench / "Your Agent May Misevolve":** biased or contaminated memory accumulation produces
  gradual behavioural drift; risks are self-generated by routine evolution, and static prompt-based
  defenses are insufficient. Librarian's honest reading of this is already in §6 ("labels are a
  prior, not a guard").
- **Semantic drift under reconsolidation:** the 2026 agent-native-memory analysis (arXiv 2606.24775)
  frames it bluntly — repeated summarization distorts facts; every time you allow reconsolidation
  you allow distortion. (Full text returned 403 to my fetch; this and the next bullet are taken from
  indexed excerpts, not a read of the paper.)
- **A negative result on stacking loops:** the same 2026 line of evaluation reports that adding
  reflection *on top of* planning yields no further gains and may weaken routing decisions.
- **Memory poisoning research:** a wrong memory is self-reinforcing — decisions made from it generate
  new memories that corroborate it, and the original error becomes progressively harder to identify
  because it is surrounded by legitimate-looking descendants.

**Synthesis of the evidence:** the research supports two timescales, correction-heavy maintenance,
read-time association, and compression as the measurable win. It does not support unbounded
recursive self-synthesis, and it specifically warns about the failure being *quiet*.

## 5. Where librarian's own invariants bite

Six constraints decide which loops are cheap here and which are expensive. They are the reason a
generic "add a reflection pass" recommendation would not survive.

1. **§8 reflexive isolation.** Diagnostics never enter memory; insights from them enter through
   exactly one door — a human curated note. So any loop driven by *usage* signals (dead notes,
   injection traces, cut reasons) can legitimately end in a policy change or a human note, and
   never in a machine-minted memory. This rules out the entire "learn from what got injected"
   family by construction. It is the right call and this document does not reopen it.
2. **Provenance is collector-stamped from events** (§7, §10, drill-down tool in §6). A note
   synthesized from notes has no `event_range`. Either the field quietly becomes optional — which
   breaks the endorsed "distilled notes are a supplement to recoverable verbatim source" property
   that `note show --with-provenance` sells — or a new provenance kind is needed (`derived_from:
   note_ids[]`). That schema decision, in an append-only sacred log, is the single largest
   complexity driver of any synthesis loop.
3. **Faithfulness verify is defined against events** (12.6). A note-derived note has no events to
   verify against, so it would enter the log with *weaker* admission control than an ordinary note —
   exactly backwards for the record class with the broadest match surface.
4. **#172's addressability rule.** Validity may be closed only through structural addressing
   (content-derived key or exact provenance link), never guessed relatedness — and §5 records that
   embeddings score contradictions as near neighbours. "Cluster similar notes and synthesize" is
   guessed relatedness by definition; it is the deferred entity-resolution problem (§15).
5. **Episodic immutability + latest-wins.** A synthesis loop cannot revise episodic notes. It can
   only *add* — and adding is the expensive direction.
6. **The 0–5 budget, the floor, and the workspace-bottleneck rationale (§6).** An abstraction note
   is by construction a strong match for many queries. Under a fixed 5-slot budget it does not add
   capacity; it **displaces** the specific note that would have been more useful, and a
   near-miss distractor is measurably worse than an empty slot. Benchmarks in §3 measure recall@k on
   QA; librarian's product surface is precision under invisible injection. The gains in that table
   are not denominated in librarian's currency.

**And the scale fact.** #179's probe of the real store: 7266 tool events, 260 sessions, **68 notes**.
Twenty-five of those sessions hit the same `NODE_MODULE_VERSION` / `nvm use` failure; zero notes
captured it, while the same lesson was hand-written into a Claude Code memory file after **one**
occurrence — because that session saw the error text. A corpus of 68 notes has very little to
consolidate. The deficit is upstream of every loop in this document.

## 6. The honest cost model for this project

Token cost is not the binding constraint. One user, a local Ollama or `claude -p`, 68 notes, monthly
cadence: a corpus-wide reflection pass is a handful of calls — effectively free. So a
"cost-effective" ranking based on tokens would be worthless here. The real ledger:

| Cost term | Why it dominates | Which loops pay it |
|---|---|---|
| **Risk cost** | a wrong note is injected *invisibly*, matches broadly, and (per §5) has weaker verification | loops that mint notes |
| **Irreversible surface** | new record kinds/fields in an append-only sacred log are forever; mistakes are superseded, never deleted | loops needing new provenance/record kinds |
| **Explainability loss** | `why` / `why-not` / drill-down are the differentiator vs. vendor memory; a derived note degrades all three unless the derivation chain is stored | synthesis loops |
| **Maintenance** | each loop size adds a scheduler trigger, a prompt, a verdict class, and fixtures | all loops |
| **Opportunity cost** | the same effort on #179/#171 buys more memory quality with no new risk class | all loops |

So cost-effectiveness here is decided by three questions, in order: **does it write to memory?**
**is its target structurally addressable?** **does it need a new record kind?** Loops that write
nothing are nearly free. Loops that revise an addressable note are cheap. Loops that mint derived
notes are expensive *regardless of token cost*.

## 7. The loop catalogue, sized, with verdicts

| Loop | Size / trigger | Writes | Addressing | New schema? | Verdict |
|---|---|---|---|---|---|
| **A. Acquisition** | per event delta | new note | — | no | Shipped |
| **B. Trailing-delta supersession** (#172) | intra-session | closes one note | exact `provenance.session_id` | widen supersession source union | ✅ Keep, gated on #171 as designed |
| **C. Injected-note contradiction** (12.11 / #91) | session boundary | closes one note | exact trace join (session_id × shipped ids) | needs #109 so it doesn't depend on deletable diagnostics | ✅ Highest-value *correction* loop; keep deferred but ahead of any synthesis |
| **D. Project-summary re-consolidation** | every N notes for a slug, or first session of a day/week for that project | **revises one existing note** | deterministic key `project:{slug}:summary` | **none** | ✅ **The one synthesis loop to build.** See below |
| **E. Read-side one-hop link expansion** | per query | nothing | follows `links` already on retrieved notes | none | ✅ Cheapest associativity win; fixture-gated |
| **F. Clustered / reflection-tree synthesis** | daily/weekly/corpus | mints derived notes | **similarity — guessed** | `derived_from` provenance | ❌ Refuse now; named trigger below |
| **G. Cross-session failure-pattern mining** | corpus | mints notes | similarity | as F | ❌ #179 makes *one* session sufficient; revisit only if post-#179 stats show recurrence |
| **H. Usage/outcome → ranking** | continuous | changes scoring | — | — | ❌ Closed by 12.3 and forbidden in shape by §8. Stays closed |
| **I. Policy loop** (`stats` → weights/prompt/gates) | weekly-ish, human in the middle | nothing in memory | — | none | ✅ Already exists; extend its measurements |
| **J. Human insight loop** (read stats/vault → curated note) | irregular | a curated note | human judgment | none | ✅ The §8-sanctioned door for realizations |

### Why D is the loop that survives

`project:{slug}:summary` is already a deterministic-ID note: revisable by the LLM distiller, fetched
by exact key (never searched), faithfulness-verified, exempt from the novelty gate because revisions
are *supposed* to overlap their prior, and **bounded to one note per project** so it cannot inflate
note count or the distractor surface. It is, structurally, the slow store that CLS describes and that
TiMem/MemoryOS build elaborate trees to approximate. Librarian has it already — what it lacks is a
*trigger*: today it is revised only when a session happens to be about the project summary.

Scheduling that revision is therefore the rare case where the expensive-sounding idea costs nearly
nothing: no new record kind, no new provenance kind, no guessed relatedness, no growth in the note
count, and it inherits every existing gate. Its input can legitimately include the project's recent
notes *as context for revising one addressed note* — which is categorically different from minting a
new note from a cluster of them. The residual risk is real and bounded: drift in a single note across
repeated revisions (the reconsolidation-distortion warning from §4), with the existing backstops —
append-only history, `previous_revision_id` chain, `note edit` / `revise_note`, `flag_note`.

### Why E is worth doing before any of F/G

The `links` array is in the note schema and recall ignores it. One-hop expansion of *already
retrieved* notes is deterministic, LLM-free, writes nothing, and is trivially reversible. It is the
HippoRAG lesson applied at the cheapest possible scale. It must run before the floor and the budget,
and it needs the same acceptance test hybrid scoring got: **expansion must not resurrect below-floor
distractors**, proven by the §9 negative-recall fixtures.

## 8. Why apply differently-sized loops at all — the direct answer

Because signals settle at different times, and each loop size can only act on what has settled:

| Signal | Settles after | Only visible to |
|---|---|---|
| A conclusion was corrected mid-work | one session | intra-session loop (B) |
| A shipped note was wrong | that session's end | boundary loop (C) |
| Notes about one project have fragmented / gone stale | a few sessions on that project | project-scoped slow loop (D) |
| An abstraction spans projects | many sessions | corpus loop (F) — refused |
| We are injecting distractors | many injections | policy loop (I) |

A single per-delta loop is structurally blind to everything below the first row. That is the honest
justification for multiple sizes, and it comes with an honest limit: **a loop is only safe at a given
size if something structurally addressable exists at that size.** Session id addresses B. The trace
join addresses C. The deterministic project key addresses D. Nothing addresses F except similarity —
which is why F is refused, and why the answer to "why differently-sized loops" is *sizes follow
addressability, not cadence aesthetics*.

## 9. Critique of this research round

- **Domain transfer is weak.** LoCoMo/LongMemEval/BEAM are conversational-personalization
  benchmarks; librarian is a coding-agent memory with an invisible 0–5 push budget. Gains in §3 do
  not obviously transfer, and BEAM is explicitly unsaturated by any current architecture.
- **The strongest pro-synthesis result measures the wrong thing.** Generative Agents' ablation
  measures *believability of a simulated character*, not injection precision.
- **The neuroscience justifies a shape, not a mechanism.** Wagner 2004 is one human study on a
  number-reduction task; a preregistered replication attempt exists (CCN 2024) whose outcome I did
  not read. CLS is about weight-based consolidation in neural systems, not text records — the
  analogy is suggestive, not evidential.
- **Some 2026 sources are secondary.** Two arXiv full texts returned 403; those claims come from
  indexed excerpts. The ChatGPT "Dreaming" behaviour is reported by third-party write-ups, not
  verified against a vendor doc.
- **I measured nothing.** The 68-notes/260-sessions figures are #179's probe, not an independent
  count. Crucially, **this round cannot tell you whether synthesis would help librarian** — no
  fragmentation or multi-hop-miss measurement exists yet. Recommendation R5 is partly an admission
  of that.
- **Confirmation risk in my own conclusion.** "The loop you should build is the one that fits your
  existing invariants" is a suspiciously convenient finding. The check on it: D's value claim is
  falsifiable — if #171 and the association probe both report zero harm, D is unnecessary too, and
  that should close it rather than motivate a bigger loop.

## 10. Recommendations (ordered; each survives §9)

- **R1 — Ship #179 before any loop work.** Sleep produces no insight without prior training. 25
  sessions × the same failure × 0 notes is an acquisition deficit, and no loop over intent-only
  events recovers it. Everything else in this list is downstream.
- **R2 — Prioritise the correction family over the synthesis family.** #172 (gated on #171, as
  designed), then #91 with #109 so the detector reads a durable ledger rather than deletable
  diagnostics. This is what the field's cost-effective systems actually do.
- **R3 — Build exactly one new synthesis loop: scheduled `project:{slug}:summary`
  re-consolidation.** Deterministic key, one bounded note, existing revision semantics, existing
  faithfulness verify, provenance = the triggering delta. Hard rule: it may revise *that key only*,
  and may never mint or close any other note. Trigger candidate for the issue to settle: N new notes
  for the slug since the last summary revision (N measurable from the note log), not a wall clock.
- **R4 — Add read-side one-hop link expansion, gated on the negative-recall fixtures.** Deterministic,
  no LLM, no writes. Acceptance test mirrors hybrid's: expansion must not resurrect below-floor
  distractors. Do this *before* considering any write-side abstraction.
- **R5 — Extend `librarian stats` with the two metrics the refused loops are gated on:** #171's
  fragmentation harm, plus an **association-miss probe** (a shipped note's `links` point at a note
  that scored below floor, and the session subsequently touched that note's subject). If both stay
  at zero, F and G are *not needed* — and, per the #172 precedent, that is a success, not a gap.
- **R6 — Refuse F, G and H for now, with named triggers recorded:** clustered/embedding
  consolidation and reflection trees (trigger: fragmentation harm > 0 *and* association misses that
  R4 does not fix); cross-session failure-pattern mining (trigger: post-#179 stats show the same
  failure class recurring after capture works); usage→ranking (stays closed per 12.3/§8).
- **R7 — Route the durable parts per AGENTS.md; do not invent a fourth home.** If R3/R4 are accepted,
  the spec needs two lines and no more: **(a)** extend #172's addressable-vs-guessed rule from
  *closure* to *creation* — a note may be derived only from events or from a deterministic key it can
  address, never from a guessed set of related notes; **(b)** state that in v1 no note is derived
  from notes, with F's trigger named. Everything else — schedule, prompt, fixtures, metrics — belongs
  on issues.

---

## Sources

Agent-memory systems: [Generative Agents](https://arxiv.org/pdf/2304.03442) ·
[A-MEM](https://arxiv.org/html/2502.12110v1) · [Mem0](https://arxiv.org/html/2504.19413v1) ·
[Zep/Graphiti](https://arxiv.org/pdf/2501.13956) ·
[Graphiti engineering notes](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/) ·
[RAPTOR](https://arxiv.org/pdf/2401.18059) ·
[LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/) ·
[HippoRAG 2 / From RAG to Memory](https://arxiv.org/abs/2502.14802) ·
[Sleep-time compute](https://arxiv.org/html/2504.13171v1) ·
[Letta sleeptime agents](https://forum.letta.com/t/sleeptime-agents-for-memory-consolidation-best-practices-guide/154) ·
[MemoryOS](https://arxiv.org/abs/2506.06326) ·
[TiMem](https://aclanthology.org/2026.findings-acl.1091/)

Evaluation and failure modes: [HaluMem](https://arxiv.org/abs/2511.03506) ·
[MemEvoBench](https://arxiv.org/pdf/2604.15774) ·
[Your Agent May Misevolve](https://arxiv.org/abs/2509.26354) ·
[Are We Ready For An Agent-Native Memory System?](https://arxiv.org/abs/2606.24775) ·
[Memory poisoning attack and defense](https://arxiv.org/html/2601.05504v2) ·
[Model collapse / accumulating data](https://openreview.net/forum?id=5B2K4LRgmz) ·
[Agent memory benchmarks 2026](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)

Cognitive science: [Sleep inspires insight (Wagner et al., Nature 2004)](https://www.nature.com/articles/nature02223) ·
[Preregistered replication attempt (CCN 2024)](https://2024.ccneuro.org/pdf/29_Paper_authored_CCN_2024.pdf) ·
[Complementary learning systems (McClelland et al. 1995)](https://www.researchgate.net/publication/15575602_Why_There_are_Complementary_Learning_Systems_in_the_Hippocampus_and_Neocortex_Insights_from_the_Successes_and_Failures_of_Connectionist_Models_of_Learning_and_Memory) ·
[Bidirectional CLS interactions](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9606815/)
