# Review: Librarian Design Through Context, Memory, Correctness, Quality, And Token Efficiency

**Reviewed document:** `docs/specs/librarian-design-consolidated.md`  
**Reviewer:** GPT-5.5  
**Date:** 2026-07-04

## Bottom line

The design is directionally strong because it treats memory as a curated, queryable, provenance-bearing system rather than "just add more context". That matches the main lesson from AI memory, long-context, and RAG research: more context only helps when it is relevant, faithful, fresh, well-scoped, and well-positioned. Otherwise it degrades correctness and wastes tokens.

The biggest remaining gap is the open item in section 7: the recall/injection contract. That is not a minor implementation detail. It is where most correctness, quality, and total-token-efficiency gains or losses will be decided.

## Research findings applied

### 1. Long context is not equivalent to usable memory

Long-context models do not reliably use every part of a long prompt. Research around "lost in the middle" behavior shows that models are sensitive to placement, salience, and distractor density. Relevant facts can be ignored or misread when buried in large context windows.

Implication for Librarian: the design is right to avoid replaying the full conversation or event history into every request. Durable logs are storage, not prompt context. The event log and note log preserve history outside the model, while recall selectively injects small slices.

Relevant design support:

- The append-only event and note logs store memory outside the prompt.
- BM25 recall is the blessed retrieval path for v1.
- Injection budgets are explicitly left open, which makes them the next critical design area.

Design consequence: optimize for high-signal injected context, not large injected context.

### 2. Irrelevant retrieved context can hurt correctness

RAG systems often fail because retrieval returns plausible but irrelevant material. The model may anchor on stale or unrelated facts, merge contexts from different projects, or become more confidently wrong. In practice, recall precision often matters more than recall volume.

Implication for Librarian: the top risk is not missing memory. The top risk is injecting plausible but wrong, stale, or unrelated memory that sends the agent down a bad path.

The design already has strong mitigations:

- Project scoping through `project_slug`, `git_root`, and `git_remote` reduces cross-project contamination.
- Human-authored records are boosted over LLM-distilled records.
- Generated Obsidian exports are excluded from curated ingestion, preventing self-reinforcing feedback loops.
- Recall exposes freshness metadata through "indexed through note-log offset X".

Remaining need: explicit recall safety rules.

Recommended v1 rules:

- Inject fewer records by default.
- Prefer exact lexical/project matches over broad semantic similarity.
- Require project match unless a record is explicitly global.
- Separate facts, decisions, preferences, and episodes in the injected text.
- Include provenance and freshness in every injected block.
- Tell the agent that current workspace evidence outranks recalled memory.

### 3. Summarization improves efficiency but can destroy evidence

Distillation is necessary for token efficiency, but summaries are lossy. They can omit qualifiers, merge unrelated decisions, over-generalize temporary statements, or make uncertain conclusions look settled.

The design handles this better than most memory systems because provenance is collector-stamped, not LLM-authored. The distiller cites event indexes, and the collector maps those indexes to durable `event_id` values. This prevents hallucinated provenance and makes memories auditable.

Remaining risk: if recall injects only distilled summaries without source markers, the model may still treat lossy summaries as ground truth.

Recommended addition: injected memory should include compact source metadata, such as source kind, date, session, and event range. For debugging, the CLI should make it easy to inspect the source events behind a note.

### 4. Memory needs different lifetimes

AI memory is not one thing. Short-lived task context, medium-lived project decisions, durable user preferences, and historical episodes should not behave the same way.

The design partly captures this through note types and revision rules:

- Deterministic notes such as `project:{slug}:summary`, `person:{normalized_name}`, `daily:{yyyy-mm-dd}`, and `curated:{id}` may be revised.
- Episodic notes are immutable.
- Tombstones exist from day one.
- Recency decay is inherited from the SuperBrain recall model.

But recall behavior should differ by note type:

- `curated`: highest authority, especially for user preferences and explicit project rules.
- `decision`: high value when project-scoped and relevant.
- `project_summary`: useful at session start, risky per-prompt unless query-matched.
- `daily`: mostly short-term and freshness-sensitive.
- `episode`: useful for historical reconstruction, lower authority.
- `fact`: useful only when specific, fresh, and scoped.

Recommended addition: define this ordering in the recall/injection contract rather than leaving it implicit in scoring.

### 5. Total token efficiency is system-level

The right metric is not tokens per response. The useful metric is total tokens and turns until the user's goal is met.

Librarian's total cost is approximately:

```text
total cost =
  instrumentation overhead
+ distillation cost
+ indexing/export cost
+ recall injection cost
+ correction cost from bad memory
- saved rediscovery
- saved repeated user explanations
- saved failed attempts
```

The design already optimizes several terms:

