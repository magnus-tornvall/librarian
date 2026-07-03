# Handoff: OTel-Inspired Redesign of an AI Memory System ("Librarian")

**Purpose of this document:** Design review by a second model. The design below emerged from analysis of an existing system (SuperBrain) plus two rounds of architectural discussion. Please critique it: find flaws, blind spots, over-engineering, under-specification, and anything that will hurt at implementation time. Concrete asks are at the end.

**Reviewer context:** The author is an experienced .NET/PHP developer with a strong KISS philosophy — file-over-app, vendor-agnostic, minimal abstraction, deliberate coupling. This is a personal side project (learning + scratching an itch), not a product. Judge the design against those values, not enterprise ones.

---

## 1. Background: the system being redesigned

[SuperBrain](https://github.com/m3talux/superbrain) (v0.11.0, verified from source at commit `571a738`) is a personal memory system for AI coding agents. Verified architecture:

**Write path:** Claude Code hooks (`PostToolUse`/`UserPromptSubmit`, no LLM in the hot path) → append events to `~/.superbrain/sessions/{sid}.ndjson` → deterministic salience scorer adds markers → checkpoint hooks (Stop/PreCompact/SessionEnd) acquire a lockfile and spawn a **detached** `sb-distill` subprocess → distiller runs `claude -p` over the event delta (byte cursor per session) → routes generated notes into an Obsidian vault (`projects/`, `decisions/`, `people/`, `daily/`, `capture/`, `meta/`) → calls `indexNote()` per written note (index freshness is welded to distill).

**Event schema (NDJSON, one JSON object per line):**
```json
{"type":"prompt","cwd":"/abs/path","prompt":"...","ts":"ISO8601"}
{"type":"tool","cwd":"...","tool":"Write","command":"(Bash only)","file":"(file tools)","ts":"..."}
{"type":"salient","reason":"write_threshold|git_commit|cwd_switch|pushback","cwd":"...","files":[],"prompt_excerpt":"≤200 chars","ts":"..."}
```

**Recall path:** hybrid index at `~/.superbrain/index.db` — SQLite FTS5 BM25 (contentless) + sqlite-vec int8 KNN over local static embeddings (`minishlab/potion-base-8M`, hand-rolled model2vec inference). `hybridRecall`: RRF fusion → project/global boost → recency decay `exp(-ageDays/90)` → archive penalty → project-scoped recall with ~25% global slots, fail-closed on untagged notes. Injection: SessionStart digest, per-prompt top-5 (~500 tokens), mini-brief every 10 turns, on-demand MCP search server.

**Key operational details:**
- Orphan sweep: a reconcile job scans all session logs (idle ≥ 3h, size > cursor, < 3 attempts) — this is what lets a foreign agent (OpenCode) write events and get them distilled without owning the trigger.
- The distiller does not self-acquire the lock; the checkpoint caller passes a lock token via env to the detached child (cross-process release-by-token).
- `claude -p` usage is pure completion — prompt in, text out, no tool loop.
- Project identity is derived per-event from `cwd` → git root → basename slug, resolved *late* (at distill/recall time). Wrong slug ⇒ silent degradation to global-only recall.
- Sessions with 0 salience markers, 0 write tools, <2 prompts, <10 events are skipped entirely.
- Tool names are Claude Code-cased (`Write`/`Edit`/`Bash`); foreign instrumentations must map their own names to these.

**Prior work by the author:** a working OpenCode plugin that appends events to SuperBrain's NDJSON logs (write side verified end-to-end via the orphan sweep), plus a fully researched recall-injection design for OpenCode (two-phase hook pattern: compute on `chat.message`, splice an ephemeral tagged part on `experimental.chat.messages.transform`).

---

## 2. The redesign: motivation

SuperBrain is an implicit pipeline with hard-coupled stages. The author wants to rebuild it as an explicit, composable pipeline inspired by OpenTelemetry concepts (signals, instrumentation, resources, context, processors, exporters, collector), so that:

- Adding a new agent (Claude Code, OpenCode, Codex, ...) = write an instrumentation adapter.
- Swapping storage (Obsidian vault → SQLite → anything) = write an exporter.
- Swapping the LLM used for distillation (`claude -p` → OpenCode CLI → local Ollama endpoint) = swap an inference provider. Goal: a 100%-local, open-source-only configuration must be possible.
- It's a fun learning project. Ground-up rebuild is a conscious choice (abandoning the earlier "vendor small parity modules from upstream" strategy).

## 3. Where the OTel analogy holds and where it was rejected

**Adopted:**
- **Instrumentation** (per-agent adapters, thin, zero domain logic) — strongest fit; two adapters effectively already exist.
- **Semantic conventions** — a written canonical event schema with normalization rules (agent-native tool name → canonical name + category like `file_write`/`vcs_commit`). Considered the highest-leverage cheap artifact; kills the tool-name-casing fragility.
- **Resource vs Context** — Resource = `{agent, agent_version, machine, project_slug, git_root}` resolved **once at instrumentation time** and stamped on the stream; Context = `{session_id, turn, cwd}`. This deliberately fixes SuperBrain's late-slug-resolution silent failure.
- **Processors** — salience scoring, noise filtering, redaction: stateless stream processors.

**Rejected/modified:**
- **OTel is write-only; memory is a loop.** Recall/injection has no OTel analog. The loop is closed by a domain component: the **Librarian** (see below).
- **The distiller is not a processor.** It's an expensive, deferred, LLM-driven batch consumer with offsets (byte cursors), locks, retry counters. Its true analog is a log consumer, not a span processor.
- **The vault is not a dumb sink.** In SuperBrain the storage format leaks upward: distiller prompts emit Obsidian-flavored markdown, and the chunker/anchors/recall excerpts assume that shape. Fixing this is a core goal of the redesign (structured note intermediate; rendering moves to exporters).
- **No daemon.** Collector remains a library + CLI invoked lazily by instrumentations (detached child processes), matching SuperBrain's current model. A resident collector is deferred indefinitely; the event log makes it a pure addition later.
- **No actual OTel machinery** (OTLP, protobuf, real Collector) — inspiration only.

## 4. The agreed architecture

**Two append-only logs with independent, cursor-tracking consumers (event-driven eventual consistency):**

1. **Event log** (NDJSON, per session) — raw canonical telemetry from instrumentations. Source of truth.
2. **Note log** — append-only structured notes emitted by the distiller. The distiller is a consumer of the event log; exporters and the indexer are consumers of the note log, each with independent cursors.

**The Librarian** is the domain core and the owner of the **note schema** (type, title, links, provenance back to session/events, body, project scope). The distiller is the only writer of that schema; recall is the only reader. Everything upstream is telemetry plumbing; everything downstream is serialization.

**Consequences accepted:**
- Fan-out atomicity problems dissolve: a lagging/failed exporter replays from its cursor. No cross-sink transactions.
- Hard requirement from day one: **stable note IDs** (content-hash or `{session, seq}`) and **idempotent exporters** (overwrite-by-ID, never blind append). Cheap now, miserable to retrofit.
- The indexer is demoted to "just another note-log consumer" — recall freshness becomes an explicit tunable rather than being welded to distill.
- **Read-your-writes does not hold**: a session's own notes are not searchable until distill + index consumers run. (Already true in SuperBrain; now stated as a system property.)

**Interface sketch (TypeScript, Bun runtime assumed):**
```ts
// Instrumentation → event log (per-agent, dumb)
interface EventSink { append(e: CanonicalEvent): void }

// Librarian owns the domain
interface Librarian {
  distill(log: EventLogReader, provider: InferenceProvider): Note[]  // → note log
  recall(q: Query): Scored<Note>[]                                   // ← derived index
}

interface InferenceProvider {
  complete(prompt: string, opts: { schema?: JsonSchema }): Promise<string>
}

// Note log → sinks (each with own cursor, idempotent by note.id)
interface NoteExporter { export(n: Note): void }
```

**Inference provider details:**
- Contract is pure completion + "return JSON matching this schema" with validation and one retry-with-error-feedback.
- Implementations: `claude -p`, `opencode run -m <model>`, any OpenAI-compatible HTTP endpoint (⇒ Ollama/llama.cpp ⇒ fully local).
- Known risk: distiller prompts are tuned against a frontier model; small local models degrade *quietly* on salience judgment, routing, and note quality. Mitigation: a **provider qualification suite** — synthetic session log in, assert not just that a note lands but that it routes correctly and links sanely. Structured-output fumbling by local models is the loud failure; quality degradation is the quiet one.

**Search: BM25-over-SQLite-FTS5 is blessed as the one canonical index — no recall provider abstraction.** Rationale: compose where two real implementations exist (instrumentation, inference, exporters); hard-code where only one does. Vector/hybrid search deferred until BM25 proves insufficient. The author judges this an easy refactor later and lacks the search-domain expertise to design the abstraction well now.

**Roadmap ordering (revised during discussion):**
1. Spec: canonical event schema + semantic conventions + Resource/Context.
2. **Note schema + note log — the spine** (moved up from "expensive last milestone"; it is the domain contract everything hangs on).
3. Collector-as-library wrapping distill flow; inference provider abstraction.
4. Exporters: Obsidian vault writer first (porting existing markdown rendering *into* it), SQLite second.
5. Recall + injection-side instrumentation (OpenCode design already researched; Claude Code parity).

## 5. Open questions and known tensions

- **Note schema design** is recognized as the make-or-break artifact and has *not* been designed yet — only its field categories (type, title, links, provenance, body, scope).
- **Note updates vs append-only:** SuperBrain's distiller *updates* existing vault notes (e.g., appending to project notes, daily notes). An append-only note log must represent this — revision events? new note versions superseding by ID? This is unresolved and likely the hardest schema question.
- **Salience scorer placement:** processor at instrumentation time (SuperBrain's model, keeps distill-skip heuristics cheap) vs collector-side consumer (keeps instrumentations dumber). Leaning instrumentation-side for parity, not firmly decided.
- **Locking/cursor infrastructure:** SuperBrain's cross-process lock-token handoff (checkpoint acquires, detached child releases via env) doesn't fit off-the-shelf lockfile packages. Rebuild vs redesign trigger model is open.
- **Injection budgets** (per-prompt ~500 tokens, digest slots) were treated as recall-side implementation detail, not yet part of any interface.
- **Contradiction on record:** this rebuild abandons the earlier "no fork, vendor parity modules, smoke-test against upstream" strategy. Chosen consciously (learning project), but the author loses upstream bug-fix flow.

## 6. Asks for the reviewing model

1. **Attack the note schema problem.** Given the update-vs-append-only tension in §5, what schema/versioning model would you use? Event-sourced notes (note = fold of note-events)? Snapshot + supersede? Something simpler?
2. **Find the over-engineering.** The author's KISS philosophy is the constitution here. Which abstractions in §4 would you delete or defer? Is the two-log design justified for a single-user, single-machine system, or is it résumé-driven design?
3. **Find the under-specification.** What will bite at implementation time that this document hand-waves? (Candidates: cursor/lock semantics, note-log file format, multi-machine sync via git, schema migration/versioning.)
4. **Challenge the blessed decisions:** BM25-only recall, no daemon, instrumentation-side salience, Resource resolved at instrumentation time. Any of these wrong?
5. **Sanity-check the roadmap order.** Is note-schema-second correct, or should a walking skeleton (one instrumentation → distill → one exporter, hard-coded) come before any spec work?
6. Anything else you'd flag that neither the author nor the previous reviewer caught.
