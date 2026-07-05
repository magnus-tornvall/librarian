# Structural invariants

Three rules the design leans on. Each is enforced by directory layout or record shape —
by construction — not by the good behavior of future code (§4: "structural invariants beat
policy invariants"). This doc names each rule together with which mechanism enforces it and
which backlog task implements that mechanism.

## 1. Generated/curated split

The vault splits into two directories with opposite ownership:

- `vault/generated/**` — exporter-owned. Deterministic paths, `librarian_generated: true`
  frontmatter plus a `<!-- librarian:generated; do not edit -->` marker, overwritten freely
  on every export run.
- `vault/curated/**` — human-owned. Ingested by the human distiller, always stamped
  `origin: "human"`.

**The invariant:** generated files are excluded from curated ingestion by directory, not by
frontmatter inspection. The human-distiller importer refuses to even look inside
`vault/generated/**` — it is not a matter of checking for the `librarian_generated` marker
and skipping matches, it is a matter of never walking that directory in the first place. No
mixed-ownership regions inside one Markdown file, ever (§5 "Human curation").

**Enforcing mechanism:** the curated importer's directory scope (it only reads
`vault/curated/**`). This importer is not in the current backlog — task 008 (this doc)
documents the invariant; the importer itself is a later, unnumbered task.

## 2. Diagnostics isolation

The diagnostics log (injection traces, distill verdicts, quarantine events) is structurally
isolated from memory, enforced three separate ways (§8):

1. **Placement.** Diagnostics live at `~/.librarian/diagnostics/`, outside the data-log root
   (`~/.librarian/data/`) and outside the vault. Never rendered into the vault in any form
   (no debug-dashboard exporters). Freely deletable at any time with zero replay
   consequences — the opposite retention story from the sacred event/note logs.
2. **Poison-pill.** Diagnostic records carry `record_class: "diagnostic"` and deliberately do
   not conform to the canonical event shape. Every ingestion-side validator — collector,
   human-distiller importer — hard-rejects them: quarantine-with-error, not silent skip.
3. **Fixture.** A diagnostics file fed to the collector must produce a loud rejection,
   exercised as a standing test fixture (§9's diagnostics-rejection fixture).

**Rationale:** self-observation entering memory creates a reflexive loop — the system
forming memories about its own memory behavior, which influence recall, which generates new
diagnostics. Diagnostic *insights* may enter memory through exactly one door: a human writes
a curated note about them. The raw traces never do.

**Enforcing mechanism:** task 014 (`validate-event` module) implements the poison-pill
hard-rejection at the collector; the fixture from mechanism 3 is exercised there.

## 3. Distill-only ingestion

Nothing enters the note log without a distiller's judgment. There are exactly two
distillers, `llm` and `human` — no generic import path exists, not even for
already-condensed machine content. Machine-produced content of any kind passes through the
LLM distiller; there is no side door for "this is already a summary, just append it."

**Why:** the distiller is admission control, not compression — one writer discipline, one
quality gate, one narrow waist into the note log (§5 "Ingestion: distill-only, two
distillers"). Collapsing that into "anything structured enough can skip the gate" would
reopen the low-signal-note problem the design is built to avoid.

**Enforcing mechanism:** task 020 (Obsidian exporter) only ever writes to
`vault/generated/**`, so exported content can never re-enter as curated input; the LLM
distiller (task 018) and the curated-note importer (§1 above, not yet a numbered task) are
the only two write paths into the note log, by construction — no third path exists in the
codebase to bypass.