- Instrumentation is dumb and cheap.
- Distillation is skipped for low-salience sessions.
- Recall is selective search, not full-history replay.
- Obsidian is an export view, not canonical storage.
- `librarian drain` provides manual recovery and avoids daemon complexity.

The dangerous hidden cost is correction cost from bad recall. One irrelevant memory item can cause multiple extra turns, tool calls, and user corrections. Therefore total token efficiency requires precision-first recall, not maximum recall.

## Assessment of the current design

### Strong choices

- The two-log architecture is sound. Raw event history and distilled note memory have different purposes and should not be conflated.
- Redaction-before-append is correct and important. Secrets in append-only replayable logs are effectively immortal.
- Collector-stamped provenance is one of the best decisions in the design.
- The generated/curated vault split prevents self-ingestion loops.
- BM25-only v1 is pragmatic. Lexical search is easier to debug, deterministic enough for early tests, and avoids premature vector complexity.
- `librarian drain` is important. Memory systems need inspectability and recovery more than they need always-on daemons.
- The deterministic-vs-episodic revision rule avoids turning v1 into an entity-resolution system.

### Main weaknesses

- The recall/injection contract is underspecified, and that is the area most tied to user-visible quality.
- There is no explicit memory confidence or authority model.
- There is no explicit stale-memory policy beyond recency decay.
- There is no evaluation plan for whether memory helped or hurt goal completion.
- The distiller prompt is deferred, but schema design may still assume more structured and reliable LLM output than smaller/local models will provide.
- Storage correctness is better specified than injection correctness, but injection is where correctness and token efficiency are won or lost.

## Recommended design additions

### 1. Define a precision-first recall contract

Suggested v1 behavior:

- Default per-prompt recall budget: roughly 300 to 700 tokens.
- Inject 0 to 5 records unless confidence is very high.
- Require project match or explicit global scope.
- Prefer curated and deterministic notes over episodic notes.
- Include provenance, timestamps, source kind, and freshness metadata.
- Do not inject stale daily or episodic notes unless they strongly match the query.
- Let the agent request deeper memory through search instead of preloading broad context.

### 2. Make injected memory visibly non-authoritative

Injected memory should be framed as potentially relevant prior context, not as system-truth. It should explicitly defer to current repository evidence and current-session user instructions.

Example shape:

```markdown
<librarian-memory indexed_through="notes/2026-07.ndjson:12345">
Project memories, possibly relevant. Prefer current repository evidence and current user instructions if they conflict.

1. Decision, 2026-07-03, curated, high authority
   The project favors KISS, file-over-app, minimal abstraction, and deliberate coupling.
   Source: curated:author-context

2. Project summary, 2026-07-03, distiller, medium authority
   Librarian uses event logs as raw telemetry and note logs as canonical memory records.
   Source: session 01J..., events 01J...-01J...
</librarian-memory>
```

### 3. Define authority ordering

Recommended v1 ordering:

```text
current workspace evidence
> explicit user instruction in current session
> curated memory
> deterministic project notes
> recent episodic notes
> old episodic notes
```

This ordering should be reflected in scoring, injected wording, and tests.

### 4. Track recall outcomes

To optimize total token efficiency, the system needs feedback beyond retrieval scores.

Minimal telemetry to record:

- Number of injected records.
- Injected token count.
- Query and top result metadata.
- Whether the user corrected recalled memory.
- Whether the agent cited or used memory.
- Whether local repo evidence contradicted memory.
- Turns/tool calls to goal completion with recall enabled.

This does not need to become a big analytics system. Even a debug log or periodic fixture evaluation is enough for v1.

### 5. Add negative recall tests

Golden fixtures should test not only that relevant memory is found, but also that irrelevant memory is excluded.

Recommended tests:

- Two projects with similar names do not contaminate each other.
- An old decision superseded by a newer curated note is not preferred.
- Secret-like prompt or command content is redacted before append.
- Generated Obsidian export is not re-imported as curated memory.
- An episodic note from another repo is not recalled for the current repo.
- A broad query does not inject low-confidence stale daily notes.

### 6. Preserve source access for summaries

Distilled notes should remain compact, but source inspection should be easy.

Recommended early CLI affordance:

```text
librarian note show <note_id> --with-provenance
```

This should show the latest revision, source kind, session, event range, and enough source excerpts to debug whether the note is faithful.

## Implementation implication

Do not start by maximizing memory richness. Start by making recall small, boring, inspectable, and hard to misuse.

Recommended v1 behavior:

- Session start: one compact project digest.
- Per prompt: 0 to 5 highly relevant records.
- On demand: CLI or MCP search for deeper memory.
- Distillation: asynchronous and skipped aggressively.
- Injection: tagged, provenance-bearing, freshness-bearing, and explicitly subordinate to current repo evidence.

This is more likely to improve correctness, quality, and total token efficiency than an ambitious "AI remembers everything" system.
