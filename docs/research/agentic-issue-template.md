# Librarian — Issue shape for parallel, token-efficient agent work

**Date:** 2026-08-01. **Status:** analysis + delivery plan, not a settled decision. Companion to
`AGENTS.md` ("Project tracking — where things live", "The routing test") and
`docs/specs/librarian-design-consolidated.md` §14 ("Backlog execution: agents"). If this document
disagrees with `AGENTS.md`, `AGENTS.md` wins until the amendment in step 4 lands.

**Do not relitigate:** the three homes (specs / issues / Project v2) and the routing test are settled
and correct. This document does not propose a fourth home, a status field in the spec, or an issue
ledger. It proposes *enforcing* the routing test with a template, and bounding issue size.

**Question that prompted this:** *issues focused on goal/outcome, requirements and constraints make a
good foundation for agentic work; issue size matters for token efficiency; subtasks should be used
liberally. What template optimizes for parallel agents working token-efficiently?*

---

## 1. Answer in one paragraph

Librarian's issues are already outcome-first and already carry runnable success signals — the two
things the field converged on as load-bearing. What they lack is a **size bound**, a **mandatory
file-touch set**, and **placement discipline for the reasoning**: today the durable analysis (evidence
tables, corpus probes, superseded approaches) sits inline in the issue body, which is exactly what the
repo's own routing test says belongs in the spec or a research doc. So the change is not "write
shallower issues" — the analytical depth is an asset and it is why these issues succeed. It is
**re-layering**: the body becomes the ~400-token execution contract (outcome, why, touchpoints,
constraints, success signals), and the depth moves one link away, fetched on demand. Add a mandatory
`Touchpoints` field and the file-touch set stops being a retrieval hint and becomes a *scheduling
key* — sibling tasks with disjoint touchpoints run in parallel, overlapping ones get `blocked by`.
That is the whole mechanism by which "many small issues" turns into actual parallelism rather than
merge conflicts.

## 2. What the token budget actually is

The naive model ("shorter issue = cheaper") is wrong in a way that matters, because it leads to
deleting the pointers that are the highest-value tokens in the whole body.

An issue body is read once into the agent's prompt, then **replayed as prefix on every subsequent
turn**. A 20-turn session carrying a 2,000-token issue processes ~40k tokens of issue text. Prompt
caching cuts the *dollar* cost of that replay by up to ~90%, so cost is the secondary concern. The
primary concern is that replayed text is not free in the model: every frontier model degrades
measurably as input grows, well before the window fills ("context rot"), and instruction adherence
drops as the number of simultaneous instructions rises — present ten detailed rules and the first few
get obeyed while the rest quietly don't. A long issue does not just cost more; it **silently loses
requirements**.

Against that, exploration is the larger and less visible line item. Tool output goes straight back
into context and is itself replayed. One repo-wide `grep` plus three file reads can be 5–15k tokens
of permanent prefix. So the rule is not brevity — it is **net** tokens:

> A token in the issue body earns its place if it removes at least one tool round-trip, or removes a
> plausible wrong turn. Otherwise it is pure dilution, paid every turn.

`src/recall/query.ts:16,60-68` is ~10 tokens and gets the agent the exact bytes on demand. The
20-line excerpt of that same code is ~200 tokens, replayed every turn, and goes stale on the next
refactor. Pointers win twice.

## 3. What the research and community practice actually support

Findings that survived cross-checking, with the design consequence each one forces:

