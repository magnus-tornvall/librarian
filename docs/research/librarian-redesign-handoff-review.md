# Review: Librarian Redesign Handoff

## High-Severity Findings

1. **The note schema is the real architecture, and it is missing.** Until the note schema is nailed down, most other abstractions are speculative. The hard part is not "structured notes"; it is defining what counts as a durable memory unit, how it changes, and what recall searches over.

2. **Stable note IDs are underspecified.** A content hash is bad for logical identity because edits change the ID. `{session, seq}` is stable but prevents later consolidation of the same project/person/decision memory. Use two IDs: `note_id` for logical identity and `revision_id` for immutable versions.

3. **The append-only note log conflicts with SuperBrain-style aggregate notes.** If project notes and daily notes are mutable aggregates, the note log cannot just be "distiller emitted Note[]". It needs full snapshot revisions, note events, or a different model where exporters assemble aggregate pages from smaller immutable memory records.

4. **Cursor and lock semantics are implementation-critical, not plumbing.** This system lives or dies on exactly-once-ish replay, poison records, partial writes, crashes, and stale locks. If this remains hand-waved, the redesign will regress from SuperBrain despite being cleaner conceptually.

5. **Resource resolved at instrumentation time fixes one bug but creates another.** If instrumentation stamps the wrong `project_slug` once, the error becomes durable. Better: stamp raw facts at instrumentation time, especially `cwd`, `git_root`, repo remote, branch, and machine; derive `project_slug` deterministically later but cache it explicitly.

## Recommended Note Model

Use **snapshot revisions**, not full event-sourced notes.

Avoid event-sourced note internals unless the project explicitly wants to build a mini database. It is more elegant than useful here.

Recommended model:

```ts
type NoteRecord =
  | {
      kind: "note_revision";
      schema_version: 1;
      note_id: string;       // Stable logical identity.
      revision_id: string;   // Immutable content/revision identity.
      previous_revision_id?: string;
      created_at: string;
      supersedes_at?: string;

      note_type: "fact" | "decision" | "project_summary" | "person" | "daily" | "episode";
      title: string;
      scope: {
        project_slug?: string;
        git_root?: string;
        global?: boolean;
      };

      provenance: {
        session_id: string;
        event_ids: string[];
        event_range?: { from: string; to: string };
        source_agent: string;
      };

      links: Array<{
        target_type: "note" | "entity" | "project" | "file" | "url";
        target: string;
        relation?: string;
      }>;

      body: {
        summary: string;
        bullets?: string[];
        details?: string;
      };

      search_text: string;
    }
  | {
      kind: "note_tombstone";
      schema_version: 1;
      note_id: string;
      revision_id: string;
      previous_revision_id: string;
      reason?: string;
      created_at: string;
    };
```

Core rule: **the note log is append-only, but logical notes are latest-revision-wins by `note_id`.**

This gives the system:

- Append-only durability.
- Idempotent exporters.
- Simple replay.
- Easy schema migration.
- No diff/patch format.
- No need for event-sourced note folding.

For existing SuperBrain-style "append to project note" behavior, avoid literal appends. Instead:

- Emit small durable notes: decisions, facts, project observations, people, episodes.
- Let the Obsidian exporter render aggregate pages from the latest note set.
- If a project summary is needed, make it a `project_summary` note with a stable `note_id` like `project:{project_slug}:summary`, and emit full replacement revisions.

That keeps mutation out of exporters and avoids LLMs editing markdown blobs.

## Over-Engineering To Delete Or Defer

Keep the **two-log design**, but make it brutally concrete and file-based. It is not resume-driven if the goal is independent distill/export/index replay. It solves a real SuperBrain coupling problem.

Defer or delete these:

- **Generic `Librarian` interface.** It is too abstract this early. Build concrete functions first: `distillEventsToNotes`, `indexNotes`, `recall`.
- **Exporter abstraction beyond one interface.** Keep the concept, but do not design a plugin system. Start with `exportNoteRevision(record)`.
- **Inference provider abstraction polish.** Keep a minimal command/provider adapter, but avoid schema-negotiation sophistication until the first provider works.
- **Multiple storage backends.** Obsidian exporter first, SQLite index second. Do not build a generic storage layer.
- **Provider qualification suite as a framework.** Good idea, but start as 3-5 golden fixture tests, not a harness.

