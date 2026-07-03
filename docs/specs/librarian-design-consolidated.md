# Librarian — Consolidated Design Handoff

**Date:** 2026-07-03. **Status:** design converged after three review rounds (Claude Fable 5 ↔ GPT-5.5). This document is standalone: a fresh session needs no prior context. Next action is implementation, starting with the two schema files.

**Author context:** experienced .NET/PHP developer, strong KISS philosophy — file-over-app, vendor-agnostic, minimal abstraction, deliberate coupling. Personal side project (learning + scratching an itch). Judge all future proposals against those values.

---

## 1. What Librarian is

A personal memory system for AI coding agents, redesigned from [SuperBrain](https://github.com/m3talux/superbrain) (v0.11.0, source verified at commit `571a738`) into an explicit, composable pipeline inspired by OpenTelemetry concepts — but with a domain core ("the Librarian": distill + recall) that OTel has no analog for, because telemetry is write-only and memory is a loop.

**Goals:**
- Add a new agent (Claude Code, OpenCode, Codex) = write a thin instrumentation adapter.
- Swap the distillation LLM (`claude -p` → `opencode run` → local Ollama/llama.cpp endpoint) = swap an inference provider. A 100%-local, open-source-only configuration must be possible.
- Obsidian remains the human-facing view, but is no longer the canonical storage.
- Conscious ground-up rebuild (abandons the earlier "vendor parity modules from upstream SuperBrain" strategy; upstream bug-fix flow is knowingly lost).

**Prior working assets:** an OpenCode plugin that writes events into SuperBrain's NDJSON format (verified end-to-end via SuperBrain's orphan sweep), and a fully researched OpenCode recall-injection design (two-phase hook: compute on `chat.message`, splice ephemeral tagged part on `experimental.chat.messages.transform`, open-thread pointers on `experimental.session.compacting`; avoid `system.transform`).

## 2. Relevant SuperBrain facts (for reference)

- Write path: agent hooks (no LLM) → NDJSON per session → deterministic salience markers → checkpoint hooks acquire lockfile, spawn **detached** `sb-distill` child (lock token passed via env; child releases) → `claude -p` over event delta (byte cursor per session) → notes routed into Obsidian vault → `indexNote()` per note.
- `claude -p` usage is pure completion: prompt in, text out, no tool loop.
- Recall: SQLite FTS5 BM25 + sqlite-vec hybrid, RRF fusion, project/global boost, recency decay `exp(-ageDays/90)`, fail-closed on untagged notes. Injection: session-start digest, per-prompt top-5 (~500 tok), 10-turn mini-brief, MCP search server.
- Distill-skip heuristic: sessions with 0 salience markers, 0 write tools, <2 prompts, <10 events are skipped.
- Known SuperBrain bug class being fixed: project slug derived late from `cwd` at distill time ⇒ silent degradation to global-only recall when wrong.

## 3. Architecture (settled)

**Two append-only logs, independent cursor-tracking consumers, event-driven eventual consistency:**

1. **Event log** — canonical, normalized, **redacted-before-append** telemetry from instrumentations. NDJSON per session. Source of truth for raw activity.
2. **Note log** — structured memory records emitted by the distiller and the curated-note importer. The distiller is a consumer of the event log; the indexer and all exporters are independent consumers of the note log.