| Finding | Consequence for the template |
|---|---|
| Agent success falls sharply with breadth: ~18% at 1–2 files modified vs ~2% at 7+; ~20% for patches under 50 lines vs ~3% over 200 (SWE-bench-family analyses, 2026) | Size is a *correctness* lever, not only a cost lever. Bound the issue, don't just bound the prose. |
| Context rot: every frontier model degrades as input grows, before the window fills (Chroma) | Hard token budget per body, enforced by review not by hope. |
| Instruction dilution: adherence to each rule drops as rules accumulate | Cap constraints and success signals (≤5 each). More than that means "split", not "smaller font". |
| Over-specification destabilizes agents — detailed steps get either ignored or followed too literally; declarative outcome + constraints wins ("if you overspecify, you may as well code it yourself" — Osmani) | No implementation step lists. Outcome + invariants + touchpoints; leave the *how* to the agent. |
| Exhaustive acceptance criteria on small tasks cost more overhead than they buy accuracy (Böckeler); heavy upfront spec assumes nothing is learned during implementation (Beck) | Success signals are a *verification contract*, not a design document. Name what to check, not every case. |
| Omitting a required section is filled with hallucinated assumptions (Augment) | The mandatory fields are mandatory. A blank `Touchpoints` is a bug in the issue. |
| Two agents editing one file conflict; tasks sharing files must be sequenced, not parallelized (worktree practice, near-universal) | Declared touchpoints are the disjointness check. This is the parallelism mechanism. |
| Well-scoped issue + explicit acceptance criteria + "which files to change" is the stated ideal task for GitHub's coding agent; sub-issues exist to make work parallel and PRs small | Matches the field set below; sub-issues are the intended vehicle. |
| Progressive disclosure (Agent Skills): metadata → instructions → reference files, loaded in stages | Three layers, mapped in §4. The issue body is layer 2, never layer 3. |
| Human-written context files improved success ~4%; auto-generated ones *reduced* it ~3%; AGENTS.md-class files can add >20% inference cost per session for minimal gain | Don't inflate the template with boilerplate the agent must read every time. Standing rules live in `AGENTS.md` once, not per issue. |
| Issue forms produce stable slugified headings, parseable to JSON | A dispatcher can read *only* `Touchpoints` across N issues to plan a wave, without pulling N bodies into context. |

## 4. The three layers

| Layer | Artifact | Read when | Budget |
|---|---|---|---|
| 1 — dispatch | title + labels + `blocked by` + touchpoints field | selecting/ordering work; N issues at a time | ≤ 15 tokens/issue |
| 2 — execute | issue body | one issue, by the agent doing it | **≤ 400 tokens (task) / ≤ 700 (story)** |
| 3 — understand | spec §, `docs/research/*.md`, prior issue/PR, `file:line` | only when layer 2 leaves a real ambiguity | unbounded |

Layer 1 is why titles change. Current titles are ~15–25 words with the editorial argument in them
(`fix: vector recall post-filters a global top-k — scope-starved KNN degrades silently as the corpus
grows`). That argument belongs in the `Outcome` line; the title should be dispatchable in ≤ 10 words.
Multiply the saving by every list view an orchestrator loads.

Layer 3 is why nothing shrinks in substance. Moving the corpus probe out of #179 and into
`docs/research/` costs one link and gains three things: the body stops diluting, the analysis outlives
the closed issue, and the routing test is finally obeyed rather than described.

Note on comments: `issue_read` returns the body without comments by default. So an issue's *history*
(superseded approaches, resolved blockers, review back-and-forth) genuinely leaves the hot path when
it moves to a comment. `<details>` does **not** — a collapsed block is a human affordance and costs
the agent every token. Do not reach for it.

## 5. Field set

Fixed order. Every field justified by what it removes, not by what it documents.

1. **Title** — `type(scope): imperative outcome`, ≤ 10 words. Layer 1: enough to dispatch and dedupe
   without opening the body.
2. **Outcome** *(mandatory, 1–2 sentences)* — the observable change this ships, declaratively. This is
   today's `What`, unchanged; it already works.
3. **Why** *(mandatory, 1 sentence)* — the pain or value. Not decoration: it is what keeps the agent's
   unavoidable judgment calls pointed the right way when the constraints under-determine. One line.
4. **Touchpoints** *(mandatory, list of paths, `file:line` where known)* — expected, not binding.
   Two jobs: kill the opening repo-wide search, and serve as the disjointness key for parallel
   dispatch (§7). "Unknown — investigation first" is a legitimate value, and it is also a signal that
   the issue should be a spike with its own success signal.
5. **Constraints** *(≤ 5 bullets)* — invariants that must hold, settled decisions in play **by
   pointer** (`§4`, `docs/specs/structural-invariants.md#2`), and the deliberate non-goals. This
   absorbs today's "Do not relitigate" and the out-of-scope prose in `Notes`, as links rather than
   restated argument. Negative constraints belong here and are cheap: "do not touch the event-side
   `git_root`" prevents a whole class of over-reach in ~10 tokens.