Keep these:

- Canonical event schema.
- Semantic conventions.
- Two logs.
- Stable note/revision IDs.
- Independent cursors.
- Idempotent exporters.

Those are not fluff; they prevent expensive rewrites.

## Under-Specified Areas That Will Bite

1. **Event IDs.** Every event needs a durable `event_id`. Provenance cannot rely on byte offsets alone.

2. **File append safety.** Define whether appends are atomic, how partial JSON lines are handled, whether writers use temp files, whether fsync matters, and what happens on interrupted writes.

3. **Cursor semantics.** A cursor should advance only after successful processing. Store at least `{log_file, byte_offset, record_id, updated_at}`.

4. **Poison record handling.** If one event or note crashes a consumer forever, replay stalls. You need retry count, quarantine, or skip-with-error-log.

5. **Lock ownership.** Define stale lock recovery, PID checks, token ownership, timeout, and whether lock release by detached child is still desired.

6. **Schema versioning.** Put `schema_version` on both event records and note records from day one.

7. **Log compaction.** Append-only logs eventually need compaction or snapshotting. Even if deferred, define that consumers read canonical logs and compaction preserves replay semantics.

8. **Idempotency contract.** Exporters need exact rules: overwrite by `note_id`, by `revision_id`, or render latest folded state? For Obsidian, overwrite generated files by deterministic path.

9. **Entity identity.** Links to people/projects/files need stable identity rules. Otherwise recall and aggregation will fragment.

10. **Redaction timing.** If raw event logs are source of truth, secrets may become immortal. Redaction must happen before durable append or immediately as a first-stage processor with clear trust boundaries.

11. **Multi-machine/git sync.** If logs can sync through Git, Dropbox, etc., the system needs collision-safe IDs and monotonic ordering that does not rely on local clocks.

12. **Index freshness.** If the indexer is an independent consumer, recall should expose freshness metadata: "indexed through note log offset X".

## Challenged Decisions

### BM25-Only Recall

Reasonable for v1. This is the correct KISS call. But design the note schema so vector search can be added later: clean `search_text`, titles, tags, links, project scope, timestamps. Do not abstract recall yet.

### No Daemon

Reasonable. The SuperBrain lazy-detached model already proves the pattern. But still provide a single `librarian drain` command that processes pending event logs, note logs, exports, and indexes. That becomes the manual recovery/debug tool.

### Instrumentation-Side Salience

Do not put real salience there. Instrumentation should classify events cheaply: `file_write`, `vcs_commit`, `prompt`, `cwd_change`. Let the collector/distiller decide salience from canonical events. Otherwise every adapter inherits domain behavior and drifts.

Compromise: instrumentation may add cheap hints, but they should be non-authoritative:

```ts
hints: {
  possibly_salient?: boolean;
  reason?: string;
}
```

### Resource Resolved At Instrumentation Time

Stamp facts early, derive identity later. Store both if useful, but do not trust `project_slug` as canonical.

Recommended resource:

```ts
resource: {
  agent: string;
  agent_version?: string;
  machine_id: string;
  cwd: string;
  git_root?: string;
  git_remote?: string;
}
```

Then derive project scope during distill/index:

```ts
scope: {
  project_slug: string;
}
```

## Roadmap Recommendation

The current roadmap is mostly right, but avoid writing a complete spec in isolation.

Better order:

1. Define minimal canonical event schema.
2. Define minimal note revision schema.
3. Build a walking skeleton: one fake/session fixture -> distill -> note log -> Obsidian export -> BM25 index -> recall.
4. Add OpenCode or Claude instrumentation.
5. Add cursor/lock/retry hardening.
6. Add second exporter/provider only after the first path works.
7. Expand semantic conventions based on actual adapter pain.

The walking skeleton should come before polishing the spec, but not before the note schema. The note schema is the spine.

## Most Important Design Correction

Do not model "notes" as Obsidian pages.

Model them as **memory records**. Obsidian pages are a rendered view.

That distinction resolves much of the update-vs-append tension. Project pages, daily pages, and people pages can be generated aggregates. The durable memory layer remains append-only, structured, replayable, and searchable.

If that boundary stays clean, the redesign is justified and still KISS. If not, the system will recreate SuperBrain's coupling with more interfaces.
