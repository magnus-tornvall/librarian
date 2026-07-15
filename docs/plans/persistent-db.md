# Persistent Recall Index

## Problem

Recall currently creates an in-memory SQLite database, migrates it, reads the
entire note log, and rebuilds FTS for every query. Push injection then reads the
note log a second time to hydrate the matching notes. The same rebuild appears
in pull recall, `why-not`, and the novelty gate.

This makes warm prompt injection O(vault), even when the note log has not
changed. It also conflicts with the settled architecture: the indexer is a
note-log consumer that owns one blessed SQLite index, while recall performs
read-only database access.

The existing index cursor is only scaffolding. `indexNotes` never reads it and
always records offset zero. The exporter's record-count cursor still discovers
new work by reading the complete note log, so reusing it would not remove the
O(vault) work.

## Outcome

Maintain one disposable index at:

```text
<dataDir>/index.db
```

For the default data directory this is `~/.librarian/data/index.db`.

The ownership boundary is:

```text
note writers -> append note log
index triggers -> consume pending note-log bytes into index.db
inject/recall -> open index.db read-only
```

Prompt injection is read-only and eventually consistent. It neither scans the
note log nor catches up the index. The committed index cursor supplies
`indexed_through`, making its freshness visible.

The note log remains canonical. Deleting `index.db` and running `librarian
drain` recreates it.

## Design

### Database

Keep `notes_fts` and add two small pieces of durable derived state:

- `note_state`: the latest revision or tombstone for each `note_id`, including
  the serialized current record and supersession metadata.
- A singleton index cursor: current note-log segment, byte offset, last record
  ID, and update time.

`note_state` is needed for correctness and prompt latency:

- A tombstone removes its FTS row but must remain known so an older revision
  cannot revive it.
- Query results can be rendered without rereading the note log.
- Session-start summaries and curated notes can be selected without bypassing
  SQLite.

Store the cursor in SQLite rather than the existing JSON cursor file. FTS
changes, state changes, and cursor advancement must commit in one transaction;
an external cursor cannot provide that boundary.

Use `PRAGMA user_version` for the derived schema. An unsupported version is
rebuilt from the note log instead of accumulating a migration framework for
replaceable data.

### Incremental Consumption

Replace the full-log implementation of `indexNotes` with a note-specific
incremental consumer:

1. List monthly note segments in lexical order.
2. Resume from the cursor's segment and byte offset.
3. Parse complete NDJSON lines through the stable end observed for this pass.
4. Continue from offset zero through any newer segments.
5. Apply records and advance the cursor in one SQLite transaction.

Preserve current semantics:

- Revisions and tombstones compete by `created_at`; the later append wins a
  timestamp tie.
- A later revision can revive a tombstoned note.
- The earliest applicable supersession closes the note's validity interval.
- Missing-origin and malformed revisions remain fail-closed.
- An incomplete final line is ignored until a later pass completes it.

If the cursor points beyond a truncated file, its segment disappeared, or its
state is otherwise invalid, rebuild the derived database. Canonical log errors
still fail loudly.

### Transactions And Concurrency

Configure WAL and a bounded busy timeout. Run each index pass under `BEGIN
IMMEDIATE` so concurrent indexers serialize and readers observe either the old
complete snapshot or the new complete snapshot, never a delete-before-insert
intermediate state.

Recall connections use `readonly: true` and `fileMustExist: true`.

### Index Triggers

Indexing is explicit and remains outside the canonical `appendNote` primitive:

- Synchronize before a novelty query. This lets later distill iterations see
  notes appended by earlier iterations.
- Synchronize after `distill` completes so the final appended note is indexed.
- Synchronize after curated import, tombstone, and supersession commands.
- Run the indexer from `librarian drain`, whether or not vault export is
  configured.

Do not make a successful note-log append depend on a successful derived-index
write. If indexing fails after an append, report that the note is durable and
the index is stale; `librarian drain` is the recovery path.

### Read Paths

Replace fresh in-memory rebuilds in:

- Push injection
- Pull recall and MCP recall
- `why-not`
- Novelty lookup

Push injection, pull recall, and `why-not` open the persistent database
read-only. Novelty first runs its explicit index trigger, then queries the
resulting database.

Hydrate recall results from `note_state`. Query the same table for session-start
project summaries and curated notes. Remove `readAllNotes` from all warm recall
paths and derive `indexed_through` from the committed cursor rather than the
current time.

A missing or incompatible database produces an actionable instruction to run
`librarian drain`. Existing installations bootstrap once during upgrade by
running that command; normal note-producing commands also create the database
through their index trigger.

## Implementation Order

1. Add the persistent schema, database path helper, and read-write/read-only
   open functions.
2. Add the incremental segmented-log reader and transactional index pass.
3. Add regression tests for persistence and delta application.
4. Wire explicit write-side and drain triggers.
5. Move injection, recall, `why-not`, and novelty to the persistent database.
6. Move result hydration and session-start selection to `note_state`.
7. Update recovery documentation to identify `index.db` as disposable.
8. Run the full build and test suite, then measure warm injection with a large
   generated note log.

## Verification

Keep the checks focused on the new boundary:

1. Bootstrap from an existing note log, close the database, reopen it, and
   recall the same note.
2. After bootstrap, make the note-log directory unavailable and verify warm
   query and session-start injection still work.
3. Verify an unchanged index pass is a no-op and does not move the cursor.
4. Append a revision, tombstone, revival, and supersession; verify each delta
   updates persisted state and recall correctly.
5. Verify month rollover and an incomplete trailing line preserve cursor
   correctness.
6. Verify a read-only connection sees only committed snapshots while another
   process indexes.
7. Verify `--data-dir` uses only `<dataDir>/index.db`.
8. Delete `index.db`, run `librarian drain`, and verify complete recovery.
9. Verify warm injection performs no O(vault) note-log read.

## Deferred Decisions And Triggers

Do not add these without their trigger:

| Defer | Trigger |
| --- | --- |
| Daemon or filesystem watcher | Measured freshness delay is unacceptable and writes occur outside Librarian commands |
| Recall or index provider abstraction | A second supported index actually exists |
| Connection pool | MCP profiling shows database open/close is material |
| Configurable index location | A user needs the derived index separated from `dataDir` |
| Per-segment cursor map | Backdated cross-month appends become supported |
| Checksums or log manifests | Logs can be rewritten without truncation or path changes |
| Automatic corruption repair or backup generations | A real corruption incident makes delete-and-drain inadequate |
| Historical note mirror in SQLite | A query needs revision history without consulting the canonical log |
| Optimizing stats, export, or `note show` | Profiling shows those non-prompt paths matter |
| Vector or hybrid search | Existing negative fixtures trigger the documented search-upgrade threshold |

## Non-Goals

- No daemon.
- No cache layer in front of SQLite.
- No generic consumer framework or generalized log cursor rewrite.
- No index configuration surface.
- No change to note-log authority or append-only semantics.
- No optimization of unrelated full-log administrative commands.
