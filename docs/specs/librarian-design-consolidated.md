# Librarian — Consolidated Design Handoff (v4)

**Date:** 2026-07-05. **Status:** design converged after eight review rounds (Claude Fable 5 ↔ GPT-5.5 ↔ Claude Opus 4.8 research ↔ author challenges), plus a process-consolidation pass closing the seven remaining implementation-mechanics decisions (§14). This document supersedes v3 (2026-07-04) and is standalone: a fresh session needs no prior context. Next action is implementation — the backlog in `backlog/` (see `backlog/README.md`), starting with Phase 0.

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

**Core principles (the design's spine):**
- Durable memory records are the domain layer; Obsidian pages are a rendered view or a curated input — never the canonical model.
- **The note log's contract: everything in it was judged worth remembering, by a named judge (`distiller`), from a named origin (`origin`).** The vault, the index, and recall are downstream conveniences of that one guarantee.
- **Structural invariants beat policy invariants.** Where a rule matters, enforce it by construction (directory layout, record shape, validators), not by the good behavior of future code. Precedents: generated/curated split, distill-only narrow waist, diagnostics isolation.

**Component roles:**
- **Instrumentation** (per-agent, dumb): map native events → canonical schema, stamp Resource facts, emit cheap non-authoritative salience hints, append. Zero domain logic. **An integration is just an event emitter.**
- **Collector** (library + CLI, **no daemon**): normalize → redact → validate → append. Owns distill triggering (lazy, detached-child model). Owns authoritative salience and the distill-skip heuristic. Stamps note provenance mechanically. Owns the **prompt renderer** (§7). Hard-rejects `record_class: diagnostic` at the validate stage.
- **LLM distiller**: consumer of the event log via an inference provider; admission control for machine-produced content. Prompt selection keyed on origin (per-origin profiles; default profile for unconfigured origins).
- **Human distiller (curated-note importer)**: converts human-authored Markdown → note records directly. Never routes curated notes through the LLM. Hard-rejects diagnostic records.
- **Indexer**: note-log consumer; owns the one blessed index (SQLite FTS5 BM25); derives `search_text` by fixed concatenation rule; indexes `origin` as a filterable column; fail-closed: records missing `origin` are excluded.
- **Exporters**: note-log consumers; idempotent by `note_id`; may filter by origin (per-source vault views = exporter configuration). Obsidian exporter first, SQLite mirror second. **Never render diagnostics into the vault.**
- **Recall**: BM25 query + deterministic scoring (project/global boost, recency decay, per-origin × per-note-type weights, relevance floor), read-only DB access; writes an injection trace per injection; feeds push adapters and the MCP server.
- **`librarian drain`**: CLI command that processes everything pending. The manual recovery and debug tool; more important than any daemon.

## 5. Decisions register (all settled — do not relitigate without new information)

Items marked **[endorsed]** were independently validated by the 2026-07-04 literature-research round (Lost in the Middle / Context Rot / Power of Noise / LongMemEval lineage; details in `docs/reviews/`).

**Identity & revisions**
- `note_id` = stable logical identity; `revision_id` = immutable version (ULID). `event_id` also ULID.
- Snapshot revisions, latest-revision-wins by `note_id`. No event-sourced note internals, no diff/patch format.
- **V1 revision rule:** only deterministic-ID notes may be revised (`project:{slug}:summary`, `person:{normalized_name}`, `daily:{yyyy-mm-dd}`, `curated:{id}`). The distiller may fetch a prior revision **only by deterministic ID** — never search for "probably related" notes and mutate them. Everything else is episodic: `{type}:{ulid}`, one revision, immutable forever. Semantic consolidation deferred (it is the entity-resolution problem).
- Tombstones exist in the schema from day one; v1 emitters are CLI/human actions only, never the distiller.

**Ingestion: distill-only, two distillers**
- **Nothing enters the note log without a distiller's judgment. There are exactly two distillers: `llm` and `human`.** No generic import path; machine-produced content — however pre-condensed — passes through the LLM distiller. The distiller is **admission control**, not compression: one writer discipline, one quality gate, one narrow waist. **[endorsed** — distill-skip gating means fewer low-signal notes = fewer future distractors**]**
- The curated-note importer is the human distiller's serialization mechanism, not an import facility. It preserves the human Markdown body verbatim (`body.details`), no LLM normalization. **[endorsed** — verbatim beats LLM-normalized; this is a correctness feature, not just fidelity**]**
- **Re-distill invariant:** idempotency is by provenance, not content: a re-distill of an already-provenanced event range is a bug. Cursor advance-after-success plus this invariant = exactly-once-ish. Nasty-path fixture required.
- Diagnostic insights enter memory only via a curated note (human distiller). The raw traces never do — no distiller with authority over them exists, and none should (§8).

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
- `search_text` is indexer-derived (fixed concatenation rule over title/summary/bullets/details/scope/links), never a record field.
- Recency decay `exp(-ageDays/90)`, computed in code, half-life tunable. **[endorsed** — simple deterministic recency prior; freshness/conflict resolution must not be LLM-reasoned**]**
- **First search upgrade, trigger-gated:** if negative fixtures show distractor injections despite the relevance floor → add a re-ranking pass. Re-ranking before vector search. Named trigger, not a roadmap item.

**Durability & safety**
- Redaction **before durable append** — non-retrofittable (secrets in an append-only replayable log are immortal). Pipeline: native event → normalize → redact → validate → append. Redaction preserves correlation without the secret: `[REDACTED:token:sha256:abc123]`. Applies to prompts as well as commands. **[endorsed]**
- Cursors: `{consumer, log_name, file_path, byte_offset, last_record_id?, updated_at}`; advance only after successful processing. Bounded retries; poison records quarantined with debug context (quarantine verdicts → diagnostics log); partial trailing JSON lines ignored until completed.
- Detached workers: explicit lock ownership, stale-lock recovery (PID/token checks, timeout).
- `schema_version` on every event and note record. Log compaction deferred but defined: consumers read canonical logs; compaction must preserve replay semantics.

**Human curation**
- Vault split: `vault/generated/**` (exporter-owned, deterministic paths, `librarian_generated: true` frontmatter + `<!-- librarian:generated; do not edit -->`, overwritten freely) vs `vault/curated/**` (human-owned, ingested by the human distiller, `origin: "human"`).
- **Invariant:** generated files are excluded from curated ingestion (structural: directory split). No mixed-ownership regions inside one Markdown file. Ever.
- Curated frontmatter may declare an explicit `note_id` (path-hash fallback); importer detects renames via `content_hash` and tombstones the orphaned old ID.

**Storage format & prompt rendering (settled 2026-07-04; supersedes nothing — names what was implicit)**
- **NDJSON stays for all logs. Prompt serialization is a rendering concern, fully decoupled from storage.** Token efficiency is a property of the renderer's output, not of files on disk; the LLM never reads a log file verbatim. See §7.

**Deleted / deferred (over-engineering guardrail)**
- Generic `Librarian` interface → concrete functions. Generic storage layer; exporter plugin system (one interface: `exportNoteRevision(record)`). Generic import path. Inference-provider schema-negotiation sophistication (completion + JSON-schema + validate + one retry). Qualification *frameworks* → fixtures (§9). Distiller-driven tombstones; episodic consolidation; daemon.
- **`ContentEvent` + per-origin distiller profiles:** rule settled (they are the integration contract for non-agent sources); mechanism deferred until the first concrete non-agent source.
- **OTLP export and timing/latency spans:** deferred, named trigger = actually wanting spans in an external backend / something feeling slow. The diagnostics log is the API; a converter is a page of code.
- Compressed log segments (gzip closed months): deferred until size-on-disk matters; changes nothing for consumers.

## 6. Recall & injection contract (settled — graduated from open item)

**Scoring (deterministic, in code):** BM25 → RRF-style fusion where applicable → project/global boost → recency decay → **weights** `score × f(origin) × f(note_type)` (one mechanism, two dimensions; config map, e.g. `{ human: 1.5, opencode: 1.0, email: 0.6 }` × `{ curated: 1.4, decision: 1.2, project_summary: 1.0, fact: 0.9, daily: 0.7, episode: 0.7 }`) → **relevance floor**.

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

**Push path (invisible injection — precision-first):**
- **0–5 records per prompt, never force-filled.** A low-relevance note filling a slot is a distractor; a distractor is worse than an empty slot. **[endorsed** — single-distractor harm is measured and monotonic**]** Relevance floor = BM25-score threshold, tuned against fixtures. Fail-closed extended from scope to relevance.
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

**Isolation (structural, not policy — enforced three ways):**
1. **Placement:** diagnostics live at `~/.librarian/diagnostics/`, outside the data-log root (`~/.librarian/data/`) and outside the vault. Never rendered into the vault in any form (no debug-dashboard exporters). Freely deletable at any time with zero replay consequences — the retention story is the opposite of the sacred logs'.
2. **Poison-pill:** diagnostic records carry `record_class: "diagnostic"` and deliberately do not conform to the canonical event shape. Every ingestion-side validator (collector, human-distiller importer) **hard-rejects** them — quarantine-with-error, not silent skip.
3. **Fixture:** feed a diagnostics file to the collector; assert loud rejection (§9).

**Rationale (recorded so the rule is understood, not just obeyed):** self-observation entering memory creates a reflexive loop — the system forming memories about its own memory behavior, which influence recall, which generates new diagnostics. It is the generated-export feedback loop one level up, and it degrades quietly. Diagnostic *insights* may enter memory through exactly one door: a human writes a curated note. The raw traces never do.

## 9. Testing discipline

- **Provider qualification fixtures** (3–5): synthetic session in → note lands, routes correctly, links sanely. Guards quiet degradation on small local models.
- **Origin qualification fixtures:** every new integration ships 3–5 golden content-events + expected outcomes.
- **Negative recall fixtures** (every fixture set asserts what recalls *and what must not*): similarly-named projects don't contaminate each other; a superseded decision is not preferred over its newer curated replacement; cross-repo episodic notes don't leak; broad queries don't inject stale daily notes; secret-like content is redacted before append; generated exports are not re-ingested.
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

- Directory layout: `~/.librarian/data/` (event + note logs, sacred), `~/.librarian/diagnostics/` (deletable), `~/.librarian/machine-id`, `~/.librarian/config.json` (§14), vault wherever the user keeps it (`generated/` + `curated/`).
- Note-log layout: monthly append-only segments `notes/{yyyy-mm}.ndjson`, never rewritten. Cursors reference `{file_path, byte_offset}`.
- `machine_id`: generated once, persisted; never the hostname.
- **V1 is single-machine, by declaration.** ULIDs make records collision-safe; the eventual answer is per-machine log segments. Deferred with it: `daily:{date}` cross-machine collision.

## 12. Roadmap

**Status (2026-07-06):** items 1–5 complete (issues #2–#9, #16–#21). The post-item-5 recall calibration gate (#24) is in progress. Item 6 is next, decomposed into issues #28–#32 with blocking chains on the issues themselves.

1. ✅ `schema/event.md` — prose + types + golden examples (§10.1).
2. ✅ `schema/note.md` — same (§10.2).
3. ✅ Specify curated-note ingestion + generated-file exclusion + diagnostics isolation (short doc; the three structural invariants together).
4. ✅ **Walking skeleton:** fixture events → renderer → LLM distill (`claude -p`, hard-coded) → note log → Obsidian export → BM25 index → recall query with floor + weights + injection trace. Ugly internals, real data. Revise the note schema from what the skeleton teaches. **Diagnostics log and injection traces start here** — recall telemetry is computed from them.
5. ✅ Curated Markdown → human distiller → note log → index → recall (with human weight).
6. ⏳ Real instrumentation (OpenCode first — existing plugin remapped to canonical schema; Claude Code second). *Next — issues #28–#32.*
7. **MCP server (pull path):** search tool (scored results, origin/scope filters) + **provenance drill-down tool** (note → verbatim event excerpts).
8. Recall injection adapters (push path: OpenCode two-phase hook design; Claude Code parity). Injected-block contract per §6; `librarian why` / `why-not` land here.
9. Hardening: cursors, locks, retries, quarantine, `librarian drain`.
10. Second inference provider (OpenAI-compatible ⇒ local) and second exporter (SQLite mirror) — after the first path works end-to-end.
11. First non-agent integration (when concretely wanted): `ContentEvent` + per-origin profile + origin fixtures.

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
- `backlog/<task>.md` files are written to be picked up by a coding agent in a fresh session, not executed by the author directly. Each carries a spec-section pointer, a "do not relitigate" header naming the settled decisions in play, and a done-check runnable in ≤15 minutes. See `backlog/README.md` for the full convention.

**Config file location**
- `~/.librarian/config.json`. Rejected `~/.config/librarian/config.json` (XDG) for consistency with this project's own settled housekeeping (§11): data (`~/.librarian/data/`), diagnostics (`~/.librarian/diagnostics/`), and `machine-id` already share one dotfolder root. Splitting config out to a second, OS-idiomatic location buys generic-Linux-citizenship at the cost of the property that root is built to have — `rm -rf ~/.librarian` cleanly removes everything, same as the SSH-agent / Ollama precedent §1 already invokes. No XDG override; add one later only if a real user asks for it.

**Dogfooding**
- "Build sessions get recorded" is real but bootstrapped, not immediate: recording requires a Claude Code instrumentation adapter, which is roadmap step 6 (§12) — before that, there is nothing to instrument with. From step 6 onward, backlog work done in an interactive Claude Code session on a machine with the adapter installed is captured in Librarian's own event log; that is the actual dogfooding moment, not a property that holds from day one.
- Stated plainly so it isn't mistaken for a gap later: this only applies where the adapter can attach a hook in a persistent home directory. Ephemeral/headless agent runs (CI, one-shot remote containers with no persistent `~/.librarian`) are not expected to be captured — dogfooding is a developer-machine property, not a CI property.

## 15. Open items (known, deferred, not blocking — all with named triggers or preserved escape hatches)

- `ContentEvent` shape + per-origin distiller profiles (trigger: first non-agent source).
- Re-ranking pass (trigger: negative fixtures show distractor injections despite the floor). Before vector search.
- Vector/hybrid search (trigger: BM25 + re-ranking proves insufficient; `search_text`/schema escape hatch preserved).
- OTLP export of diagnostics; timing spans (trigger: wanting an external tracing backend / something feels slow).
- Log compaction/GC; gzip of closed segments (trigger: size on disk matters).
- Multi-machine sync via per-machine segments (trigger: second machine).
- Entity identity for links; episodic consolidation (deferred together — the entity-resolution problem).
- Distiller prompts (routing, note-type selection, per-origin salience) — implementation work, fixture-validated.