**Core principle (the design's spine): durable memory records are the domain layer; Obsidian pages are a rendered view or a curated input — never the canonical model.** If this boundary stays clean the redesign is justified and still KISS; if not, it recreates SuperBrain's coupling with more interfaces.

**Component roles:**
- **Instrumentation** (per-agent, dumb): map native events → canonical schema, stamp Resource facts, emit cheap non-authoritative salience hints, append. Zero domain logic.
- **Collector** (library + CLI, **no daemon**): normalize → redact → validate → append. Owns distill triggering (lazy, detached-child model as SuperBrain proves). Owns authoritative salience and the distill-skip heuristic, computed from canonical event categories. Stamps note provenance (see §6.1).
- **Distiller**: LLM consumer of the event log via an inference provider; only writer of distilled note records.
- **Curated-note importer**: converts human-authored Markdown → note records directly. **Never routes human notes through the LLM** — the human already performed the distillation.
- **Indexer**: note-log consumer; owns the one blessed index (SQLite FTS5 BM25); derives `search_text` by fixed concatenation rule (not stored in records).
- **Exporters**: note-log consumers; idempotent by `note_id` (render latest revision at deterministic paths). Obsidian exporter first, SQLite mirror second.
- **Recall**: BM25 query + scoring (project/global boost, recency decay), read-only DB access; feeds per-agent injection adapters.
- **`librarian drain`**: CLI command that processes everything pending (event logs → distill, note log → export + index). The manual recovery and debug tool; more important than any daemon.

## 4. Decisions register (all settled — do not relitigate without new information)

**Identity & revisions**
- `note_id` = stable logical identity; `revision_id` = immutable version (ULID). `event_id` also ULID.
- Snapshot revisions, latest-revision-wins by `note_id`. No event-sourced note internals, no diff/patch format.
- **V1 revision rule:** only deterministic-ID notes may be revised (`project:{slug}:summary`, `person:{normalized_name}`, `daily:{yyyy-mm-dd}`, `curated:{id}`). The distiller may fetch a prior revision **only by deterministic ID** — never search for "probably related" notes and mutate them. Everything else is episodic: `{type}:{ulid}`, one revision, immutable forever. Semantic consolidation of episodic notes into logical ones is deferred (it is the entity-resolution problem; solving it would turn the distiller into a recall client).
- Tombstones exist in the schema from day one; v1 emitters are CLI/human actions only, never the distiller.

**Human curation (critical — protects the existing file-over-app workflow)**
- Vault split: `vault/generated/**` (exporter-owned, deterministic paths, frontmatter `librarian_generated: true` + `<!-- librarian:generated; do not edit -->` marker, overwritten freely) vs `vault/curated/**` (human-owned, ingested by the importer, converted to records with `source.kind: "human"`).
- **Invariant:** generated files are excluded from curated ingestion (prevents the system ingesting its own rendered output — feedback loop).
- No mixed-ownership regions inside one Markdown file. Ever.
- Recall boosts human-authored records above LLM-distilled records, all else equal.

**Resource & salience**
- Instrumentation stamps **facts**: `agent`, `agent_version`, `machine_id`, `cwd`, `git_root`, `git_remote`, `git_branch`. It does **not** stamp authoritative `project_slug`; project scope is derived deterministically at distill/index time from stamped facts and cached in note `scope`. (Fixes SuperBrain's silent-slug bug without making a wrong early guess durable.)
- Instrumentation may emit `hints: { possibly_salient?, reason? }` — non-authoritative. Canonical salience lives in the collector/distiller.

**Search & injection**
- BM25-over-SQLite-FTS5 is the one blessed index. No recall provider abstraction. Schema must not block later vector search (clean derived search text, titles, links, scope, timestamps), but nothing more.
- `search_text` is **not** a record field; the indexer derives it: `join([title, body.summary, ...bullets, details, scope.project_slug, scope.git_remote, ...links.map(l => `${l.target_type}:${l.target}`)])`.
- Recall exposes freshness metadata ("indexed through note-log offset X").

**Durability & safety**
- Redaction happens **before durable append** — the only truly non-retrofittable requirement (secrets in an append-only replayable log are immortal). Pipeline: native event → normalize → redact → validate → append. Redaction preserves correlation without the secret: `[REDACTED:token:sha256:abc123]`. Applies to prompts as well as commands.
- Cursors: `{consumer, log_name, file_path, byte_offset, last_record_id?, updated_at}`; advance only after successful processing.
- Bounded retries; poison records quarantined with debug context; partial trailing JSON lines ignored until completed.
- Detached workers: explicit lock ownership, stale-lock recovery (PID/token checks, timeout). SuperBrain's cross-process release-by-token pattern is retained conceptually; off-the-shelf lockfile packages don't fit it.
- `schema_version` on every event and note record from day one.
- Log compaction deferred, but defined: consumers read canonical logs; any future compaction must preserve replay semantics.

**Deleted / deferred (over-engineering guardrail)**
- Generic `Librarian` interface → concrete functions (`distillEventsToNotes`, `indexNotes`, `recall`).
- Generic storage layer; exporter "plugin system" (one interface: `exportNoteRevision(record)` is enough).
- Inference-provider schema-negotiation sophistication (contract: completion + "return JSON matching schema" + validate + one retry-with-error-feedback).
- Provider qualification *framework* → 3–5 golden fixture tests (synthetic session in; assert note lands, routes correctly, links sanely). Known risk being tested: prompts tuned on frontier models degrade *quietly* on small local models.
- Distiller-driven tombstones; episodic consolidation; daemon.

## 5. Schemas (draft — to become `schema/event.md` and `schema/note.md`)

Each schema file = prose + TypeScript types + 3–5 golden JSON examples. Golden examples are the real test of concreteness.

### 5.1 Canonical event

```ts
type CanonicalEvent = PromptEvent | ToolEvent | SessionEvent;

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
  tool: { native_name: string;                       // e.g. "Write" (Claude Code) / "write" (OpenCode)
          canonical_name: "read" | "write" | "edit" | "bash" | "search" | "unknown";
          category: "file_read" | "file_write" | "command" | "search"
                  | "vcs_commit" | "vcs_push" | "other" };
  command?: string;                                  // redacted before append
  files?: Array<{ path: string; action: "read" | "write" | "edit" | "delete" }>;
};

type SessionEvent = EventBase & { type: "session"; action: "start" | "stop" | "compact" | "checkpoint" };
```

Golden examples: (1) prompt in a git repo; (2) file edit → `file_write`; (3) `git commit` via bash → `vcs_commit`; (4) redacted command containing a token; (5) session checkpoint.

### 5.2 Note record

```ts
type NoteRecord = NoteRevision | NoteTombstone;

type NoteRevision = {
  kind: "note_revision"; schema_version: 1;
  note_id: string; revision_id: string;              // revision_id: ULID
  previous_revision_id?: string;                     // required only when revising/tombstoning
  created_at: string;
  identity: { mode: "deterministic" | "episodic"; key?: string };
  source: { kind: "distiller" | "human"; agent?: string;
            source_path?: string; content_hash?: string };
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

Golden examples: (1) episodic decision from distiller; (2) deterministic project-summary rev 1; (3) same, rev 2 with `previous_revision_id`; (4) human curated note imported from Markdown; (5) tombstone via CLI.

## 6. Final refinements (added in last review round — incorporate into the schema files)

1. **Provenance is collector-stamped, never LLM-authored.** The distiller prompt presents events with ordinal indexes; the LLM cites indexes; the collector maps indexes → `event_id` ULIDs and stamps `provenance` mechanically. Same principle as derived `search_text`: mechanical fields belong to code. Without this, `provenance.event_ids` is hallucination-grade.
2. **Curated identity survives renames.** `curated:{path_hash}` breaks when files are reorganized (routine in an Obsidian vault). Rule: curated frontmatter may declare an explicit `note_id`; path-hash is the fallback for unannotated files; the importer detects renames via `content_hash` match and tombstones the orphaned old ID.
3. **V1 is single-machine, by declaration.** The vault/logs will be git-synced eventually; concurrent appends to one NDJSON file merge terribly. ULIDs already make records collision-safe; the eventual answer is per-machine log segments. Write "single-machine" into the spec so the constraint is a decision, not an accident. (`daily:{date}` cross-machine collision deferred with it.)
4. **Note-log file layout:** monthly append-only segments, `notes/{yyyy-mm}.ndjson`, never rewritten. Cursors reference `{file_path, byte_offset}`.
5. **`machine_id`:** generated once, persisted at `~/.librarian/machine-id`. Never the hostname.
6. **Curated importer body rule:** preserve the human Markdown body verbatim in `body.details`; derive `title` from H1 and `summary` from the first paragraph. No LLM normalization in v1.

## 7. Open items (known, deferred, not blocking)

- **Injection budgets and the recall/injection contract** (per-prompt token caps ~500, session-start digest slots, 10-turn brief) — researched for OpenCode but not yet specified as interfaces. Design when building roadmap step 8.
- Entity identity for links (people/projects fragmentation) — mitigated by the episodic-only rule in v1; real solution deferred with consolidation.
- Log compaction/GC; multi-machine sync; vector search — all explicitly deferred, all have preserved escape hatches in the schema.
- The distiller prompt itself (routing rules, note-type selection, quality) — implementation work, informed by SuperBrain's prompts; validated by the golden fixture tests.

## 8. Roadmap

1. `schema/event.md` — prose + types + golden examples (§5.1 + §6 refinements).
2. `schema/note.md` — same (§5.2 + §6 refinements).
3. Specify curated-note ingestion + generated-file exclusion invariant (short doc).
4. **Walking skeleton:** fixture events → distill (`claude -p` provider, hard-coded) → note log → generated Obsidian export → BM25 index → recall query. Ugly internals, real data. Revise the note schema from what the skeleton teaches — schemas designed on paper for LLM output tend to assume structure the model won't reliably produce.
5. Curated Markdown → importer → note log → index → recall.
6. Real instrumentation (OpenCode first — plugin write-side already exists and needs remapping to the canonical schema; Claude Code second).
7. Hardening: cursors, locks, retries, quarantine, `librarian drain`.
8. Recall injection adapters (OpenCode two-phase hook design from prior research; Claude Code parity).
9. Second inference provider (OpenAI-compatible endpoint ⇒ local) and second exporter (SQLite) — only after the first path works end-to-end.

Schema work precedes the skeleton, but at minimum viable depth only. The golden examples are the acceptance test for whether the design is concrete enough to build.
