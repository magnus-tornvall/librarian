# Triggers — the named conditions the design waits for

> Extracted from the design spec (was §15). The spec links here; this file is the
> durable home. **Optimised for agents:** stable ids, one subject per file, greppable.

Every deferral in this design is gated on a **named condition** rather than a date or a
priority. A trigger is not a task and not a status — it is a durable design fact about
what would have to become true before a piece of work becomes correct to build. It
outlives whatever eventually unlocks it, which is why it lives in the spec and never on
an issue.

**Ids are permanent.** `T-07` means the same thing in this file, in
`docs/architecture/librarian.c4`, and in any issue that says "blocked by T-07". Add
freely; never renumber, never reuse.

**Direction of reference, one way only:** an issue points at an architecture view, a view
points at a trigger or decision entry here, and an entry points at the reasoning. Nothing
in the spec or the model ever points forward at an issue — issues die, these do not.

## Register

| ID | Fires when | Unlocks | Reasoning |
|----|------------|---------|-----------|
| <a id="T-01"></a>**T-01** | The first non-agent source is actually wanted | `ContentEvent` shape + per-origin distiller profiles | [decisions](./decisions.md) *deleted/deferred* · spec §12 item 11 |
| <a id="T-02"></a>**T-02** | A genuinely different context arrives that a coding-session vocabulary would distil badly (an email source) | Mode system reconsidered; claude-mem's mode-file shape is the design to study | [decisions](./decisions.md) |
| <a id="T-03"></a>**T-03** | The first inference path proves out | Second inference provider + SQLite-mirror exporter (roadmap item 10) | spec §12 |
| <a id="T-04"></a>**T-04** | The SQLite mirror lands | `Exporter` interface, shaped from the working `exportNoteToVault` signature | below |
| <a id="T-05"></a>**T-05** | First external contributor, or first publish | Contracts barrel, `docs/extending.md`, conformance helpers; deferred `package.json` metadata | spec §14 · below |
| <a id="T-06"></a>**T-06** | Negative fixtures show distractors surviving hybrid + the relevance floor | Re-ranking pass (the escalation, not the first response) | [decisions](./decisions.md) · below |
| <a id="T-07"></a>**T-07** | Endpoint friction proves real — a user who will not run Ollama wants hybrid | In-process ONNX embedding provider | below |
| <a id="T-08"></a>**T-08** | `librarian stats` shows duplicate NOOPs against near-TTL notes at a meaningful rate | Corroboration-extends-TTL (12.5, parked); the lazy novelty-gate variant first | [decisions](./decisions.md) |
| <a id="T-09"></a>**T-09** | A real, flowing, note-granular outcome signal exists to calibrate against | Reopens outcome-linked note worth (12.3, closed — do not reopen without this) | [decisions](./decisions.md) |
| <a id="T-10"></a>**T-10** | A second machine | Per-machine log segments, `created_by_machine`, and the deterministic-ID revision-fork resolution rule | below |
| <a id="T-11"></a>**T-11** | Two importers ingest the same curated file (likely fires *before* T-10) | Curated-vault sync collision rule | below |
| <a id="T-12"></a>**T-12** | A second user | Team memory: separate shared store, per-peer recall weights, visibility structural not per-record | below |
| <a id="T-13"></a>**T-13** | A second host that genuinely needs in-process code (a real Cursor/Zed/Aider plugin) | Packaging the OpenCode plugin file — two call sites, then generalise | spec §14 |
| <a id="T-14"></a>**T-14** | First external adopter | Cross-platform distribution: per-OS/arch matrix, public download channel, signing/notarization, signed release feed | below |
| <a id="T-15"></a>**T-15** | A secret or private record is discovered in the event log | `librarian purge-event-range --rewrite-segment` — rare, loud, audited outside memory | below |
| <a id="T-16"></a>**T-16** | The first renderer change after real traces exist | Rendered block, or renderer version + hash, stored in the injection trace | below |
| <a id="T-17"></a>**T-17** | Wanting spans in an external tracing backend, or something feels slow | OTLP export of diagnostics; timing/latency spans | [decisions](./decisions.md) · below |
| <a id="T-18"></a>**T-18** | Size on disk matters | Log compaction/GC; gzip of closed segments | below |
| <a id="T-19"></a>**T-19** | Demand for editing *in Obsidian* specifically | Vault-edit detected → prompt to convert into a human revision. Never silent region merging | [decisions](./decisions.md) |

Each trigger appears in `docs/architecture/librarian.c4` as a `trigger` element carrying
its id and a link back to this file, so the frontier views and this register cannot drift
apart without one of them being visibly wrong.

## The open items in full

The reasoning behind each deferral, kept verbatim from the spec.

