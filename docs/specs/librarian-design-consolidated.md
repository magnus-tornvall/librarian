# Librarian — Consolidated Design Handoff (v4)

**Date:** 2026-07-05. **Status:** design converged after eight review rounds (Claude Fable 5 ↔ GPT-5.5 ↔ Claude Opus 4.8 research ↔ author challenges), plus a process-consolidation pass closing the seven remaining implementation-mechanics decisions (§14). This document supersedes v3 (2026-07-04) and is standalone: a fresh session needs no prior context. Roadmap items 1–8 (§12) are implemented; next action is the remaining roadmap.

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

**Status (2026-07-11):** items 1–5 complete (issues #2–#9, #16–#21). Item 6 is complete (issues #28–#32). Item 7 is complete (issues #41–#44). Item 8 is complete (issues #49–#53). Item 9 is complete (issues #59–#63). Item 10's inference-provider half is complete (issues #70–#71); the SQLite-mirror half is deferred (named trigger recorded in #70). Item 11 is deferred (see below). **Item 12 is the next action, exploded into issues #74–#82.**

**Status (2026-07-16):** item-12 sub-items 12.1 (#75), 12.2 (#78/#94), 12.4 (#76/#87), 12.5-TTL (#79/#95), 12.6 (#74/#85), 12.7 (#77/#93), 12.9 (#88/#89), 12.10 (#90/#92) are complete. The remainder is **triaged, not merely paused:**
- **12.3 (#81) closed** — its only outcome signal (`user_pushback`) is emitted by neither adapter (verified against main), session-level pushback cannot name *which* note was wrong, the demotion constants are uncalibratable with no signal flowing, and ranking derived from deletable diagnostics makes recall depend on telemetry retention. Replaced by explicit `flag_note` (item 12.12 → #106).
- **12.8 (#82) closed** — lexical overlap detects "same subject," not "conflicting claims"; it would silently drop compatible notes on the push path (a false-positive distractor mechanism of its own), and the deterministic variants are no-ops now that supersession (12.2) and the open-validity filter exist. The residual unmarked-conflict case folds into 12.11, which has actual claims and events to judge. The §6 ignition finding stands; this detector couldn't serve it.
- **12.5-corroboration (#80) parked** — complexity (new record kind, trace `session_id` plumbing, self-citation join, indexer column, TTL seam change) outweighs the value until measured; long-lived truths belong in `decision`/`fact`/curated notes per 12.9's worth criteria. Trigger to reopen: `librarian stats` shows duplicate NOOPs against near-TTL-expiry notes at a meaningful rate. First response if it fires: the lazy mechanism recorded on the issue (novelty gate *admits* the duplicate when the matched note is near expiry — fresh note, fresh clock, no new machinery), not the original design.
- **12.11 (#91) kept**, decoupled from #80/#81 (it owns its own trace `session_id` plumbing), sequenced after 14.4; must treat `distiller: "human"` revisions like curated notes (§5 human-revision ruling).

**Items 13 (#98–#101) and 14 (#102–#105) jump the queue:** 12's remaining work tunes a loop whose instruments 13.1/13.2 fix (traces snapshot a constant; every dogfooding prompt pays an O(vault) rebuild), and the embedding rollout needs honest trace snapshots and a persistent index to exist at all. Resume the item-12 remainder (12.11, 12.12, 12.13) after 14.4.

1. ✅ `schema/event.md` — prose + types + golden examples (§10.1).
2. ✅ `schema/note.md` — same (§10.2).
3. ✅ Specify curated-note ingestion + generated-file exclusion + diagnostics isolation (short doc; the three structural invariants together).
4. ✅ **Walking skeleton:** fixture events → renderer → LLM distill (`claude -p`, hard-coded) → note log → Obsidian export → BM25 index → recall query with floor + weights + injection trace. Ugly internals, real data. Revise the note schema from what the skeleton teaches. **Diagnostics log and injection traces start here** — recall telemetry is computed from them.
5. ✅ Curated Markdown → human distiller → note log → index → recall (with human weight).
6. ✅ Real instrumentation (OpenCode first — existing plugin remapped to canonical schema; Claude Code second). Complete via issues #28–#32.
7. ✅ **MCP server (pull path):** search tool (scored results, origin/scope filters) + **provenance drill-down tool** (note → verbatim event excerpts). Complete via issues #41–#44. Transport analysis remains in `docs/research/pull-path-mcp-vs-skill.md`.
8. ✅ Recall injection adapters (push path: OpenCode two-phase hook design; Claude Code parity). Injected-block contract per §6; `librarian why` / `why-not` land here. Complete via issues #49–#53.
9. ✅ Hardening: cursors, locks, retries, quarantine, `librarian drain`. Complete via issues #59–#63. Recovery playbook in `docs/hardening.md`.
10. Second inference provider (OpenAI-compatible ⇒ local) and second exporter (SQLite mirror) — after the first path works end-to-end.
11. **Deferred (2026-07-11)** — first non-agent integration (`ContentEvent` + per-origin profile + origin fixtures). No concrete source is wanted yet; the trigger is already recorded in §15 ("first non-agent source"). Item 12 jumps the queue: memory correctness compounds with every note written, while a non-agent source can be added whenever one is actually wanted.
12. **Memory correctness & maintenance — next up; exploded into GitHub issues (2026-07-11): 12.1→#75, 12.2→#78, 12.3→#81, 12.4→#76, 12.5→#79 (TTL) + #80 (corroboration), 12.6→#74, 12.7→#77, 12.8→#82, 12.9→#88 (added 2026-07-12), 12.10→#90, 12.11→#91 (added 2026-07-12, self-evaluation). Dependency order lives on the issues (native blocked-by relationships): #74→#76→#80, #75→#78→#79→#80, #75→#82, #88→#90→#91 with #78/#80 also blocking #91; #77, #81, and #88 are unblocked. Status 2026-07-12: 12.6 (#74), 12.1 (#75), 12.4 (#76) complete via PRs #85–#87; 12.9 (#88) jumps the remaining queue — it is the write-side gate the completed gates assume, and its junk compounds fastest under dogfooding (librarian's own sessions are maximally similar to future queries about librarian).** (added 2026-07-09 from an agent-memory literature round: LongMemEval knowledge-update lineage, Zep/Graphiti bi-temporal invalidation, SSGM "Memory Worth", SAGE/MemGuard write-time gating; sub-items 6–8 added 2026-07-10 from a Semantic Scholar verification round — TRUSTMEM, Supersede, ConvMemory v3, RoMem — plus the workspace-interpretability round in §6). Sub-items 1–5 ordered by leverage with 1 as the tripwire; **sub-item 6 guards the narrow waist every note passes through and arguably precedes everything else; 7 is the cheapest fix on the list**:
    1. **Knowledge-update negative fixture** — distill a fact, distill its contradiction in a later session, assert recall returns the newer one. The measured failure mode of append-only stores is stale-fact-beats-fresh-fact; recency decay alone is not a reliable winner-picker. This fixture is the **named trigger** for sub-items 2–5 and can land any time (fits the §9 negative-fixture discipline today).
    2. **Bi-temporal invalidation:** `valid_at`/`invalid_at` on note revisions plus a `supersedes: note_id` record type; recall filters to open validity intervals. Logical invalidation *is* an append — the note log stays sacred and replayable, and `librarian why` can explain "superseded by X". **Extends, does not relitigate, the §5 v1 revision rule:** episodic notes remain immutable; supersession is a new record about an old one, never a mutation of it.
    3. **Outcome-linked note worth:** join injection traces (§8) against a cheap per-session outcome signal (detected user correction, explicit `why-not` veto, abandoned session) → per-note multiplier folded into the §6 weights mechanism. Targets the confidently-wrong *hot* memory — highly retrieved, so recency decay never touches it — which the literature names as the open problem. The plumbing (injection_id, traces, per-session events) already exists; only the join and the multiplier are new.
    4. **Novelty gate at distill admission:** before admitting an episodic note, BM25-query the existing index for near-duplicates; above a similarity threshold → NOOP (or revision-candidate for a deterministic-ID note). Distractor prevention at the cheapest point — write time — consistent with §1's "wrong context is worse than no context". Runs before 12.6's verify in the §5 admission pipeline (cheap gate first); a duplicate verdict is not a failure — it goes to diagnostics and the cursor advances.
    5. **Per-note-type TTL as recall exclusion:** a config map in the same shape as the §6 weights (e.g. `{ episode: 90d, daily: 30d, decision: ∞, curated: ∞ }`) applied as a hard recall filter — never deletion, logs stay append-only. Same recall-side check as an `invalid_at`; implement together with sub-item 2. **Corroboration extends TTL (amended 2026-07-11):** a novelty-gate duplicate hit (12.4) means a later session independently re-derived the same conclusion — a citation, and evidence the fact still holds. TTL is measured from `max(created_at, last corroboration)`, so a citation resets the clock. Constraints: (a) **self-citation guard** — a duplicate only counts as corroboration if the matched `note_id` was *not* injected into the session that produced it (join against injection traces), else memory manufactures its own immortality via the §8 reflexive loop; (b) corroboration is a small **note-log record** (`note_corroboration` — the positive twin of 12.2's `supersedes`: a new record about an old one, never a mutation), because diagnostics are deletable and must not hard-affect recall; losing corroborations fails safe — notes just expire on the default schedule; (c) **retrieval/injection counts are explicitly *not* citations** — they say the query matched, not that the content was right, and boosting by them rewards the confidently-wrong hot memory (12.3 owns that signal, joined to outcomes). Day-one obligation on 12.4: the duplicate verdict records the matched `note_id`.
    6. **Distiller faithfulness verification:** the LLM distiller is currently an unverified writer — its output is schema-validated but never checked against the source events, so a hallucinated summary becomes a durable, provenance-stamped note that recall will confidently inject. TRUSTMEM (2026) names the three error classes (omission, corruption, hallucination) and shows a verify-after-write step cuts them 40–79%. Generation is the fragile abstract-characterization task; verification against source lines is the cheap shallow one — the asymmetry favors checking. **Mechanism settled in §5 (gated admission pipeline):** a verify pass (cheaper model allowed) scores the draft note against the rendered event range and returns `{ faithful, errors: [omission|corruption|hallucination], reason }`; one re-distill with the reason fed back, then fail-closed — no note, distill verdict to diagnostics, cursor advances, events remain replayable. The verifier vetoes, never edits. Provenance drill-down makes errors *auditable*; this makes them *detected*.
    7. **Per-note-type recency half-lives:** the uniform `exp(-ageDays/90)` decay buries old-but-permanent knowledge — a one-year-old `decision` note is multiplied by ~0.017, so its 1.2 type weight can never save it (RoMem 2026: recency sorting "buries old-yet-permanent knowledge"; systems must distinguish persistent facts from evolving ones). Fix is a config map in the same shape as the weights: per-type half-lives (`decision`/`curated` → very long or no decay; `episode`/`daily` → current 90d). One-line scoring change; distinct from sub-item 5 (TTL excludes; this ranks).
    8. **Within-block contradiction check:** two contradicting notes can ship in one injection block today, and episodic immutability guarantees contradicting pairs accumulate. Conflicting retrieved evidence is the worst-handled retrieval defect (RAG-with-conflicting-evidence lineage), and the §6 amendment's ignition finding means the model resolves the conflict silently and confidently rather than flagging it — the worst failure shape under invisible injection. Minimal shape: before shipping, detect same-fact contradictions among the ≤5 selected notes (cheap: same deterministic ID family or high pairwise BM25 overlap with disagreeing summaries) and drop the older, recording the drop in the injection trace. Interim mitigation until sub-item 2 makes supersession explicit.
    9. **Worth-remembering judgment (distill prompt + NOOP decline) — added 2026-07-12 → issue #88.** The distill prompt's entire worth guidance is one sentence and the contract forces a note (`coerceNoteType` maps any unrecognized type to `episode`), so once a delta clears the skip heuristic a note is minted no matter how vacuous. None of the other gates catches vacuity: a vacuous note is *novel* (passes 12.4), *faithful* (passes 12.6 — vacuity is not one of TRUSTMEM's error classes), uncontradicted (12.2 never fires), and 12.5's corroboration actively rewards it — the next mechanical session re-derives "ran the build" and resets its TTL. This is the write-side twin of §6's relevance floor and the cheapest gate in the §5 pipeline (it runs inside the LLM call already being paid for). Research grounding (2026-07-12 round — mem0/LangMem/Letta/A-MEM verbatim prompt survey; A-MAC; SAGE; HaluMem): production systems define worth by enumerated categories, not open-ended judgment (a rule-based content-type prior was A-MAC's strongest admission signal); every shipped extraction prompt has an explicit empty-output path taught by negative examples; admission decisions are discrete, never scalar importance; extraction — not retrieval — is where memory systems accumulate errors. Librarian can filter harder than mem0 because the verbatim record already exists (sacred event log + provenance drill-down, §6): the note is *not* a record of what happened; it holds only what a future session could not cheaply re-derive from the repository or the event log. **Must-haves (in #88):** enumerated worth categories mapped to note types (decisions with rationale and rejected alternatives; hard-won facts not evident from the code; user corrections/preferences; project-state changes; people); the re-derivability criterion framed against the event log; an explicit NOT-worth list with concrete examples (tool/command narration, routine edits, repo-re-derivable content, generic practice); absolute dates, never relative; the NOOP decline (`note_type: "none"` + reason → `noop` verdict, fail-closed, cursor advances, bypasses 12.4/12.6); the vacuous-session fixture (§9). **Nice-to-haves (trigger-gated, not in #88):** mem0-style negative few-shot examples in the prompt (trigger: a provider qualification run shows over-admission — expected first on small local models); NOOP-rate trend reporting beyond the drain summary (trigger: prompt tuning wants the time series; the verdicts already carry it); per-origin worth profiles stay deferred with §5's `ContentEvent` decision (trigger unchanged: first non-agent source). Per §6's epistemics the prompt is a prior, not a guard — whether a given provider actually declines is measured by the qualification fixtures, never assumed. **Also the named prerequisite for default-on automatic distill triggering:** small-and-often triggers multiply distill invocations over small, mechanical deltas — exactly the input distribution where a no-decline prompt does the most damage. The trigger investigation itself (turn-end / pre-compaction / session-end hooks, "not yet" skip semantics, same-session recall exclusion) is separate future work, not part of this item.
    10. **Self-evaluation report (`librarian stats`) — added 2026-07-12 → issue #90.** The continual-learning loop currently records everything and reports nothing: both §8 diagnostics streams exist (distill verdicts, injection traces — every candidate with scores and cut reasons, `shipped_note_ids`), but nothing joins them, so the questions that decide tuning are unanswerable without hand-grepping NDJSON. One read-only command. **Must-haves (in #90):** the admission funnel trended by month and split by origin/provider — distilled / duplicate / skipped / quarantined / rejected / noop rates, where the **noop rate is 12.9's measuring instrument** (subsuming its deferred trend-reporting nice-to-have) and a rising **duplicate rate means recall is failing to prevent re-derivation**; read-side usage derived from injection traces — injections per note, **dead-note ratio** over a trailing window (never shipped — where vacuous notes hide), **perpetual candidates** (always cut `below_floor` — the borderline-junk shortlist), and the **cut-reason mix** (mostly `below_floor` → the vault doesn't match real queries; mostly `budget` → ranking, not admission, is the binding constraint). Epistemics: an operator report, **prior not guard** — no automatic deletion or demotion from these numbers (12.3 owns outcome-joined demotion; retrieval/injection counts are explicitly not quality signals per 12.5c). Derived and read-only from deletable diagnostics: diagnostics deleted → empty report, nothing else changes (§8 isolation untouched — the report reads diagnostics, its output never enters memory). **Nice-to-have (trigger-gated, not in #90): retrieval canaries** — a small set of canned queries with expected note hits run as a §9 read-side regression fixture (LongMemEval reduced to fixture discipline); trigger: the first ranking regression discovered in the field, or the first structural rework of §6 scoring.
    11. **Injected-note contradiction detection (negative twin of corroboration) — added 2026-07-12 → issue #91.** Closes the outcome loop at note granularity. The positive half exists (12.5: corroboration resets TTL); the negative signals are coarse or coincidental: 12.3 demotes on session-level pushback without knowing *which* note was wrong, and 12.2 invalidates only when a later distill happens to mint the superseding fact. The uncovered case: a note is injected, the session corrects it (user: "no, that's wrong"), but the correction never becomes a note — the delta is mechanical so 12.9 declines, or the corrected fact is repo-re-derivable so it isn't worth one — and the wrong note survives to be injected again. **Mechanism:** at distill time, join the delta's session against injection traces (`session_id` → `shipped_note_ids`; plumbing shared with #80/#81) and run a verify-shaped check per injected note — "do these events contradict this note?" — cheaper model allowed, same generation/verification asymmetry as 12.6. A detected contradiction appends a **12.2 invalidation record** (a new record about an old note, never a mutation; recall's open-validity filter excludes it; `librarian why` explains it; diagnostics stay deletable because the record lives in the note log). **Conservative by construction:** a false contradiction kills a good note, so the check defaults to no-contradiction and the record carries the LLM's reason for audit. Sequenced after 12.10 deliberately — measure before intervening: the stats baseline is how this mechanism's effect (and misfires) become visible. **Nice-to-have (trigger-gated, not in #91): explicit feedback** — an MCP `flag_note` tool for in-session "this note is wrong" (also one of 12.3's deferred signals, see #81); trigger: the first wrong note that has to be hand-killed where the CLI path proves too slow.

    12. **`flag_note` — explicit per-note feedback (2026-07-16, replaces 12.3/#81) → issue #106.** `librarian flag <note_id> --reason` and an MCP `flag_note` tool append a 12.2 invalidation record (validity-close-only variant — no replacement content is minted); recall's open-validity filter excludes it, `librarian why` explains it, and the human can supersede back. Note-granular, explicit, no joins, no heuristics — the signal 12.3 tried to infer, made explicit. Do not reopen a worth-multiplier design without a real, flowing, note-granular outcome signal to calibrate against.
    13. **Human note edit (2026-07-16) → issue #107.** `librarian note edit <note_id>` opens the note body in `$EDITOR` and appends a human revision per the §5 human-revision ruling (same `note_id`, `distiller: "human"`, origin unchanged, latest-wins). Closes the "tombstone + hand-written curated replacement to fix one bullet" friction without touching the vault invariants — the settled alternative to inline curated/generated region tags (§5, rejected).

13. **Hot-path & wiring hardening (2026-07-16) — jumps the remaining item-12 queue → issues #98–#101.** Rationale: 12's remaining sub-items tune a loop whose instruments are currently broken — traces snapshot a constant (13.2) and every dogfooding prompt pays an O(vault) rebuild that worsens as dogfooding succeeds (13.1). Small, pure implementation, no research.
    1. **Persistent index → #98.** `~/.librarian/index/notes.db` per §4; plan in `docs/plans/persistent-db.md` (authoritative); indexer becomes an incremental cursor consumer; push injection, pull recall, `why-not`, and the novelty gate read it (read-only for recall; distill runs indexer catch-up first); hot-path structural fixture; `rm -rf ~/.librarian/index` documented as safe recovery. Hard prerequisite for item 14.
    2. **Config wiring → #99.** Per §6 config-in-force; snapshot-honesty fixture. Rides along with 13.1. Prerequisite for meaningful 12.3-successor/12.5/12.7 tuning.
    3. **MCP 3-layer → #100.** Compact `search` + `get_notes` per §6; drill-down unchanged. Independent; slots anywhere.
    4. **Privacy tag + memory-echo guard → #101.** Per §5; two fixtures (private span absent after append; injected block absent after append). Independent; slots anywhere.

14. **Semantic search MVP (sqlite-vec + embeddings) — supersedes the trigger-gating (§5, reason recorded there). Blocked by 13.1 (+13.2 for tunability) → issues #102–#105.** Staged by injection physics (blast-radius order, §6): pull path and novelty candidates first, push last, gated on negative fixtures green with vectors on.
    1. **Embedding provider → #102.** The *contract* is an OpenAI-compatible embeddings endpoint (same seam family as InferenceProvider; shape the interface from working provider code per §15 composability rulings). Ollama is the low-friction default *option* with guided setup — a resident Ollama is the *user's* daemon, same stance as distillation providers; in-process ONNX is the deferred alternative (§15, research #97). Zero-config functional (no config → BM25-only); time-boxed fail-soft (400ms budget, config key; trace `embedding:` field); **pin by digest, not tag** (model name + digest in index metadata, day-one, non-retrofittable; model change = delete `~/.librarian/index`, rebuild); small multilingual default model (Swedish/English vault), choice + reason recorded at implementation time. Includes **`librarian doctor`**: endpoint reachability, configured model + digest vs. index metadata, embedding coverage, index freshness — read-only, human-facing, never a gate.
    2. **Index-time embedding → #103.** vec0 table in `notes.db`; the indexer embeds note revisions as it indexes (batch, fail-soft: an unembedded note remains in FTS5); coverage visible in `librarian stats`/drain summary — partial coverage is a reported state, never a silent one.
    3. **Hybrid on pull path + novelty candidates → #104.** §6 fusion + floor re-derivation; §5 novelty ruling (candidates, never verdicts). Fixtures: paraphrase recall including the **Swedish↔English cross-language case** (the supersession's justifying case — keep it prominent); fail-soft (endpoint down → BM25-only, floor holds); `why-not` replay across a digest stamp; 12.1 knowledge-update fixture green with embeddings on; hybrid-does-not-resurrect-below-floor.
    4. **Hybrid on push path → #105.** Flip last, gated on all 14.3 negative fixtures green. The push austerity contract (0–5, budget, floor, fail-closed) is unchanged — only candidate retrieval improves. After this lands, resume the item-12 remainder.

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
