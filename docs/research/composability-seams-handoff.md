# Librarian — Composability Seams Handoff

**Date:** 2026-07-05 (rev 3, after second GPT-5.5 review — Exporter extraction deferred to post-026, scoring-config wording aligned with task 023's actual contract, schema-revision gate added to sequencing, conformance-suite tense corrected). **Status:** proposal, reviewed against spec v4 — not yet settled. Companion to `docs/specs/librarian-design-consolidated.md` (the spec) and `docs/plans/implementation-plan.md` (the plan). If this document disagrees with the spec, the spec wins.

**Purpose:** Librarian's open-source north star (§1) requires that developers can see the replaceable components and implement their own. This document names exactly which seams get a formal interface, which get a data contract instead, which must NOT be abstracted (per §5's deleted/deferred list), and how the seams are made discoverable. It is written for a fresh Claude Code session with no prior context.

**Do not relitigate:** spec §5 ("Deleted / deferred") and §14 are settled. In particular: no generic `Librarian` interface, no generic storage layer, no exporter *plugin system* (one interface only), no recall provider abstraction, no provider registry/auto-discovery. Everything below is designed to fit inside those constraints, not around them.

---

## 1. Design stance

The composability story that fits this project is **few, small, spec-sanctioned seams with conformance fixtures** — not a plugin architecture. Replaceability comes in three flavors here, and conflating them is how over-engineering starts:

1. **Behavioral interface** (TS type, multiple implementations in-process): only where the spec itself names swappable implementations.
2. **Data contract** (schema + one entry point): where the "implementations" live in foreign processes and can't share a vtable anyway.
3. **Pure function + config** (swap by editing `config.json` or forking one function): where variation is parametric, not structural.

## 2. Behavioral interfaces (two now, one future)

Two interfaces exist within the current plan's scope (phases 0–3); a third is a **named future seam** that must not be built before roadmap item 8. Listing it here is documentation of intent, not license to implement.

### 2.1 `InferenceProvider` — settled, backlog task 017

```ts
export type InferenceProvider = {
  complete(prompt: string): Promise<string>;
};
```

One method, no schema-negotiation sophistication, no retry logic in v1 (§5 caps the eventual ceiling at completion + JSON-schema + validate + one retry). This is the flagship seam: `claude -p` → `opencode run` → local Ollama/llama.cpp is the 100%-local promise from §2. Task 017 ships the type plus `makeFixtureProvider` (test double). Real providers land in later tasks.

The provider qualification fixtures (§9, 3–5 synthetic sessions → note lands, routes correctly, links sanely) are **intended to become** this interface's conformance suite — they are spec discipline, not yet backlog tasks. See §5 of this document.

### 2.2 `Exporter` — spec-sanctioned in §5; **extraction deferred to after 026**

§5 is verbatim: "one interface: `exportNoteRevision(record)`." That is the eventual public seam. But note the current reality: **task 020 as written defines a concrete function, not this interface** — `exportNoteToVault(vaultDir: string, note): string` (synchronous, returns the written path, takes `vaultDir` explicitly). An earlier revision of this document recommended folding an interface extraction into 020 "at near-zero cost"; that was wrong. The proposed interface differs in shape (`Promise<void>`, no `vaultDir`, no return path), and reconciling those is a design decision (curry `vaultDir` into a factory? keep sync? keep the returned path for tests?) that should be made against a *working* exporter, not speculated now.

**Ruling: implement task 020 exactly as written. Extract the `Exporter` interface after 026, when the SQLite mirror (roadmap item 10) forces the question — shaped from the working 020 signature, likely as a factory:**

```ts
// Indicative only — final shape decided at extraction time, from the working code:
export type Exporter = {
  /** Idempotent by note_id — re-export of the same note_id must not create a second artifact. */
  exportNoteRevision(record: NoteRevision): void | Promise<void>;
};
export function makeObsidianExporter(vaultDir: string): Exporter; // wraps exportNoteToVault
```

**Tombstone export remains deferred, with a named trigger.** Tombstones exist in the *schema* from day one (§10.2), but v1 has no tombstone producer inside the walking skeleton — emitters are CLI/human only (§5), and no CLI task exists in the 001–026 backlog. Trigger: the first tombstone producer lands (the CLI tombstone command or the curated-importer rename path, roadmap item 5). Adding a method to a one-implementation interface at that point is cheap; adding it now is speculative.

Rules that belong in the interface's doc comment when it is extracted (not in each implementation's discipline):
- Idempotent by `note_id` (§4).
- May filter by `origin` — per-source vault views are exporter configuration (§4).
- **Never render diagnostics into the vault** (§8) — structurally moot if exporters only consume the note log, but state it.
- Generated output carries `librarian_generated: true` frontmatter + the do-not-edit comment where the target format supports it (§5, vault split).

