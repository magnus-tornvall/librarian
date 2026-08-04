# Structural invariants

Four rules the design leans on. Each is enforced by directory layout, record shape, or a
single chokepoint every caller routes through — by construction — not by the good behavior
of future code (§4: "structural invariants beat policy invariants"). This doc names each
rule together with which mechanism enforces it and which backlog task implements that
mechanism.

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

## 4. Settle before distill

**The invariant:** a session's delta is distillable only when the session has settled.
Distill never processes a delta whose newest hook-stamped event `ts` is younger than
`distill.settleMs`, unless the delta ENDS on a terminal boundary marker — an event that
says the arc is over, not merely paused. The last event, not any event: a resumed session's
log continues past its old marker, and a superseded boundary must not vouch for the work
that came after it. A held-back delta is *deferred, not judged*: the
cursor stays exactly where it was, a `deferred` diagnostic records why, and the next pass
reconsiders the same bytes. It is never a `skipped` verdict — "not yet eligible" and
"judged not worth distilling" are different facts, so `deferred` is excluded from the
admission rates `librarian stats` reads (§12.10); conflating them would corrupt the
noop/skip rates that are the tuning instrument.

**This is concurrency safety, not quality.** `runDistill` sweeps *every* pending session,
not the one that triggered it, so without an eligibility rule a drain fired for session A
distills session B while B is still being worked in. That — not distill quality — is what
the gate exists to prevent, and it is what makes a global drain safe to fire from anywhere,
at any time. No quiet-period threshold can prevent a mid-arc split: a real pause longer than
the threshold always trips it, at any value. The value is therefore deliberately not
load-bearing, which is why the default is generous (24 h). Over-waiting costs almost nothing
under this design; under-waiting distills live work.

**The clock is the event's own `ts`, never file mtime.** mtime is not the event clock — it
moves with unrelated writes and does not survive a copy or a sync. That clock is external
and can be wrong in either direction, and neither failure may cost more than the gate is
worth: a delta whose events carry **no parseable `ts`** counts as settled outright, and a
**future-dated `ts`** — a machine whose clock runs ahead, a real case once logs are synced
between machines (§15) — must cost at most one settle window, not the length of the skew.
A bad clock may delay a session; it may never wedge one.

**Enforcing mechanism:** the check sits at the top of `runDistill`'s per-session loop, ahead
of the content skip heuristic — a live session is not eligible to be judged at all, so it
must not reach a heuristic that would judge it. Every trigger — `librarian drain` today, any
automatic trigger later — is the same function call over the same loop, so no trigger can
carry an eligibility policy of its own.