6. **Success signals** *(mandatory, ≤ 5, runnable)* — already the repo's strongest habit. Tighten to:
   each must be checkable with no human judgment, and at least one must fail on `main` before the work
   (#182 already demands this — make it the norm). The standing `build + test + lint` bar lives in
   `AGENTS.md`; restate it as a single line only, not a paragraph.
7. **Context** *(optional, links only)* — spec §, research doc, prior issue/PR. Layer 3's index.

Fields deliberately absent, each with the reason:

- **Implementation steps / task checklists in prose** — over-specification is destabilizing, and the
  checklist form encourages issues that are three issues (#154, #155 both do this). Where sequence
  genuinely is the deliverable, the checklist becomes *sub-issues*, which are schedulable.
- **Code excerpts** — `file:line` pointer instead. Same bytes on demand, no staleness, no replay.
- **Evidence tables / corpus probes** — `docs/research/*.md`, linked.
- **Superseded-approach history** — spec amendment log if it outlives the unit; an issue comment if it
  dies with it.
- **Estimates, personas, priority prose** — Project v2 is the view engine; the user never varies.

## 6. Sizing rule

One issue = one agent session = one PR = one reviewable diff. Split when **any** of these is true —
these are mechanical, so the decision doesn't need a judgment call:

- Touchpoints span more than ~3 files, **or** cross a pipeline-stage boundary
  (`collector | distill | embedding | index | recall | render | export`). The stage seams already have
  explicit I/O contracts (spec §4), so they are the natural cut lines and the resulting pieces are
  independently testable by construction.
- More than 5 success signals, or two signals that could pass and fail independently.
- A schema/contract change plus its consumers — schema first as its own issue, consumers `blocked by`
  it. `schema/`, `src/`, and the golden examples moving together is the one legitimate exception,
  because they are one contract.
- The body cannot be stated inside budget without dropping something load-bearing.

Bias hard toward splitting. Per §3, a 1–2 file task is an order of magnitude likelier to land than a
7-file one, and two 45-line diffs review better than one 90-line diff. The cost of splitting is one
extra issue and one `blocked by` edge; the cost of not splitting is a silent partial implementation.

## 7. Touchpoints as the parallel-dispatch key

This is the field that makes the premise ("many small changes, parallel agents") actually work.

- Sibling tasks under one story **must** have disjoint touchpoint sets. Overlap is not a warning, it
  is a `blocked by` edge — set the native GitHub relationship, mirror it with the body line, per
  `AGENTS.md`.
- With that rule, the Epic → Story → Task tree plus `blocked by` is a dependency graph a dispatcher
  can topologically sort: every task with no unmet blocker and no touchpoint collision against
  in-flight work is safe to start in its own worktree, now.
- The dispatcher reads layer 1 only. Issue forms give stable headings, so `Touchpoints` is extractable
  as JSON across the whole open set — planning a wave of six tasks costs ~100 tokens, not six bodies.
- Shared-file magnets need naming up front. Here they are `src/cli.ts` (every command touches it),
  `schema/*.md`, `docs/specs/librarian-design-consolidated.md`, and `AGENTS.md`. Two tasks both
  adding a CLI subcommand are *not* parallel-safe. Either sequence them or make the CLI edit its own
  tiny task landing first.

Explicit non-goal: DRY across the family. A story may carry framing its children share, but a task
agent must never have to read the parent to do the work. Anything load-bearing is in the task, or
behind a link in the task. Deduplicating context into the parent is the one refactor that would
quietly break single-issue autonomy.

## 8. Current state, measured

Sampled eleven bodies (#150–#156, #175, #176, #179, #182). They run roughly 1.3k–7.5k characters
(≈350–1,900 tokens), bimodally: the packaging stories (#150–#154) sit near 350–500 tokens and are
close to the target already; the recent analytical issues (#175, #179, #182, #155) sit at 3–5× budget.
None of the eleven is *bad* — the depth is real and it is why they get implemented correctly. The
diagnosis is placement, not quality:

- `Touchpoints` exists but inconsistently: #176 has an excellent explicit file list; #182 has none
  despite naming six files inside its prose, so an agent must read the argument to find them.
- Evidence dominates. #179 spends most of its budget establishing *that* the log records no outcomes
  (7266-event probe, theme table, fixture excerpts). One sentence plus a research link carries the
  same weight for an implementer.
- `Notes` is a catch-all mixing out-of-scope rulings (load-bearing → `Constraints`), sibling findings
  (→ a new issue), and history (→ comment or spec).
- #155's three superseded approaches are ~40% of its body and are pure layer 3.

## 9. Worked example — #182 re-layered

Same information, three artifacts instead of one. Body drops from ~1,200 to ~300 tokens; nothing is
lost, and the analysis survives the issue closing.

**Issue body (layer 2):**

> **fix(recall): make KNN scope-aware**
>
> **Outcome:** the vector channel pre-filters by scope instead of post-filtering a global top-50, so
> per-project vector recall no longer depends on corpus size.
> **Why:** hybrid search exists because BM25 is blind across the bilingual vault; post-filtering
> removes exactly that capability, silently and monotonically, while the trace still reports
> `embedding: "ok"`.
>
> **Touchpoints:** `src/recall/query.ts:16,60-68,189-197` · `src/index/indexer.ts:85` ·
> `src/index/schema.ts:3`
>
> **Constraints**
> - §6 scope rule holds: project match **or** explicit global scope.
> - Raising `KNN_FETCH` is not the fix; `k = COUNT(*)` violates §4 recall cost.
> - Partition-key vs metadata-column is the implementer's call — verify actual `sqlite-vec` 0.1.9
>   behaviour with a fixture before committing (§6: fixtures decide). Analysis:
>   `docs/research/knn-scope-prefilter.md`.
> - Index is derived (§4): bump `INDEX_SCHEMA_VERSION`, no migration.
>
> **Success signals**
> - Fixture seeding > `KNN_FETCH` notes across ≥2 projects, target note's global rank worse than `k`
>   and in-scope rank 1, is returned by a scoped recall — **and this test fails on `main`**.
> - A global-scope query still reaches `is_global` notes.
> - Existing negative recall fixtures (§9) stay green with vectors on.
> - A pre-existing v5 index triggers rebuild, not an error.
> - `npm run build && npm test && npm run lint` green.
>
> **Context:** spec §5 search ruling, §6 · `docs/research/knn-scope-prefilter.md`

**`docs/research/knn-scope-prefilter.md` (layer 3):** the degradation table, the two candidate
schemas with tradeoffs, why the trace can't currently express "KNN ran, nothing in scope".

**Two new issues** (were buried in `Notes`): the diagnostics gap for scope-starved KNN, and the
`buildSearchText` dilution finding. Both were already flagged as separable; as issues they are
schedulable, and neither shares a touchpoint with the fix — so all three can run in parallel.

## 10. Delivery plan

Ordered, each step small enough to be its own issue. Steps 1–2 are parallel-safe (disjoint
touchpoints); 3 depends on 1; 4 depends on 1.

1. **`.github/ISSUE_TEMPLATE/task.yml` + `story.yml`** — forms encoding §5's field set and order, with
   the budget stated in each field's description and the mandatory fields marked required. Epics stay
   template-free (label + sub-issues; there is nothing for an agent to execute).
   *Success signal:* opening a new issue from the web UI yields the field set in order; a
   `github/issue-parser` run over the rendered body produces keys `outcome`, `why`, `touchpoints`,
   `constraints`, `success_signals`, `context`.
2. **`docs/research/` landing spots for the open backlog's inline analysis** — extract from #175,
   #179, #182, #155 as each is picked up, not in a big bang.
   *Success signal:* each touched issue's body is under budget and links its research doc.
3. **`AGENTS.md` authoring contract (~150 tokens)** — the field list, the budget, the split rule, the
   disjointness rule. This is the enforcement surface for the *agent* authoring path: forms only
   prefill the web UI and constrain nothing created through the API, which is how most of these
   issues are actually written.
   *Success signal:* an agent asked to open an issue with no further instruction produces the shape.
4. **Spec §14 amendment** — record the decision and its why-nots (§11) under "Backlog execution:
   agents", which already says tasks are written for a fresh-session agent and already mandates a
   spec pointer, a do-not-relitigate header, and a runnable done-check. This tightens that entry
   rather than adding a new one.
5. **Deferred, with a trigger:** a CI check validating required fields on issue open. Trigger: the
   first issue that reaches an agent with an empty `Touchpoints`. Not now — one enforcement mechanism
   at a time, and the AGENTS.md contract is untested.

## 11. Why-nots

- **A YAML form alone.** Forms don't constrain API-created issues, and that is the dominant path here.
  Hence step 3; the form is documentation-with-teeth for the human path, not the enforcement.
- **One template for all three types.** An epic has no touchpoints and no success signals of its own;
  forcing the fields would produce filler, and filler is what the agent then has to read past.
- **`<details>` blocks to "hide" the deep analysis.** Zero token saving for an agent; it hides the
  problem from the human reviewer instead of fixing it.
- **Pushing shared context up into the story to avoid repetition.** Breaks single-issue autonomy
  (§7), which is the property that makes parallel dispatch possible.
- **A machine-readable frontmatter block or JSON sidecar in the body.** Issue forms already give
  stable slugified headings; a second format is a parser to maintain for no gain.
- **Prescriptive step lists as a "safety" measure.** Empirically counterproductive (§3) — they get
  ignored or followed literally, and both degrade the result.
- **Shortening the issues by simply deleting the analysis.** The analysis is why this backlog lands
  correctly. Re-layer it; don't burn it.

## 12. Success signals for the template itself

The template is a change to the process, so it needs the same bar the issues do:

- An agent working a new-shape issue makes its first edit **without a repo-wide search**. If it has
  to search, `Touchpoints` failed.
- New task bodies are under 400 tokens; new story bodies under 700.
- Every new task names ≥1 success signal that fails before the work.
- Two sibling tasks dispatched simultaneously produce PRs that merge without a conflict — the
  disjointness rule paying out.
- Zero new issues carry a code excerpt over 5 lines, an evidence table, or superseded-approach
  history in the body.
- Nothing regresses: PRs from new-shape issues still pass review on the first or second round.

## Sources

- [Best practices for using GitHub Copilot to work on tasks — GitHub Docs](https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/best-practices-for-using-copilot-to-work-on-tasks)
- [Assigning and completing issues with coding agent — The GitHub Blog](https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/)
- [Introducing sub-issues — The GitHub Blog](https://github.blog/engineering/architecture-optimization/introducing-sub-issues-enhancing-issue-management-on-github/)
- [Syntax for issue forms — GitHub Docs](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)
- [github/issue-parser](https://github.com/github/issue-parser)
- [Agent Skills overview (progressive disclosure) — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [How to write a good spec for AI agents — Addy Osmani](https://addyosmani.com/blog/good-spec/)
- [AI Spec Template: What to Include and Leave Out — Augment Code](https://www.augmentcode.com/guides/ai-spec-template)
- [AI Agent Loop Token Costs: How to Constrain Context — Augment Code](https://www.augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints)
- [Context Engineering: Agent Reliability Playbook 2026 — Digital Applied](https://www.digitalapplied.com/blog/context-engineering-agent-reliability-playbook-2026)
- [How to optimize token efficiency in agentic systems — Glean](https://www.glean.com/perspectives/how-to-optimize-token-efficiency-in-agentic-systems)
- [Agentic Coding in Production: What SWE-bench Scores Don't Tell You](https://tianpan.co/blog/2026-04-09-agentic-coding-production-swebench-gap)
- [SWE-EVO: Benchmarking Coding Agents in Long-Horizon Software Evolution](https://arxiv.org/html/2512.18470v6)
- [Agentic-Agile: Why Agent Development Needs Agile — Microsoft for Developers](https://developer.microsoft.com/blog/agentic-agile-why-agent-development-needs-agile-not-just-prompts/)
- [microsoft/agentic-agile-template](https://github.com/microsoft/agentic-agile-template)
- [Agent-Ready Issue Templates — Kinde](https://kinde.com/learn/ai-for-software-engineering/ai-agents/agent-ready-issue-templates-write-work-the-agent-can-finish/)
- [Git Worktree Isolation Patterns for Parallel AI Agent Development — Zylos](https://zylos.ai/research/2026-02-22-git-worktree-parallel-ai-development/)
- [Break It Small, Ship It Right — Skills for Coding Agents — CyberAgent](https://developers.cyberagent.co.jp/blog/archives/63674/)
- [Best practices for Claude Code — Claude Code Docs](https://code.claude.com/docs/en/best-practices)
