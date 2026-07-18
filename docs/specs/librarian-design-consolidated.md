# Librarian — Consolidated Design Handoff (v4)

**Date:** 2026-07-05. **Status:** design converged after eight review rounds (Claude Fable 5 ↔ GPT-5.5 ↔ Claude Opus 4.8 research ↔ author challenges), plus a process-consolidation pass closing the seven remaining implementation-mechanics decisions (§14). This document supersedes v3 (2026-07-04) and is standalone: a fresh session needs no prior context. Live roadmap status (epics, stories, dependencies) lives in GitHub and the Project board, not this document; §12 keeps only the sequencing rationale.

**Amendments since v4 (2026-07-09/10, two research rounds — agent-memory literature via Semantic Scholar, plus Anthropic's global-workspace interpretability paper):**
- **§12 item 12 added** — memory correctness & maintenance (knowledge-update fixture, bi-temporal invalidation, outcome-linked note worth, novelty gate, per-type TTL; then 6–8: distiller faithfulness verification, per-type recency half-lives, within-block contradiction check).
- **§6 amended** — injected framing/authority labels demoted from guard to *prior*; poisoning defense assigned to admission control; injection-contract claims now require behavioral fixtures; the 0–5 cap gained a mechanistic endorsement (workspace capacity bottleneck).
- **§5 amended** — gated admission pipeline settled for the LLM distiller (novelty gate → faithfulness verify; verifier vetoes-never-edits; rejections fail closed and advance the cursor; human distiller and deterministic-ID revisions carved out). Mechanism for roadmap items 12.4/12.6.
- **§12.5 amended (2026-07-11)** — corroboration extends TTL: novelty-gate duplicates count as citations that reset the TTL clock, with a self-citation guard and a `note_corroboration` note-log record; retrieval counts are explicitly not citations.
- **§5/§12 amended (2026-07-12)** — worth-remembering judgment added as gate zero of the admission pipeline: enumerated worth criteria + an explicit NOOP decline in the distill prompt (§12 item 12.9 → issue #88). From a memory-extraction prompt research round (mem0/LangMem/Letta/A-MEM verbatim prompt survey, A-MAC admission ablation, SAGE write-gating, HaluMem). Vacuity is the one admission failure none of 12.4/12.6 catches — a vacuous note is novel, faithful, and (worse) corroborated by the next mechanical session.
- **§8/§12 amended (2026-07-12, second) — self-evaluation added:** two roadmap sub-items close the observe-and-correct loop the continual-learning framing implies. 12.10 `librarian stats` (issue #90): join the two diagnostics streams (distill verdicts × injection traces) into the operator report that answers the tuning questions — noop rate (12.9's measuring instrument), duplicate-rate trend, dead-note ratio, cut-reason mix. 12.11 injected-note contradiction detection (issue #91): the negative twin of 12.5's corroboration — a distill-time check of whether a session's events contradicted a note injected into it, landing as a 12.2 invalidation record. Retrieval canaries and an explicit `flag_note` feedback tool are recorded as trigger-gated later improvements, not built now.

**Amendments since v4 (2026-07-15/16 — comparative code review vs claude-mem v13.11.0, semantic-search ruling, issue-triage session):**
- **§4 amended** — a third storage class named (**derived artifacts**, rebuildable); the one blessed index becomes a persistent on-disk artifact (`~/.librarian/index/notes.db`); hot-path contract added (an injection performs zero index builds and zero full-log reads). Implementation plan: `docs/plans/persistent-db.md`. → issue #98.
- **§5 amended** — **BM25-only v1 ruling superseded:** semantic search (sqlite-vec + embeddings) is MVP scope, not trigger-gated; reason recorded inline (bilingual vault — BM25 is structurally blind across languages). User-declared privacy tag (`<private>`) and **memory-echo guard** added to the redaction pipeline (→ #101). Novelty-gate ruling: embeddings fetch candidates, never decide verdicts. Mode-system adoption declined (ruling on the per-origin-profiles deferral). **Human revisions** added: the human may revise any note by explicit ID (`note edit`, → #107); curated/generated split reaffirmed against inline ownership tags.
- **§6 amended** — scoring config actually loaded from `config.json` (closes the vacuous `config_snapshot` gap, → #99); hybrid scoring shape settled (BM25 + exact KNN → RRF → existing weights/floor pipeline, digest-stamped); pull path gains the 3-layer token-efficiency shape (→ #100).
- **§12 amended** — items 13 (hot-path & wiring hardening, #98–#101) and 14 (semantic search MVP, #102–#105) added and jump the remaining item-12 queue. Item-12 remainder triaged: 12.3 (#81) **closed**, replaced by explicit `flag_note` (12.12 → #106); 12.8 (#82) **closed** (the detector doesn't detect disagreement); 12.5-corroboration (#80) **parked** behind a stats trigger; 12.11 (#91) kept, decoupled from #80/#81, sequenced after 14.4. 12.13 `note edit` added (→ #107).
- **§15 amended** — re-ranking demoted behind hybrid (reverses the v2 ordering); the vector-search trigger bullet superseded outright (MVP scope, §5); rejected claude-mem features recorded (resident worker, viewer UI, teams schema, second store, inline ownership tags, mode system now); in-process ONNX embedding provider recorded as deferred alternative (research: #97).

**Amendment since v4 (2026-07-17 — in-flow correction session):**
- **§5/§12 amended** — agent-mediated human revisions ruled in: an MCP `revise_note(note_id, body)` tool may mint a `distiller: "human"` revision when the user explicitly approved the verbatim body — **identity follows the judgment, not the keyboard**. The mediating channel is recorded in `source.agent`; the approval requirement in the tool contract is a prior (§6 epistemics), the structural defenses are provenance distinguishability and append-only recoverability. Closes the active half of the in-flow correction loop ("why did the plan assume X?" → trace the injected note via its `injection_id` → correct it without leaving the session). → §12 item 12.14, issue #110.

**Changes since v3:**
- **§14 added** — the seven remaining decision areas (language/runtime, repo bootstrap, golden-example format, test convention, backlog execution model, config file location, dogfooding) are now settled and consolidated.
- Housekeeping (§11) gained the config-file path, cross-referencing §14.
- Open items renumbered §13 → §15; nothing in it changed.

**Changes since v2:**
- **Recall/injection contract settled** (§6) — graduated from open item after a dual review round (GPT-5.5 design review + Opus 4.8 literature research, ~40 sources): relevance floor with 0–5 injection (replaces inherited top-5), explicit authority ordering folded into the weights mechanism, tagged non-authoritative injected-block shape, stable-prefix/volatile-suffix layout, push-vs-pull contract split.
- **Provenance drill-down** added as an MCP tool (§6) — distilled notes supplement recoverable verbatim source; the payoff of collector-stamped provenance.
- **Prompt rendering decoupled from storage** (§7) — NDJSON stays; a renderer owns all LLM-facing serialization (indexed compact text, aggressive field elision); token efficiency is a renderer property, not a storage property.
- **Diagnostics log family** added (§8) — injection traces, distill verdicts, `librarian why`/`why-not`; structurally isolated from memory (separate root, poison-pill record class, hard-reject validators).
- Testing discipline extended (§9): negative recall fixtures, recall telemetry, diagnostics-rejection fixture.
- Literature endorsements recorded on existing register items (§5, inline).

**Author context:** experienced .NET/PHP developer, strong KISS philosophy — file-over-app, vendor-agnostic, minimal abstraction, deliberate coupling. Personal side project (learning + scratching an itch) with an open-source north star. Judge all future proposals against those values.

---

## 1. Vision

**Librarian is an open-source personal context layer that automatically provides the right parts of your knowledge to any AI assistant, so every conversation begins with what you already know instead of what you have to repeat.**

- The product is not memory and not search; it is **eliminating repetition**. Vendor memories (OpenAI, Anthropic, Google) belong to the vendor; Librarian belongs to the user. The assistants become replaceable; the memory does not.
- Mental model: SSH agent / Ollama / Git Credential Manager — infrastructure you install once and forget, not an application. Invisible by default.
- **Push vs pull (settled distinction):** *push* = prompt augmentation via per-agent injection adapters — the premium, invisible experience, available only where a hook point exists (OpenCode, Claude Code, plausibly Cursor/Aider). *Pull* = an MCP server — the universal floor: one implementation serves ChatGPT, Claude.ai, Gemini, and any MCP-speaking agent, but is on-demand and model-initiated. Both are first-class; MCP is what delivers the cross-vendor promise. **The two paths have different injection physics (§6).**
- **Write-side asymmetry (stated honestly):** Librarian is readable everywhere (via MCP) but learns only from instrumented surfaces and from the human. Vendor chat products expose no hooks; conclusions from those surfaces enter via curated notes, not transcripts.
- **Invisible by default, glass-box on demand:** vendor memory is invisible *and* uninspectable *and* uneditable — that is its weakness. Librarian is plain markdown and NDJSON you can read, correct, author, and veto. The mechanism behind the glass is now concrete: provenance on every note, provenance and freshness in every injected block, an `injection_id` on every injection, and `librarian why` / `why-not` (§8). Librarian's angle vs. existing OSS memory layers (mem0/OpenMemory, Zep, Letta): file-over-app, Obsidian-native, coding-agent-first, human-curatable.
- **Recall precision is the product surface.** Under invisible injection, wrong context is worse than no context. Research round (§6) confirmed: a single near-miss distractor measurably hurts; injection quality is measured from the first real session via the diagnostics log.
- Scope decision: build the personal tool on this roadmap; treat the vision as the README's north star. The MCP server is the bridge to the bigger story.

## 2. What Librarian is, technically

A personal memory system for AI coding agents (and, via integrations, other sources), redesigned from [SuperBrain](https://github.com/m3talux/superbrain) (v0.11.0, source verified at commit `571a738`) into an explicit, composable pipeline inspired by OpenTelemetry concepts — plus a domain core ("the Librarian": distill + recall) that OTel has no analog for, because telemetry is write-only and memory is a loop.

**Goals:**
- Add a new agent (Claude Code, OpenCode, Codex) = write a thin instrumentation adapter.
- Add a new content source = emit events; the distiller does the rest (integration contract, §5).
- Swap the distillation LLM (`claude -p` → `opencode run` → local Ollama/llama.cpp endpoint) = swap an inference provider. A 100%-local, open-source-only configuration must be possible.
- Obsidian remains the human-facing view, but is no longer the canonical storage.
- Conscious ground-up rebuild (abandons the earlier "vendor parity modules from upstream SuperBrain" strategy; upstream bug-fix flow is knowingly lost).

**Prior working assets:** an OpenCode plugin that writes events into SuperBrain's NDJSON format (verified end-to-end via SuperBrain's orphan sweep), and a fully researched OpenCode recall-injection design (two-phase hook: compute on `chat.message`, splice ephemeral tagged part on `experimental.chat.messages.transform`, open-thread pointers on `experimental.session.compacting`; avoid `system.transform`).

## 3. Relevant SuperBrain facts (for reference)

- Write path: agent hooks (no LLM) → NDJSON per session → deterministic salience markers → checkpoint hooks acquire lockfile, spawn **detached** `sb-distill` child (lock token passed via env; child releases) → `claude -p` over event delta (byte cursor per session) → notes routed into Obsidian vault → `indexNote()` per note.
- `claude -p` usage is pure completion: prompt in, text out, no tool loop.
- Recall: SQLite FTS5 BM25 + sqlite-vec hybrid, RRF fusion, project/global boost, recency decay `exp(-ageDays/90)`, fail-closed on untagged notes. Injection: session-start digest, per-prompt top-5 (~500 tok), 10-turn mini-brief, MCP search server (`sb-mcp` — precedent for the pull path).
- Distill-skip heuristic: sessions with 0 salience markers, 0 write tools, <2 prompts, <10 events are skipped.
- Known SuperBrain bug class being fixed: project slug derived late from `cwd` at distill time ⇒ silent degradation to global-only recall when wrong.

## 4. Architecture (settled)

**Two append-only domain logs plus one diagnostics log family; independent cursor-tracking consumers; event-driven eventual consistency:**

1. **Event log** — canonical, normalized, **redacted-before-append** telemetry from instrumentations and integrations. NDJSON per session. Source of truth for raw activity. Sacred: append-only, replayable, never deleted.
2. **Note log** — structured memory records. Written **only by distillers** (§5). The LLM distiller is a consumer of the event log; the indexer and all exporters are independent consumers of the note log. Sacred, same guarantees.
3. **Diagnostics log** (§8) — injection traces, distill verdicts, quarantine events. Same NDJSON/cursor machinery, **structurally isolated from memory**: separate root, freely deletable, never ingested, never rendered into the vault.

**Three storage classes (the third named 2026-07-16):**
1. **Sacred logs** (`~/.librarian/data/`) — append-only, replayable, never deleted.
2. **Diagnostics** (`~/.librarian/diagnostics/`) — deletable, never ingested (§8).
3. **Derived artifacts** (`~/.librarian/index/`) — rebuildable from the sacred logs at any time; deletion is safe and self-healing (the next indexer run rebuilds from cursor zero). First member: the persistent index `index/notes.db` (SQLite: FTS5 + vec0 per §12 item 14). The vault's `generated/` tree is retroactively recognized as this class — the invariant was always "regenerable, exporter-owned"; it now has a name. Deletability is a **directory property**, not a filename convention (structural invariants beat policy invariants): `rm -rf ~/.librarian` still removes everything (§14), and `rm -rf ~/.librarian/index` is a documented safe recovery action.

**Hot-path contract (structural, testable — 2026-07-16):** an injection performs **zero index builds and zero full-log reads**; its cost is O(query), never O(vault). This is the no-daemon principle's other half: no resident process *and* no per-invocation rebuild tax. The indexer is a true incremental cursor consumer writing `index/notes.db`; recall opens it read-only; a distill pass runs indexer catch-up before the novelty gate so admission never judges against a stale view. The fixture asserts structure (no rebuild occurred), never wall-clock time (§8: timings stay out of diagnostics). Implementation plan: `docs/plans/persistent-db.md` (→ #98).

**Core principles (the design's spine):**
- Durable memory records are the domain layer; Obsidian pages are a rendered view or a curated input — never the canonical model.
- **The note log's contract: everything in it was judged worth remembering, by a named judge (`distiller`), from a named origin (`origin`).** The vault, the index, and recall are downstream conveniences of that one guarantee.
- **Structural invariants beat policy invariants.** Where a rule matters, enforce it by construction (directory layout, record shape, validators), not by the good behavior of future code. Precedents: generated/curated split, distill-only narrow waist, diagnostics isolation.

**Component roles:**
- **Instrumentation** (per-agent, dumb): map native events → canonical schema, stamp Resource facts, emit cheap non-authoritative salience hints, append. Zero domain logic. **An integration is just an event emitter.**
- **Collector** (library + CLI, **no daemon**): normalize → redact → validate → append. Owns distill triggering (lazy, detached-child model). Owns authoritative salience and the distill-skip heuristic. Stamps note provenance mechanically. Owns the **prompt renderer** (§7). Hard-rejects `record_class: diagnostic` at the validate stage.
- **LLM distiller**: consumer of the event log via an inference provider; admission control for machine-produced content. Prompt selection keyed on origin (per-origin profiles; default profile for unconfigured origins).
- **Human distiller (curated-note importer)**: converts human-authored Markdown → note records directly. Never routes curated notes through the LLM. Hard-rejects diagnostic records.
- **Indexer**: incremental cursor consumer of the note log, writing the persistent index `~/.librarian/index/notes.db` (FTS5 BM25 + vec0 per §12 item 14); derives `search_text` by fixed concatenation rule; indexes `origin` as a filterable column; fail-closed: records missing `origin` are excluded.
- **Exporters**: note-log consumers; idempotent by `note_id`; may filter by origin (per-source vault views = exporter configuration). Obsidian exporter first, SQLite mirror second. **Never render diagnostics into the vault.**
- **Recall**: BM25 query + deterministic scoring (project/global boost, recency decay, per-origin × per-note-type weights, relevance floor), read-only DB access; writes an injection trace per injection; feeds push adapters and the MCP server.
- **`librarian drain`**: CLI command that processes everything pending. The manual recovery and debug tool; more important than any daemon.

## 5. Decisions register (all settled — do not relitigate without new information)

Items marked **[endorsed]** were independently validated by the 2026-07-04 literature-research round (Lost in the Middle / Context Rot / Power of Noise / LongMemEval lineage; details in `docs/reviews/librarian-design-consolidated-opus48.md`).

**Identity & revisions**
- `note_id` = stable logical identity; `revision_id` = immutable version (ULID). `event_id` also ULID.
- Snapshot revisions, latest-revision-wins by `note_id`. No event-sourced note internals, no diff/patch format.
- **V1 revision rule:** only deterministic-ID notes may be revised (`project:{slug}:summary`, `person:{normalized_name}`, `daily:{yyyy-mm-dd}`, `curated:{id}`). The distiller may fetch a prior revision **only by deterministic ID** — never search for "probably related" notes and mutate them. Everything else is episodic: `{type}:{ulid}`, one revision, immutable forever. Semantic consolidation deferred (it is the entity-resolution problem).
- Tombstones exist in the schema from day one; v1 emitters are CLI/human actions only, never the distiller.
- **Human revisions (2026-07-16 → #107):** the human may revise **any** note by explicit `note_id` — `librarian note edit <note_id>` opens the body in `$EDITOR` and appends a new revision with the same `note_id`, `previous_revision_id` set, `distiller: "human"`, origin unchanged; latest-wins does the rest. The v1 revision rule above constrains the **LLM** distiller (never search-and-mutate); the human revising by explicit ID is the same authority that can already tombstone anything. A `distiller: "human"` revision is exempt from faithfulness-vs-events checks (12.6, 12.11) — the human's edit *is* the source, the same carve-out this section already makes for the human distiller.
- **Agent-mediated human revisions (2026-07-17 → #110):** the human-revision authority above extends to one more serialization mechanism — an MCP `revise_note(note_id, body)` tool, so the in-flow correction loop ("why did the plan assume X?" → trace the injected note → "that's wrong, it should be Y") can land a correction without leaving the session. The ruling: **distiller identity follows the judgment, not the keyboard.** A revision whose verbatim body the user explicitly approved is the human distiller acting through the agent, exactly as the curated-note importer and `note edit` are serialization mechanisms for the same authority: `distiller: "human"`, origin unchanged, `previous_revision_id` set, latest-wins does the rest, same faithfulness exemption (the approved text *is* the source). Disciplines: (a) **explicit `note_id` only** — the search that located the note is ordinary pull-path recall; the revision call itself never searches, so the v1 rule above ("the LLM never search-and-mutates") is untouched; (b) the tool contract requires the agent to display the verbatim proposed body and obtain explicit approval before calling — per §6 epistemics this wording is a **prior, not a guard**: nothing structural stops a misbehaving agent from claiming approval; (c) the honest defenses are therefore structural and auditable — the revision's `source.agent` records the mediating channel (terminal `note edit` leaves it unset), so agent-mediated revisions are always distinguishable under `note show --with-provenance`, and the append-only note log means a bad revision destroys nothing: one more revision (or a flag, 12.12) recovers. If the channel proves unreliable in practice, the response is per-channel — gate or drop the tool — never a schema change. Neighbors: `flag_note` (12.12) kills a wrong note, `revise_note` replaces its content, 12.11 remains the passive net for corrections the user voices but nobody lands.

**Ingestion: distill-only, two distillers**
- **Nothing enters the note log without a distiller's judgment. There are exactly two distillers: `llm` and `human`.** No generic import path; machine-produced content — however pre-condensed — passes through the LLM distiller. The distiller is **admission control**, not compression: one writer discipline, one quality gate, one narrow waist. **[endorsed** — distill-skip gating means fewer low-signal notes = fewer future distractors**]**
- The curated-note importer is the human distiller's serialization mechanism, not an import facility. It preserves the human Markdown body verbatim (`body.details`), no LLM normalization. **[endorsed** — verbatim beats LLM-normalized; this is a correctness feature, not just fidelity**]**
- **Re-distill invariant:** idempotency is by provenance, not content: a re-distill of an already-provenanced event range is a bug. Cursor advance-after-success plus this invariant = exactly-once-ish. Nasty-path fixture required.
- Diagnostic insights enter memory only via a curated note (human distiller). The raw traces never do — no distiller with authority over them exists, and none should (§8).
- **Gated admission pipeline (amended 2026-07-10 — design for roadmap items 12.4/12.6; order and stances settled now so implementation doesn't relitigate):**
  ```
  skip heuristic → render → LLM judgment (may decline → NOOP)  [12.9]
    → schema validation
    → novelty gate (BM25 query, episodic only)         [12.4]
    → faithfulness verify (LLM verdict, one feedback re-distill)  [12.6]
    → stamp identity/provenance → append → advance cursor
  ```
  - **Cheap gate before expensive gate:** novelty is a millisecond BM25 query against the existing index; never pay a verify call for a note that would be discarded as a duplicate.
  - **Embeddings fetch candidates, never decide verdicts (2026-07-16):** embedding models score contradictions as highly similar ("we chose Kamal" / "we abandoned Kamal" are near neighbors — same topic, opposite fact), so a cosine-threshold NOOP would silently eat exactly the knowledge-update notes 12.1 protects. Hybrid retrieval may *widen the novelty gate's candidate fetch* (pure win); the duplicate verdict itself keeps the deterministic BM25 rule — never decided by similarity score alone. The 12.1 knowledge-update fixture must be green *with embeddings enabled* before hybrid candidate fetch ships (#104).
  - **The distiller may decline (amended 2026-07-12, item 12.9):** the judgment prompt carries enumerated worth criteria and an explicit NOOP (`note_type: "none"` + reason) — the cheapest gate of all, running inside the LLM call already being paid for. A decline fails closed like every other rejection (no note, `noop` verdict to diagnostics, cursor advances) and bypasses the novelty gate and verify — nothing to check. A decline on the one feedback re-distill is legitimate, not a failure.
  - **The verifier vetoes, never edits.** A verifier that could "fix" the note would be a second unverified writer. Its only outputs are a verdict and a reason; the one concession is a single re-distill with the reason fed back into the distill prompt — the distiller remains the sole writer.
  - **Every rejection fails closed and advances the cursor:** no note, verdict record to the diagnostics log (distill-verdict machinery), events stay in the sacred event log for manual re-distill via `librarian drain`. Losing a session's note is acceptable; a wrong note injected invisibly later is not — the write-side twin of §6's "empty slot beats a distractor."
  - **Gates bind the LLM distiller only.** The human distiller bypasses both: faithfulness-vs-source is meaningless when the human's markdown *is* the source (preserved verbatim by design), and a novelty gate on human notes would let the machine overrule the person. Deterministic-ID revisions get the faithfulness verify but skip the novelty gate — revisions are *supposed* to overlap their prior.
  - The verify pass may use a cheaper model. It reduces error classes, it does not eliminate them — the audit trail (provenance drill-down, `librarian why`) remains the backstop for what slips through.

**Source identity**
- Two independent dimensions: **origin** (*where*: `opencode`, `claude-code`, `human`, `email`, … — open string vocabulary, mandatory, denormalized at distill time, indexed, fail-closed if missing) and **distiller** (*who judged it in*: `llm` | `human`).
- Note `source` field: `{ origin: string; distiller: "llm" | "human"; model?: string; agent?: string; source_path?: string; content_hash?: string }`.

**Sources are decoupled from recall**
- Write side and read side share no contract. A source may exist purely to enrich memory (event emitter only) with no injection adapter — and vice versa. Per-source vault views = exporter filters; per-source recall = query filters + weights.

**Resource & salience**
- Instrumentation stamps **facts**: `agent`, `agent_version`, `machine_id`, `cwd`, `git_root`, `git_remote`, `git_branch`. Authoritative `project_slug` is derived deterministically at distill/index time and cached in note `scope`.
- Instrumentation may emit `hints: { possibly_salient?, reason? }` — non-authoritative. Canonical salience lives in the collector/distiller.

**Search & index**
- BM25-over-SQLite-FTS5 is the one blessed index. No recall provider abstraction. Schema must not block later vector search, but nothing more. **[endorsed** — BM25-only v1 is pragmatic; lexical retrieval also has an inherently milder distractor profile than dense retrieval**]**
  - **Superseded in part (2026-07-16): semantic search is MVP scope, not trigger-gated.** The original ruling was settled against a POC framing and an English-monolingual assumption; the vault is bilingual (Swedish/English) and BM25 is structurally blind across languages — a Swedish query can never lexically match an English note, so cross-language misses are a guaranteed recurring class in this user's data, not a paraphrase-shaped edge case awaiting a trigger fixture. Secondary rationale: capability parity with the field at near-zero operational cost given the one-derived-store architecture. **What survives of the old ruling:** BM25 remains the always-on floor; embeddings are additive; zero-config = BM25-only (embeddings make it better, never make it broken); "one blessed index" still holds — vectors live in the same SQLite file as FTS5 or not at all (a second store buys a sync subsystem, refused). Mechanism in §6 (hybrid scoring shape) and §12 item 14 (#102–#105).
  - **Embedding default (2026-07-18, #102):** `qwen3-embedding:0.6b` through Ollama's OpenAI-compatible `/v1/embeddings` endpoint. It is small and multilingual, matching the Swedish/English vault without making a model download part of zero-config operation. The index records Ollama's immutable digest alongside the model name; a changed digest requires deleting and rebuilding the disposable index rather than comparing incomparable vectors.
- `search_text` is indexer-derived (fixed concatenation rule over title/summary/bullets/details/scope/links), never a record field.
- Recency decay `exp(-ageDays/90)`, computed in code, half-life tunable. **[endorsed** — simple deterministic recency prior; freshness/conflict resolution must not be LLM-reasoned**]**
- **First search upgrade, trigger-gated:** if negative fixtures show distractor injections despite the relevance floor → add a re-ranking pass. Re-ranking before vector search. Named trigger, not a roadmap item. **Superseded (2026-07-16):** ordering reversed — hybrid ships first (MVP, above), re-ranking is demoted to the escalation (§15).

**Durability & safety**
- Redaction **before durable append** — non-retrofittable (secrets in an append-only replayable log are immortal). Pipeline: native event → normalize → redact → validate → append. Redaction preserves correlation without the secret: `[REDACTED:token:sha256:abc123]`. Applies to prompts as well as commands. **[endorsed]**
- **User-declared privacy (2026-07-15/16 → #101):** spans wrapped in `<private>…</private>` in prompt text are removed at the collector's redact stage, before durable append — same non-retrofittable rule as secret redaction, different threat model (declared intent vs. pattern detection; complements, not alternatives). Replacement is `[PRIVATE]` with **no hash**: unlike tokens, private content gets no correlation affordance — the user asked for it to not exist. Renderer-side stripping is not the mechanism; the append-time strip is the guarantee.
- **Memory-echo guard (2026-07-15/16 → #101):** `<librarian-memory>…</librarian-memory>` blocks are stripped from prompt events before append. Without this, push-path injection re-enters the event log as prompt content, gets distilled, and memory begins citing itself — the §8 reflexive loop through the front door. Structural, collector-owned, fixture-backed.
- Cursors: `{consumer, log_name, file_path, byte_offset, last_record_id?, updated_at}`; advance only after successful processing. Bounded retries; poison records quarantined with debug context (quarantine verdicts → diagnostics log); partial trailing JSON lines ignored until completed.
- Detached workers: explicit lock ownership, stale-lock recovery (PID/token checks, timeout).
- `schema_version` on every event and note record. Log compaction deferred but defined: consumers read canonical logs; compaction must preserve replay semantics.

**Human curation**
- Vault split: `vault/generated/**` (exporter-owned, deterministic paths, `librarian_generated: true` frontmatter + `<!-- librarian:generated; do not edit -->`, overwritten freely) vs `vault/curated/**` (human-owned, ingested by the human distiller, `origin: "human"`).
- **Invariant:** generated files are excluded from curated ingestion (structural: directory split). No mixed-ownership regions inside one Markdown file. Ever.
- Curated frontmatter may declare an explicit `note_id` (path-hash fallback); importer detects renames via `content_hash` and tombstones the orphaned old ID.
- **Reaffirmed against the inline-tag alternative (2026-07-16):** claude-mem-style per-region ownership tags inside one exported file (marking parts of a generated note as curated/private) were considered and rejected. Mixed ownership per region buys a merge engine: when the underlying note gains a revision *and* the human edited the exported file, the exporter must parse, preserve, rewrite, and resolve overlapping regions — a two-way sync problem in disguise, degrading worst under Obsidian + file sync. The vault file is a *view*; editing a view is never durable. The friction the alternative was solving ("tweak one bullet of a distilled note") is served by human revisions (`note edit`, above) through the note log instead. Trigger to revisit: demand for editing *in Obsidian* specifically — and even then the shape is "vault edit detected → prompt to convert into a human revision," never silent region merging.

**Storage format & prompt rendering (settled 2026-07-04; supersedes nothing — names what was implicit)**
- **NDJSON stays for all logs. Prompt serialization is a rendering concern, fully decoupled from storage.** Token efficiency is a property of the renderer's output, not of files on disk; the LLM never reads a log file verbatim. See §7.

**Deleted / deferred (over-engineering guardrail)**
- Generic `Librarian` interface → concrete functions. Generic storage layer; exporter plugin system (one interface: `exportNoteRevision(record)`). Generic import path. Inference-provider schema-negotiation sophistication (completion + JSON-schema + validate + one retry). Qualification *frameworks* → fixtures (§9). Distiller-driven tombstones; episodic consolidation; daemon.
- **`ContentEvent` + per-origin distiller profiles:** rule settled (they are the integration contract for non-agent sources); mechanism deferred until the first concrete non-agent source. **Mode-system adoption declined (2026-07-16):** claude-mem's mode system (user-declared context selecting a typed observation vocabulary + extraction prompt, localizable, file-defined) was reviewed and skipped. Librarian already has both halves automatically — the note-type vocabulary *is* the typed observation vocabulary, and the 12.9 worth criteria *are* the extraction prompt; the missing piece is the user-declared switch, which contradicts the low-friction/automatic goal. Modes earn their keep when a genuinely different context arrives (an email source shouldn't be distilled with a coding-session vocabulary) — that is this trigger, unchanged. If distill output quality feels off before then, that is prompt tuning on the one prompt, measured by the qualification fixtures and the noop/duplicate rates in `librarian stats`. claude-mem's mode-file shape remains the design to study when the trigger fires.
- **OTLP export and timing/latency spans:** deferred, named trigger = actually wanting spans in an external backend / something feeling slow. The diagnostics log is the API; a converter is a page of code.
- Compressed log segments (gzip closed months): deferred until size-on-disk matters; changes nothing for consumers.

**Closed/parked correctness mechanisms (2026-07-16 triage — do not relitigate without the named trigger)**
- **12.3 outcome-linked note worth — closed.** No flowing, note-granular outcome signal exists to calibrate against: `user_pushback` is emitted by neither adapter, session-level pushback cannot name *which* note was wrong, the demotion constants are uncalibratable with no signal, and ranking derived from deletable diagnostics makes recall depend on telemetry retention. Replaced by explicit `flag_note` (12.12). **Do not reopen a worth-multiplier design without a real, flowing, note-granular outcome signal to calibrate against.**
- **12.8 within-block contradiction check — closed.** Lexical overlap detects "same subject," not "conflicting claims"; it would silently drop compatible notes on the push path (a distractor mechanism of its own) and is a no-op now that supersession (12.2) and the open-validity filter exist. The residual unmarked-conflict case folds into 12.11, which has real claims and events to judge.
- **12.5 corroboration-extends-TTL — parked** behind a stats trigger: the complexity (new record kind, session-id plumbing, self-citation join, indexer column, TTL seam change) outweighs the value until measured. Reopen when `librarian stats` shows duplicate NOOPs against near-TTL-expiry notes at a meaningful rate; first response is the lazy novelty-gate variant (admit the duplicate when the matched note is near expiry — fresh note, fresh clock), not the original design.


## 6. Recall & injection contract (settled — graduated from open item)

**Scoring (deterministic, in code):** BM25 → RRF-style fusion where applicable → project/global boost → recency decay → **weights** `score × f(origin) × f(note_type)` (one mechanism, two dimensions; config map, e.g. `{ human: 1.5, opencode: 1.0, email: 0.6 }` × `{ curated: 1.4, decision: 1.2, project_summary: 1.0, fact: 0.9, daily: 0.7, episode: 0.7 }`) → **relevance floor**.

**Config-in-force (2026-07-16 → #99):** `originWeights`, `typeWeights`, `relevanceFloor`, per-type `recencyHalfLifeDays`, per-type `ttlDays`, and `projectBoost` load from `~/.librarian/config.json` at every recall entry point, defaulting per-key to the current constants when absent. The injection trace's `config_snapshot` records the **loaded** config, never the defaults constant. Fixture: change a weight → next trace's snapshot reflects it → `librarian why` replays with it. Until this lands, snapshots are vacuous and 12.10's tuning loop has no knob — which is why 13.2 precedes further item-12 work.

**Hybrid scoring shape (2026-07-16, mechanism settled → #104):** BM25 rank + exact KNN rank → RRF (the SuperBrain precedent, §3) → the existing weights/decay/floor pipeline. Exact brute-force KNN is a *feature* at note scale (thousands of rows, single-digit ms, zero ANN recall loss); the distill-only waist keeps N small by construction. Recall stays a deterministic pure function given the embedding-model digest; traces record both per-channel ranks + the digest, and an `embedding: "ok" | "timeout" | "error" | "disabled"` field records whether hybrid actually ran (time-boxed fail-soft: on timeout/error the injection ships BM25-only, the floor still applies, nothing is force-filled). **The relevance floor does not transfer automatically:** the current floor is a BM25-score threshold and RRF emits rank-scale scores — either per-channel floors before fusion or a re-derived fused floor, decided by whichever the negative fixture validates. "Hybrid must not resurrect below-floor distractors" is the acceptance test. Rollout is staged by injection physics (blast-radius order): pull path and novelty candidates first, push last, gated on the negative fixtures green with vectors on.

**Authority ordering (reflected in weights, injected wording, and tests):**
```
current workspace evidence
> explicit user instruction in current session
> curated memory
> deterministic project notes
> recent episodic notes
> old episodic notes
```
The first line is the poisoning guard: memory is always framed as subordinate to what the agent can see in the repo right now.

**Amendment (2026-07-10, workspace-interpretability round):** the injected framing and authority labels are a **prior, not a guard**. Mechanistic evidence (Anthropic's global-workspace/J-lens work, `transformer-circuits.pub/2026/workspace`): instruction-directed control over what a model holds in mind is real but leaky (~60% loading success on large models for explicit focus instructions — far stronger interventions than one standing preference line), and context properties can be fully *represented* internally without being *causally used* (models internally flagged prompt injections and fictional framing, then ignored them). Three consequences, folded into this contract:
- Poisoning defense lives at **admission** (distiller as narrow waist, redaction, distill-skip) — never credit the injected wording as the mitigation.
- Authority labels and freshness stamps are hypotheses; only behavioral fixtures (does the agent actually prefer the newer fact / defer to repo evidence?) count as evidence they work. Extends the §9 fixture discipline to the injection contract itself.
- Contradictions among shipped notes fail **silently and confidently** (workspace "ignition": ambiguity resolves sharply, not gradually) — the model commits to one side rather than hedging. See roadmap item 12.8.

**Push path (invisible injection — precision-first):**
- **0–5 records per prompt, never force-filled.** A low-relevance note filling a slot is a distractor; a distractor is worse than an empty slot. **[endorsed** — single-distractor harm is measured and monotonic; mechanistically reinforced 2026-07-10: flexible reasoning routes through a ~10–25-concept workspace bottleneck, so injected notes *compete* with the task for slots rather than adding for free — and injected context is most causally potent on exactly the flexible-reasoning tasks coding agents do, so wrong context costs more here than passive-QA benchmarks suggest**]** Relevance floor = BM25-score threshold, tuned against fixtures. Fail-closed extended from scope to relevance.
- Budget ~300–700 tokens per prompt (SuperBrain's ~500 confirmed in-range **[endorsed** — focused ~300-tok prompts beat 113k-tok full context on LongMemEval**]**). Do not grow the budget "to be safe."
- Require project match or explicit global scope.
- **Layout rule:** turn-1 brief + prefs ride the first user message and never mutate mid-session (stable prefix, cache-friendly); per-prompt recall splices adjacent to the latest user message (volatile suffix, pays full price by design). Top hit nearest the prompt.
- **Injected block shape** — tagged, provenance-bearing, freshness-bearing, non-authoritative, carrying its `injection_id`:

```markdown
<librarian-memory injection_id="01J..." indexed_through="notes/2026-07.ndjson:12345">
Possibly relevant prior context. Prefer current repository evidence and
current user instructions if they conflict.

1. [decision · curated · 2026-07-03 · high authority]
   The project favors KISS, file-over-app, minimal abstraction.
   src: curated:author-context

2. [project_summary · distilled · 2026-07-03 · medium authority]
   Librarian uses event logs as telemetry and note logs as canonical memory.
   src: session 01J…, events 01J…–01J…
</librarian-memory>
```

**Pull path (MCP — model-initiated, different physics):**
- The model *chose* to search: returning up to ~10 scored results with full metadata is appropriate. Origin/scope filters exposed as tool parameters. Austerity rules above are push-path rules; do not "fix" the MCP tool to obey them.
- **3-layer shape (2026-07-16, precedent: claude-mem's index→details workflow → #100):** (1) `search` returns a **compact index** — `note_id`, `note_type`, `title`, one-line summary, score, date, origin — cheap enough to return the full ~10 results without token guilt; (2) `get_notes(note_ids[])` returns full bodies for the IDs the model actually wants; (3) provenance drill-down (existing tool) remains the third layer: note → verbatim event excerpts. The push path is untouched — it ships rendered bodies (0–5, floor, budget) because the model cannot follow up mid-injection.
- **Provenance drill-down tool:** given a `note_id`, fetch the verbatim event excerpts behind it via collector-stamped provenance. Distilled notes are a *supplement to* recoverable verbatim source, not a replacement **[endorsed** — distillation pays a measured lossy-compression tax; supplement-not-replace recovers most verbatim performance at a fraction of the tokens**]**. Push stays notes-only; pull gets depth.

**Recall telemetry (right-sized: a debug log, computed from diagnostics traces — no second pipeline):** injected count and tokens, query + top-result metadata, whether memory was corrected by the user or contradicted by repo evidence, turns-to-goal. Measured from the walking skeleton onward.

## 7. Storage vs. prompt rendering

**The category rule: storage formats optimize for machines, humans, and replay; prompt formats optimize for signal-per-token. They meet only at the renderer.**

- All logs are NDJSON: self-describing, nested-structure-capable (events carry `resource`/`context`/`tool` objects), robust to payloads full of pipes/tabs/newlines (prompts, commands, code), `jq`/SQLite-JSON tooling, and the glass-box ownership story. JSON natively satisfies every schema-evolution rule worth having (named fields = tags; unknown-field tolerance; optional omission; `schema_version`).
- **The renderer** (collector-owned) produces all LLM-facing serializations and carries zero compatibility obligations — prompts are ephemeral and never parsed back. It optimizes by **field elision** (drop ULIDs, `machine_id`, `schema_version`; collapse timestamps; elide repeated `cwd`) — the real token win, and only legal at the prompt boundary. Distill prompts render events as indexed compact text (ordinal indexes are already required for collector-stamped provenance):

```
[1] 12:04 prompt "fix the login redirect bug, it loops on expired tokens"
[2] 12:05 write src/auth/session.ts
[4] 12:09 bash: git commit -m "fix: expire check before redirect"  ← salient:vcs_commit
```

- Injection rendering (§6) is the same principle on the read side: tagged markdown, never raw records.
- Per-task renderer shapes are free to diverge (e.g., an EAV-triple rendering *derived* for a future contradiction-detection task) — renderer outputs, never storage formats.

## 8. Diagnostics (self-observation, structurally isolated)

**Purpose:** answer "why did this memory surface" (and "why not," and "why wasn't this session remembered") — explainability of deterministic decisions, not OTel-style request tracing.

**What is logged (NDJSON, same append/cursor/segment machinery):**
- **Injection trace** per injection: `injection_id` (ULID — the same one threaded into the injected block), query, candidate `note_id`s with raw and post-weight scores, cut reasons (`below_floor` | `budget` | `scope_mismatch`), records shipped, `indexed_through`, and a **config snapshot or hash** of the weights/floor in force. The config stamp is day-one and non-retrofittable: traces without the policy-in-force become unexplainable the moment the config is tuned.
- **Distill verdicts:** skip reasons (salience gate, <2 prompts, …), quarantine events, retry exhaustion.
- **Not logged:** timings, latency spans, counters — retrofittable, currently useless (deferred, §5).

**CLI:**
- `librarian why <injection_id>` — replay the recorded trace.
- `librarian why-not <query> <note_id>` — pure function, no logging needed: replay the query against the current index, show where the note ranked and which gate cut it. Determinism makes the negative trace free.
- `librarian note show <note_id> --with-provenance` — latest revision + source kind, session, event range, source excerpts.
- `librarian stats` (12.10) — self-evaluation report derived read-only from both diagnostics streams: admission funnel rates, per-note usage, dead-note and perpetual-candidate lists. Diagnostics deleted → empty report; never a gate.

**Isolation (structural, not policy — enforced three ways):**
1. **Placement:** diagnostics live at `~/.librarian/diagnostics/`, outside the data-log root (`~/.librarian/data/`) and outside the vault. Never rendered into the vault in any form (no debug-dashboard exporters). Freely deletable at any time with zero replay consequences — the retention story is the opposite of the sacred logs'.
2. **Poison-pill:** diagnostic records carry `record_class: "diagnostic"` and deliberately do not conform to the canonical event shape. Every ingestion-side validator (collector, human-distiller importer) **hard-rejects** them — quarantine-with-error, not silent skip.
3. **Fixture:** feed a diagnostics file to the collector; assert loud rejection (§9).

**Rationale (recorded so the rule is understood, not just obeyed):** self-observation entering memory creates a reflexive loop — the system forming memories about its own memory behavior, which influence recall, which generates new diagnostics. It is the generated-export feedback loop one level up, and it degrades quietly. Diagnostic *insights* may enter memory through exactly one door: a human writes a curated note. The raw traces never do.

## 9. Testing discipline

- **Provider qualification fixtures** (3–5): synthetic session in → note lands, routes correctly, links sanely. Guards quiet degradation on small local models.
- **Origin qualification fixtures:** every new integration ships 3–5 golden content-events + expected outcomes.
- **Negative recall fixtures** (every fixture set asserts what recalls *and what must not*): similarly-named projects don't contaminate each other; a superseded decision is not preferred over its newer curated replacement; cross-repo episodic notes don't leak; broad queries don't inject stale daily notes; secret-like content is redacted before append; generated exports are not re-ingested.
- **Vacuous-session fixture (write-side negative fixture, 12.9):** a purely mechanical delta that clears the skip heuristic (bash/read tools, weak prompts, no decisions or learned facts) must yield a NOOP distill verdict, not a note. Doubles as the per-provider over-admission probe in the qualification set.
- **Diagnostics-rejection fixture:** diagnostics file fed to collector → hard rejection.
- **Re-distill nasty-path fixture:** crash/retry over an already-provenanced range must not mint duplicates.
- No frameworks — plain fixtures. The negative fixtures are also the named trigger for the re-ranking upgrade (§5).

## 10. Schemas (draft — to become `schema/event.md` and `schema/note.md`)

Each schema file = prose + TypeScript types + 3–5 golden JSON examples. Golden examples are the acceptance test for whether the design is concrete enough to build.

### 10.1 Canonical event

```ts
type CanonicalEvent = PromptEvent | ToolEvent | SessionEvent;
// ContentEvent reserved for non-agent sources — rule settled, shape deferred (§5)

type EventBase = {
  schema_version: 1;
  event_id: string;          // ULID, generated before append, never changes
  ts: string;                // ISO 8601
  resource: {
    agent: string; agent_version?: string;
    machine_id: string;      // generated ID persisted at ~/.librarian/machine-id (NOT hostname)
    cwd: string; git_root?: string; git_remote?: string; git_branch?: string;
  };
  context: { session_id: string; turn?: number; cwd: string };
  hints?: { possibly_salient?: boolean;
            reason?: "file_write" | "vcs_commit" | "cwd_change" | "user_pushback" | "manual" };
};

type PromptEvent = EventBase & { type: "prompt"; prompt: string };

type ToolEvent = EventBase & {
  type: "tool";
  tool: { native_name: string;
          canonical_name: "read" | "write" | "edit" | "bash" | "search" | "unknown";
          category: "file_read" | "file_write" | "command" | "search"
                  | "vcs_commit" | "vcs_push" | "other" };
  command?: string;                                  // redacted before append
  files?: Array<{ path: string; action: "read" | "write" | "edit" | "delete" }>;
};

type SessionEvent = EventBase & { type: "session"; action: "start" | "stop" | "compact" | "checkpoint" };
```

**Rules:** redaction before append; `resource` stores facts, not authoritative identity; `project_slug` not on events; hints non-authoritative; partial lines ignored/quarantined; cursors advance after success; validators hard-reject `record_class: diagnostic`. **Provenance is collector-stamped, never LLM-authored:** the renderer presents events with ordinal indexes; the LLM cites indexes; the collector maps indexes → ULIDs. Mechanical fields belong to code.

Golden examples: (1) prompt in a git repo; (2) file edit → `file_write`; (3) `git commit` via bash → `vcs_commit`; (4) redacted command containing a token; (5) session checkpoint.

### 10.2 Note record

```ts
type NoteRecord = NoteRevision | NoteTombstone;

type NoteRevision = {
  kind: "note_revision"; schema_version: 1;
  note_id: string; revision_id: string;              // revision_id: ULID
  previous_revision_id?: string;
  created_at: string;
  identity: { mode: "deterministic" | "episodic"; key?: string };
  source: {
    origin: string;                                  // open vocabulary, MANDATORY
    distiller: "llm" | "human";
    model?: string; agent?: string;
    source_path?: string; content_hash?: string;
  };
  note_type: "fact" | "decision" | "project_summary" | "person" | "daily" | "episode" | "curated";
  title: string;
  scope: { project_slug?: string; git_root?: string; git_remote?: string; global?: boolean };
  provenance: { session_id?: string; event_ids?: string[];
                event_range?: { from_event_id: string; to_event_id: string } };
  links: Array<{ target_type: "note" | "entity" | "project" | "file" | "url";
                 target: string; relation?: string }>;
  body: { summary: string; bullets?: string[]; details?: string };
};

type NoteTombstone = {
  kind: "note_tombstone"; schema_version: 1;
  note_id: string; revision_id: string; previous_revision_id: string;
  reason?: string; created_at: string;
  source: { kind: "human" | "cli" };
};
```

**Rules:** `origin` mandatory, denormalized, indexed, fail-closed. Human distiller preserves Markdown verbatim in `body.details`, derives `title` from H1 and `summary` from first paragraph. Curated frontmatter may declare `note_id`; importer tombstones orphaned IDs on rename. `search_text` is indexer-derived. Tombstones CLI/human only in v1.

Golden examples: (1) episodic decision, `distiller: llm`, `origin: opencode`; (2) deterministic project-summary rev 1; (3) rev 2 with `previous_revision_id`; (4) curated note, `distiller: human`, explicit frontmatter `note_id`; (5) tombstone via CLI.

## 11. Housekeeping decisions

- Directory layout: `~/.librarian/data/` (event + note logs, sacred), `~/.librarian/diagnostics/` (deletable), `~/.librarian/index/` (derived, rebuildable — §4, 2026-07-16), `~/.librarian/machine-id`, `~/.librarian/config.json` (§14), vault wherever the user keeps it (`generated/` + `curated/`).
- Note-log layout: monthly append-only segments `notes/{yyyy-mm}.ndjson`, never rewritten. Cursors reference `{file_path, byte_offset}`.
- `machine_id`: generated once, persisted; never the hostname.
- **V1 is single-machine, by declaration.** ULIDs make records collision-safe; the eventual answer is per-machine log segments. Deferred with it: `daily:{date}` cross-machine collision.

## 12. Roadmap

The live breakdown — epics, stories, status, dependencies — lives in GitHub
(labels `epic`/`story`/`task`, native sub-issue nesting, blocked-by) and the
Project board (github.com/users/magnus-tornvall/projects/1). This section keeps
only the *why* that outlives any single issue.

**Shipped (items 1–9):** schema docs (`event`/`note`); the three structural
invariants; walking skeleton (fixture events → distill → note log → Obsidian
export → BM25 index → recall with floor + weights + traces); curated-Markdown
path; real instrumentation (OpenCode, then Claude Code); MCP pull path +
provenance drill-down; recall injection adapters (push path, `why`/`why-not`);
hardening (cursors, locks, retries, quarantine, `drain`; playbook in
`docs/hardening.md`).

**Deferred, with named triggers:** item 10's second inference provider +
SQLite-mirror exporter (after the first path proves out); item 11's first
non-agent source (`ContentEvent` + per-origin profile). Item 11 jumps *behind*
item 12 deliberately — memory correctness compounds with every note written,
while a non-agent source can be added whenever one is actually wanted.

**Live epics (breakdown and status in GitHub):**

- **12 — Memory correctness & maintenance.** The gated admission pipeline
  (worth → novelty → faithfulness, §5), bi-temporal invalidation, per-type TTL
  and recency half-lives, self-evaluation (`librarian stats`), and the in-flow
  correction loop (flag / edit / revise). Highest leverage on the list: every
  gate compounds, and under dogfooding librarian's own junk is maximally similar
  to future queries about librarian.
- **13 — Hot-path & wiring hardening.** Jumps the item-12 remainder because 12's
  remaining sub-items tune a loop whose instruments are broken: traces snapshot a
  constant (13.2), and every dogfooding prompt pays an O(vault) rebuild that
  worsens as dogfooding succeeds (13.1). Small, pure implementation, no research.
  The persistent index (13.1) is a hard prerequisite for item 14.
- **14 — Semantic search MVP (sqlite-vec + embeddings).** BM25 is structurally
  blind across the bilingual Swedish/English vault (§5 search ruling). Staged by
  injection blast-radius (§6): pull path + novelty candidates first, push path
  last, each gated on the negative fixtures passing with vectors on. Blocked by
  13.1 (+13.2 for tunability).

The item-12 remainder (12.11 injected-note contradiction detection) is deferred
until a trigger; its status lives on its GitHub issue. The do-not-relitigate
rulings on closed/parked sub-items (12.3, 12.8, 12.5-corroboration) are in §5.

## 14. Implementation & process decisions (2026-07-05, settled — same bar as §5, do not relitigate without new information)

Seven decisions closing the design-phase backlog: how the thing gets built, not what it does.

**Language & runtime**
- TypeScript, compiled to JS for the published CLI. Node.js LTS — not Bun, an additional runtime dependency this project doesn't need; `better-sqlite3` already gives synchronous native SQLite on Node without it.
- Package manager: **npm**. It ships with Node — zero extra install, which matches the "invisible infrastructure" positioning (§1). pnpm's workspace/hoisting strengths solve a monorepo problem Librarian doesn't have; it is one package.
- `engines.node >= 22` (native TypeScript type-stripping). Tests run `.ts` files directly via `node --test`, no `ts-node`/`tsx` dependency. Revisit only if a construct the code actually needs turns out to be non-erasable — not preemptively.
- CLI: `bin/librarian` via `package.json` `bin`, pointing at compiled `dist/` output (`tsc`).
- `better-sqlite3` and `@modelcontextprotocol/sdk` are added when the code that needs them lands (indexer, MCP server) — not upfront, per the "deleted/deferred" discipline already established in §5.

**Repo bootstrap**
- Working name **librarian** stands. License, `package.json` metadata beyond what a task needs, and any directory layout beyond what a given backlog task requires are **deferred** — decided when something forces the question (first external contributor, first publish).
- Risk flagged, not resolved: §1 states an open-source north star, but the repo currently ships no LICENSE file; silence defaults to all-rights-reserved. Cheap to fix, deliberately left out of scope here — a candidate for a future backlog task, not a blocker.

**Golden examples: extracted**
- §10's golden examples live as JSON files under `schema/examples/event/*.json` and `schema/examples/note/*.json`, one file per example, referenced (not inlined) from `schema/event.md` / `schema/note.md`. Extracted files double as fixture input for the qualification fixtures in §9 — a code-fenced example in a Markdown file can't be loaded by a test.

**Test convention**
- `node --test`, TypeScript, **black-box/integration only — no unit tests.** This matches the design's own shape: every pipeline stage (collector, distiller, indexer, recall) has an explicit input/output contract (§4); testing through that contract is both the honest test and the one that survives internal refactors. No mocking framework — fixtures are plain files (NDJSON, JSON), consistent with §9's "no frameworks, plain fixtures."
- Test layout mirrors pipeline stages under `tests/`, one file per stage, plus one end-to-end `tests/walkingSkeleton.integration.test.ts` for the roadmap-4 path.

**Backlog execution: agents**
- Backlog tasks are written to be picked up by a coding agent in a fresh session, not executed by the author directly. Each carries a spec-section pointer, a "do not relitigate" header naming the settled decisions in play, and a done-check runnable in ≤15 minutes. (The original `backlog/` files for roadmap items 1–8 are consumed and removed; the convention stands for future roadmap explosions, now tracked as GitHub issues.)

**Config file location**
- `~/.librarian/config.json`. Rejected `~/.config/librarian/config.json` (XDG) for consistency with this project's own settled housekeeping (§11): data (`~/.librarian/data/`), diagnostics (`~/.librarian/diagnostics/`), and `machine-id` already share one dotfolder root. Splitting config out to a second, OS-idiomatic location buys generic-Linux-citizenship at the cost of the property that root is built to have — `rm -rf ~/.librarian` cleanly removes everything, same as the SSH-agent / Ollama precedent §1 already invokes. No XDG override; add one later only if a real user asks for it.

**Dogfooding**
- "Build sessions get recorded" is real but bootstrapped, not immediate: recording requires a Claude Code instrumentation adapter, which is roadmap step 6 (§12) — before that, there is nothing to instrument with. From step 6 onward, backlog work done in an interactive Claude Code session on a machine with the adapter installed is captured in Librarian's own event log; that is the actual dogfooding moment, not a property that holds from day one.
- Stated plainly so it isn't mistaken for a gap later: this only applies where the adapter can attach a hook in a persistent home directory. Ephemeral/headless agent runs (CI, one-shot remote containers with no persistent `~/.librarian`) are not expected to be captured — dogfooding is a developer-machine property, not a CI property.

## 15. Open items (known, deferred, not blocking — all with named triggers or preserved escape hatches)

- `ContentEvent` shape + per-origin distiller profiles (trigger: first non-agent source).
- **Re-ranking pass — demoted behind hybrid (2026-07-16, reverses the v2 ordering).** A cross-encoder re-ranker has the same architectural cost as query embedding (an inference call in the recall hot path) while being slower per query (N candidate passes vs. one embedding); once 14.1 exists, hybrid is the cheaper first response to recall misses, and re-ranking becomes the escalation if hybrid + floor still admit distractors. The spirit of the original ruling (cheapest intervention first, fixtures decide) is unchanged; the ordering it implied is not. (The former vector-search trigger bullet is superseded outright: semantic search is MVP scope — §5, §12 item 14.)
- **In-process embedding provider (ONNX via `@huggingface/transformers`, e.g. Voyage 4 Nano — research preserved in issue #97):** deferred alternative to the endpoint provider (14.1). It removes the external-process dependency at the cost of a native onnxruntime dependency plus ~255MB model-cache management, in a package that is currently daemon-free and dependency-light. Trigger: endpoint friction proves real — a user who won't run Ollama/LM Studio wants hybrid. Same seam, so flipping the default later costs nothing in design; the digest-pinning rule applies unchanged (pin the HF model revision).
- **Rejected claude-mem features (2026-07-15/16, recorded so they are not relitigated):** resident worker/daemon (the persistent index solves the hot path — §4); viewer UI (Obsidian is the viewer; the vault export *is* the UI budget); teams/multi-user server schema (the team-memory ruling below stands); any second store, Chroma or otherwise (vectors live in the same SQLite file as FTS5 or not at all — a second store buys a sync subsystem, refused); inline per-region curated/private ownership tags in exported files (§5 human-curation reaffirmation — the merge-engine problem); mode-system adoption now (§5 deleted/deferred — declined; per-origin-profiles trigger unchanged).
- OTLP export of diagnostics; timing spans (trigger: wanting an external tracing backend / something feels slow).
- Log compaction/GC; gzip of closed segments (trigger: size on disk matters).
- Multi-machine sync via per-machine segments (trigger: second machine). The trigger unlocks, together: per-machine log directories (cursor format `{file_path, byte_offset}` already survives the reshuffle), `created_by_machine` on note revisions (backfillable from `~/.librarian/machine-id` — that's why it isn't day-one), and the real design work: a resolution rule for deterministic-ID revision forks — two machines revising `project:{slug}:summary` produce revisions sharing a `previous_revision_id`, and latest-wins-by-ULID is silent last-write-wins. `user_id` stays out of the schema: unknown-field tolerance + read-time defaults make it retrofittable, and ownership may end up derived from a `machine_id → user` config map rather than stored per-record.
- Curated-vault sync collision (trigger: same, but likely fires *first*): users sync Obsidian vaults via iCloud/Syncthing today, so two importers ingesting the same curated file (same declared `note_id`) is probably the first multi-machine collision encountered — before a second event-log machine exists.
- Team/shared memory (trigger: second user). Decision recorded now so it isn't relitigated later: visibility is **structural, not a field** — private memory lives in personal logs, team memory is a separate shared store synced like a git remote; recall queries both. No `visibility: private|team|public` per-record field: placement can't leak via a forgotten filter (§4, structural invariants beat policy invariants). **Peer-mesh shape (recorded 2026-07-10, still trigger-gated):** peer memory = a read-only directory of foreign note-log segments per peer, synced by whatever the user already syncs files with (Syncthing, git, iCloud — the sync layer is someone else's app; no daemon, per §4). Engagement is opt-in and local: a peer store exists only if configured. Trust is per-peer recall weights — one more factor in the §6 weights mechanism (`origin: "peer:alice"` → `{ "peer:alice": 1.2 }`), which gives per-person trust across multiple meshes for free. Peer notes never enter the local note log, so the distiller narrow waist is never bypassed — but they also skip local admission gates, and recall-time weights are a prior, not a guard (§6 amendment): the honest defense is structural separation, a visible `[peer:x]` provenance tag in injected blocks, and a conservative default weight (<1.0) until the user raises it.
- Entity identity for links; episodic consolidation (deferred together — the entity-resolution problem).
- Distiller prompts (routing, note-type selection, per-origin salience) — implementation work, fixture-validated.
- **Emergency event-log purge** (from the 2026-07-04 GPT-5.5 review, folded 2026-07-10): append-only stays the default invariant, but a false-negative redaction, private paste, or legally sensitive record needs an honest recovery path. Shape: `librarian purge-event-range --rewrite-segment` — rare, loud, deliberately breaks replay purity, records a local audit note outside memory. Trigger: first discovered secret or private record in the event log.
- **Rendered block in the injection trace** (same review, folded 2026-07-10): traces record candidates, scores, and the config snapshot but not the final rendered `<librarian-memory>` block, so a renderer change makes old traces unreproducible. Store the rendered block (diagnostics are deletable, so size is fine) or a renderer version + hash. Trigger: first renderer change after real traces exist.
- **Composability seams** (from `composability-seams-handoff.md`, folded 2026-07-10 — the doc itself is deleted; its rejected-abstractions rulings duplicate §5): `Exporter` interface extraction (trigger: SQLite mirror, roadmap item 10 — shape it from the working `exportNoteToVault` signature, likely a `makeObsidianExporter(vaultDir)` factory; add tombstone export with the first tombstone producer). Contracts barrel (`src/contracts.ts` re-exporting `InferenceProvider`, `Exporter`, schema types — if it's not in the barrel, it's internal), `docs/extending.md`, and conformance helpers (`assertProviderQualifies`, `assertExporterIdempotent`) — trigger: first external contributor or first publish. Standing rulings that survive the doc: no unified push/pull recall interface, no `Distiller`/`Instrumentation`/`Renderer` interfaces, no provider registry.