Obsidian is the first implementation (via task 020's concrete function), SQLite mirror second (roadmap item 10). A third-party "export to Logseq / Notion / static site" author gets a tiny, obvious target — once the seam exists.

### 2.3 `recallForPrompt` — **FUTURE seam** (roadmap item 8; not in the current backlog)

The seam a new-harness developer (Cursor, Aider, …) will eventually need. **Nothing in tasks 001–026 implements this.** The walking skeleton deliberately keeps recall query (task 024, `src/recall/query.ts`) and injection trace (task 025, `src/diagnostics/injectionTrace.ts`) as **separate internal modules** — that split stands; this future wrapper composes them, it does not replace them.

When roadmap item 8 (push adapters) is exploded, the public wrapper should look approximately like:

```ts
export type RecallScope = {
  project_slug?: string;
  git_root?: string;
  global?: boolean;
};

export type ScoredNote = {
  note_id: string;
  revision_id: string;
  note_type: NoteRecord["note_type"];
  origin: string;
  score: number;            // post-weight, post-floor
  title: string;
  summary: string;
};

export type RecallResult = {
  injection_id: string;     // ULID, threaded into the block AND the trace (§8)
  block: string;            // rendered <librarian-memory> markdown, exact §6 shape
  records: ScoredNote[];    // for adapters that want structure instead of the block
  indexed_through: string;  // e.g. "notes/2026-07.ndjson:12345"
};

/** Returns null when nothing clears the relevance floor — the 0-of-0–5 case (§6),
 *  made unmissable in the type. Never force-fill. */
export function recallForPrompt(
  query: string,
  scope: RecallScope
): Promise<RecallResult | null>;
```

Design properties to lock in *at that point*:
- **The future public wrapper writes the injection trace** (calling 025's module), so no adapter can forget diagnostics (§8). This is a property of the wrapper, **not** a requirement on the skeleton's query seam — 024 stays trace-free, 026's integration test wires 024 + 025 explicitly, and that explicit wiring is the prototype for the wrapper.
- Push-path austerity (0–5 records, floor, budget, project-match requirement) is enforced inside the wrapper — adapters cannot loosen it.
- The MCP server (pull path) does **not** use this function — it has different physics (§6). Do not unify push and pull behind one interface; the spec deliberately splits them.

## 3. Data contracts (schema-as-interface, no polymorphism)

### 3.1 Instrumentation / integration

Spec §4: "An integration is just an event emitter." Instrumentations live in foreign processes (OpenCode plugin, Claude Code hook) — a TS `Instrumentation` interface is a category error. The replaceable-component story is:

- **The `CanonicalEvent` types** from `schema/event.md` (§10.1), published as public exports of the package.
- **One collector entry point:** `appendEvent()` from task 015 (library) and/or the collector CLI.
- **The golden examples** (`schema/examples/event/*.json`, task 004) as executable documentation.
- **Origin qualification fixtures** (§9): every new integration ships 3–5 golden content-events + expected outcomes — that IS the conformance test for a third-party adapter.

Do not create an `Instrumentation` TS interface. The contract is the schema plus the append entry point.

### 3.2 Human distiller input

Same pattern: the contract is curated Markdown + frontmatter conventions (§5 human curation, §10.2 rules), not an interface. Already fully specified in the spec; nothing to add.

## 4. Pure function + config (replace by editing, not implementing)

- **Scoring** (task 023): pure function taking a `ScoringConfig` argument, with `DEFAULT_SCORING_CONFIG` as an in-code constant — exactly as task 023 already specifies. **Loading `ScoringConfig` from `~/.librarian/config.json` is a separate, later backlog task** (it belongs with the wiring work, roadmap items 7–8, where the config hash in every injection trace (§8) makes tuning explainable); task 023 does no file I/O. No `ScoringStrategy` interface — §5's anti-generic stance applies. A developer who wants different scoring passes a different `ScoringConfig` or forks one pure function.
- **Renderers** (§7): per-task free functions that happen to share a module. An interface implies a registry implies a plugin system. Keep them concrete.
- **Redaction** (task 013): rule list may become config-driven someday; not a component interface. No change proposed.

## 5. Discoverability — three cheap moves

An interface nobody can find isn't composable. Proposed (all small, all deferrable per §6 sequencing below):

1. **A contracts barrel** — `src/contracts.ts` (or `src/contracts/index.ts`) re-exporting exactly: `InferenceProvider`, `Exporter`, `RecallResult`/`recallForPrompt` (when it exists), and the schema types (`CanonicalEvent`, `NoteRecord`, and members). **Rule: if it's not exported from the barrel, it's internal and may change without notice.** That one file is the composability documentation. It also becomes the package's public API surface at first publish (§14 defers publish decisions — the barrel doesn't front-run them, it just makes the eventual decision a one-liner).

2. **Conformance fixtures as importable test helpers.** To be precise about what exists where: the provider/origin qualification fixtures are a **spec-level discipline (§9), not yet backlog tasks** — phases 1–3 only contain golden schema examples (004/006/007) and the walking skeleton's fixture events (010). The helpers therefore need their own backlog task(s), after 026, and after the §9 fixtures themselves are exploded into tasks (they naturally land with the distiller/provider hardening work):
   - `assertProviderQualifies(provider: InferenceProvider)` — runs the 3–5 provider qualification fixtures against any implementation.
   - `assertExporterIdempotent(exporter: Exporter)` — same `note_id`/`revision_id` exported twice → exactly one artifact.
   - Origin qualification stays fixture-file-shaped (§9) since integrations are out-of-process.
   A developer implementing a local-model provider gets a runnable definition of "done" — the backlog philosophy (§14) applied to third parties.

3. **`docs/extending.md`** — one page, three sections: "add an agent" (schema + `appendEvent` + origin fixtures), "add an inference provider" (`InferenceProvider` + `assertProviderQualifies`), "add an exporter" (`Exporter` + idempotency fixture). Each section: contract, conformance fixture, spec section pointer. File-over-app: the doc points at code, it doesn't duplicate it.

## 6. Sequencing — what lands when

**Do not front-run the walking skeleton — and note the gate is two-part.** §12 item 4 / the plan's own closing note: after 026 merges, the note schema is *revised from what the skeleton teaches* before later roadmap items are exploded. "After 026" below therefore means **"026 merged AND the post-skeleton schema revision complete"** — freezing public contracts between those two points would fossilize exactly the shapes the revision exists to change.

| Item | When | Why |
|---|---|---|
| `InferenceProvider` | Task 017, as written | Already settled. No change. |
| Task 020 (`exportNoteToVault`) | As written, no additions | Concrete function per the plan; the interface question is answered later against working code. |
| `Exporter` interface extracted | After 026 + schema revision; latest by the SQLite-mirror task (roadmap item 10) | Shape decided from the working 020 signature (see §2.2); premature extraction was rev-2's mistake. |
| `exportNoteTombstone` method | With the first tombstone producer (roadmap item 5 / CLI tombstone command) | No producer exists in the 001–026 backlog; adding a method to a one-implementation interface later is cheap. |
| `ScoringConfig` file loading | Later backlog task (wiring work, roadmap items 7–8) | Task 023 is pure function + `DEFAULT_SCORING_CONFIG` constant only. |
| Contracts barrel | New backlog task, **after 026 + schema revision** | Its contents (esp. schema types) must survive the skeleton-driven revision first. |
| `recallForPrompt` / `RecallResult` | Roadmap item 8 explosion (push adapters) | The skeleton (024/025/026) will teach whether `RecallResult` has the right shape. Task 024's internal query function is the prototype; the public contract is extracted, not designed fresh. |
| Conformance helpers | With the contracts barrel, or first external-facing milestone | `assertProviderQualifies` needs the §9 fixtures to exist first (they land alongside the distiller work). |
| `docs/extending.md` | With the contracts barrel | Pointless before the contracts it points at are stable. |

## 7. Explicitly rejected (so a future session doesn't re-derive them)

| Abstraction | Verdict | Source |
|---|---|---|
| Recall/search provider interface | **No.** BM25-over-FTS5 is the one blessed index; the escape hatch is the schema, not polymorphism. | §5 |
| Generic storage layer (`Log` interface over ndjson/cursor) | **No.** Concrete functions. | §5 |
| `Distiller` interface | **No.** Exactly two distillers by design (narrow waist); the LLM distiller's variability lives entirely behind `InferenceProvider`. A `Distiller` interface invites the generic-import path §5 killed. | §5 |
| `Renderer` interface / registry | **No.** Free functions. | §7 + §5 anti-generic stance |
| `Instrumentation` TS interface | **No.** Out-of-process; the contract is schema + `appendEvent`. | §4 |
| Unified push/pull recall interface | **No.** Different physics by design. | §6 |
| Provider registry / auto-discovery | **No.** Explicitly barred in task 017's do-not-relitigate line. | 017, §5 |

## 8. Suggested next actions for the executing session

1. If working task 017: implement exactly as written; nothing here changes it.
2. If working task 020: implement exactly as written (`exportNoteToVault(vaultDir, note): string`). Do **not** add an interface, change the signature, or make it async — the interface extraction is deferred per §2.2 and §6.
3. After 026 merges **and the post-skeleton schema revision is complete** (§12 item 4 — this gate is two-part, not just "026 green"): draft new backlog files in the `backlog/README.md` format — likely `0XX-contracts-barrel.md`, `0XX-extending-doc.md`, and `0XX-conformance-helpers.md` — with Dependencies lines naming both 026 and the schema-revision outcome, spec pointers to §5/§9/§14, and this document as the design rationale. **In the same change, update `docs/plans/implementation-plan.md` and create the corresponding GitHub issue(s)** — the plan is the map and the backlog is the territory; adding territory without updating the map is exactly the divergence the plan's own header warns about. If they are instead deferred to a later roadmap explosion, mark them explicitly as post-plan roadmap tasks in this document rather than leaving them implied.
4. Anything here that conflicts with what the walking skeleton teaches: the skeleton wins. Update this document rather than quietly deviating (same rule the backlog README sets for the spec).
