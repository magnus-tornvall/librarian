# Recovery playbook

When a distill run crashes, contends with another run, or hits poison input, the
librarian pipeline is designed to recover on the next `librarian drain` with **no
duplicate notes and a byte-identical event log**. This is the human-facing side of
roadmap item 9 (issues #59–#63); the machine-facing proof is
`tests/hardening.capstone.integration.test.ts`.

## The one rule

`~/.librarian/diagnostics/` and stale lock files are **always safe to delete**.
`~/.librarian/data/` is **never** safe to delete.

- `data/` holds the two sacred append-only logs (`events/**`, `notes/**`) plus the
  cursors that track how far each consumer has read. Losing it loses memory.
- `diagnostics/` holds only bookkeeping (distill verdicts, injection traces). It is
  rebuilt as runs happen and never a source of truth.
- A lock file (`data/locks/distiller.lock`) that outlives its owner is a crash
  artifact. `drain` recovers a stale lock automatically; deleting one by hand only
  short-circuits that recovery. Never delete a lock while a distill/drain is running.
- `index/` contains only the disposable recall index. If it is missing, stale, or
  incompatible, delete it with `rm -rf ~/.librarian/index` and run `librarian drain`.
  The canonical note log in `data/` rebuilds `index/notes.db`.

## Reading a quarantine verdict

A delta that cannot be distilled — a corrupt event line, or a provider that fails
every retry — is quarantined: its bytes are recorded in a verdict and the cursor
advances past it so it never wedges the queue. Verdicts live under
`diagnostics/distill/<yyyy-mm>.ndjson`. List every quarantine with the named byte
range:

```sh
jq -c 'select(.decision=="quarantined") | {session_id, reason, quarantine}' \
  ~/.librarian/diagnostics/distill/*.ndjson
```

Each line names the offending log and byte range, for example:

```json
{"session_id":"s","reason":"unparseable event line at bytes 1840..1852: ...","quarantine":{"file_path":".../events/s.ndjson","byte_start":1840,"byte_end":1852,"attempts":null,"last_error":"..."}}
```

- `attempts: null` — an unparseable event line, quarantined immediately (no retry).
- `attempts: 3` — a provider that failed the whole retry budget before giving up.
- `byte_start`/`byte_end` — the exact slice of `file_path` that was skipped. Everything
  before and after it in the same session still distills normally.

## Re-attempting a quarantined delta

Quarantine advances the cursor past the bad bytes so healthy work is never blocked.
To retry a delta after fixing its cause (correcting a corrupt line, or a provider that
was misconfigured):

1. Find the session id from the verdict above.
2. Reset that session's distiller cursor so the delta is re-read:

   ```sh
   rm ~/.librarian/data/cursors/distiller/<session_id>.json
   ```

   Deleting the cursor is safe — a missing cursor is treated as offset 0 and the whole
   session replays. The **provenance guard** means already-distilled deltas are skipped
   rather than re-minted, so only the previously-quarantined delta produces a new note.

3. Re-run drain:

   ```sh
   librarian drain --vault ~/vault
   ```

## Crash recovery, in one command

There is no separate recovery mode. After any crash — a rolled-back cursor, a stale
lock, a half-written run — just run `librarian drain` again. It recovers the stale
lock, replays any un-committed delta, and the provenance guard keeps the note log free
of duplicates. Two concurrent `drain`s over the same backlog also converge to exactly
one set of notes.
