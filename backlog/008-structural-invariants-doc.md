# 008 — docs/specs/structural-invariants.md

**Phase:** 2 — Structural invariants
**Spec pointer:** `docs/specs/librarian-design-consolidated.md` §5 ("Human curation", "Ingestion: distill-only, two distillers"), §8 (Diagnostics isolation), §11 (Housekeeping)
**Do not relitigate:** these three invariants are already decided — this task documents them together as roadmap item 3 (§12) asks, it does not design them. Do not propose a fourth invariant or generalize these into a rule-engine/plugin system (§5 "Deleted / deferred" already rejects generic frameworks here).

## Context

Roadmap item 3 (§12): "Specify curated-note ingestion + generated-file exclusion + diagnostics isolation (short doc; the three structural invariants together)." The spec's own framing (§4) is that these matter because "structural invariants beat policy invariants" — enforced by directory layout and record shape, not by future code behaving well. This doc is where that argument gets made concretely for these three cases, as a standalone reference later tasks (014, 020) implement against.

## Task

Create `docs/specs/structural-invariants.md` with three sections:

1. **Generated/curated split.** `vault/generated/**` (exporter-owned, deterministic paths, `librarian_generated: true` frontmatter + `<!-- librarian:generated; do not edit -->` marker, overwritten freely) vs `vault/curated/**` (human-owned, ingested by the human distiller, `origin: "human"`). State the invariant explicitly: generated files are excluded from curated ingestion by directory, not by frontmatter inspection — the human-distiller importer should refuse to even look inside `vault/generated/**`.
2. **Diagnostics isolation.** `~/.librarian/diagnostics/` lives outside `~/.librarian/data/` and outside the vault; diagnostic records carry `record_class: "diagnostic"` and every ingestion-side validator hard-rejects them (quarantine-with-error, not silent skip). Cross-reference §8's three enforcement mechanisms (placement, poison-pill, fixture) — name all three, don't summarize down to one.
3. **Distill-only ingestion.** Nothing enters the note log without a distiller's judgment (`llm` or `human`); no generic import path exists even for pre-condensed machine content. State why: one writer discipline, one quality gate (§5).

For each section, state which later backlog task is expected to enforce it in code (008 documents; 014's validator hard-rejects diagnostics; 020's exporter only ever writes `generated/`; the curated-importer's directory refusal isn't in this backlog yet — say so, don't invent a task number for it).

## Done-check

```
test -f docs/specs/structural-invariants.md
grep -c "generated" docs/specs/structural-invariants.md
grep -c "diagnostic" docs/specs/structural-invariants.md
grep -c "distill" docs/specs/structural-invariants.md
```
Expect: file exists, each grep returns a non-zero count (all three topics present). Read it back once and confirm each section names its enforcing mechanism, not just the rule.