- `ContentEvent` shape + per-origin distiller profiles (T-01; trigger: first non-agent source).
- **Re-ranking pass — demoted behind hybrid (2026-07-16, reverses the v2 ordering).** (T-06) A cross-encoder re-ranker has the same architectural cost as query embedding (an inference call in the recall hot path) while being slower per query (N candidate passes vs. one embedding); once 14.1 exists, hybrid is the cheaper first response to recall misses, and re-ranking becomes the escalation if hybrid + floor still admit distractors. The spirit of the original ruling (cheapest intervention first, fixtures decide) is unchanged; the ordering it implied is not. (The former vector-search trigger bullet is superseded outright: semantic search is MVP scope — §5, §12 item 14.)
- **In-process embedding provider (T-07; ONNX via `@huggingface/transformers`, e.g. Voyage 4 Nano — research preserved in issue #97):** deferred alternative to the endpoint provider (14.1). It removes the external-process dependency at the cost of a native onnxruntime dependency plus ~255MB model-cache management, in a package that is currently daemon-free and dependency-light. Trigger: endpoint friction proves real — a user who won't run Ollama/LM Studio wants hybrid. Same seam, so flipping the default later costs nothing in design; the digest-pinning rule applies unchanged (pin the HF model revision).
- **Rejected claude-mem features (2026-07-15/16, recorded so they are not relitigated):** resident worker/daemon (the persistent index solves the hot path — §4); viewer UI (Obsidian is the viewer; the vault export *is* the UI budget); teams/multi-user server schema (the team-memory ruling below stands); any second store, Chroma or otherwise (vectors live in the same SQLite file as FTS5 or not at all — a second store buys a sync subsystem, refused); inline per-region curated/private ownership tags in exported files (§5 human-curation reaffirmation — the merge-engine problem); mode-system adoption now (§5 deleted/deferred — declined; per-origin-profiles trigger unchanged).
- OTLP export of diagnostics; timing spans (T-17; trigger: wanting an external tracing backend / something feels slow).
- Log compaction/GC; gzip of closed segments (T-18; trigger: size on disk matters).
- Multi-machine sync via per-machine segments (T-10; trigger: second machine). The trigger unlocks, together: per-machine log directories (cursor format `{file_path, byte_offset}` already survives the reshuffle), `created_by_machine` on note revisions (backfillable from `~/.librarian/machine-id` — that's why it isn't day-one), and the real design work: a resolution rule for deterministic-ID revision forks — two machines revising `project:{slug}:summary` produce revisions sharing a `previous_revision_id`, and latest-wins-by-ULID is silent last-write-wins. `user_id` stays out of the schema: unknown-field tolerance + read-time defaults make it retrofittable, and ownership may end up derived from a `machine_id → user` config map rather than stored per-record.
- Curated-vault sync collision (T-11; trigger: same, but likely fires *first*): users sync Obsidian vaults via iCloud/Syncthing today, so two importers ingesting the same curated file (same declared `note_id`) is probably the first multi-machine collision encountered — before a second event-log machine exists.
- Team/shared memory (T-12; trigger: second user). Decision recorded now so it isn't relitigated later: visibility is **structural, not a field** — private memory lives in personal logs, team memory is a separate shared store synced like a git remote; recall queries both. No `visibility: private|team|public` per-record field: placement can't leak via a forgotten filter (§4, structural invariants beat policy invariants). **Peer-mesh shape (recorded 2026-07-10, still trigger-gated):** peer memory = a read-only directory of foreign note-log segments per peer, synced by whatever the user already syncs files with (Syncthing, git, iCloud — the sync layer is someone else's app; no daemon, per §4). Engagement is opt-in and local: a peer store exists only if configured. Trust is per-peer recall weights — one more factor in the §6 weights mechanism (`origin: "peer:alice"` → `{ "peer:alice": 1.2 }`), which gives per-person trust across multiple meshes for free. Peer notes never enter the local note log, so the distiller narrow waist is never bypassed — but they also skip local admission gates, and recall-time weights are a prior, not a guard (§6 amendment): the honest defense is structural separation, a visible `[peer:x]` provenance tag in injected blocks, and a conservative default weight (<1.0) until the user raises it.
- Entity identity for links; episodic consolidation (deferred together — the entity-resolution problem).
- Distiller prompts (routing, note-type selection, per-origin salience) — implementation work, fixture-validated.
- **Emergency event-log purge** (T-15; from the 2026-07-04 GPT-5.5 review, folded 2026-07-10): append-only stays the default invariant, but a false-negative redaction, private paste, or legally sensitive record needs an honest recovery path. Shape: `librarian purge-event-range --rewrite-segment` — rare, loud, deliberately breaks replay purity, records a local audit note outside memory. Trigger: first discovered secret or private record in the event log.
- **Rendered block in the injection trace** (T-16; same review, folded 2026-07-10): traces record candidates, scores, and the config snapshot but not the final rendered `<librarian-memory>` block, so a renderer change makes old traces unreproducible. Store the rendered block (diagnostics are deletable, so size is fine) or a renderer version + hash. Trigger: first renderer change after real traces exist.
- **Composability seams** (T-04, T-05; from `composability-seams-handoff.md`, folded 2026-07-10 — the doc itself is deleted; its rejected-abstractions rulings duplicate §5): `Exporter` interface extraction (trigger: SQLite mirror, roadmap item 10 — shape it from the working `exportNoteToVault` signature, likely a `makeObsidianExporter(vaultDir)` factory; add tombstone export with the first tombstone producer). Contracts barrel (`src/contracts.ts` re-exporting `InferenceProvider`, `Exporter`, schema types — if it's not in the barrel, it's internal), `docs/extending.md`, and conformance helpers (`assertProviderQualifies`, `assertExporterIdempotent`) — trigger: first external contributor or first publish. Standing rulings that survive the doc: no unified push/pull recall interface, no `Distiller`/`Instrumentation`/`Renderer` interfaces, no provider registry.
- **Public cross-platform distribution** (T-14; from the 2026-07-23 packaging session; the single-platform binary + guided wizard is active work in the *Packaging & guided setup* epic). Deferred: the per-OS/arch binary matrix, a public download channel (Homebrew/Scoop + a `curl | sh` / `.ps1` installer for a general audience), code-signing / macOS notarization, and a signed release feed for self-update (signature-verified, downgrade-protected). Trigger: first external adopter — informed by the SEA PoC's single-file-vs-sidecar finding, which decides whether the shipped artifact and its updater are one file or a bundle.
