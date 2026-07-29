# Team Memory — Design Handoff

**Status:** proposal awaiting review. Nothing here is settled; the §15 trigger
("second user") has fired and this document is the candidate answer, written to
be reviewed by a fresh model with no prior session context.

**What the reviewer is asked to do:** attack the shape in §5–§7, and answer the
open questions in §9. The §2 rulings are settled and out of scope unless this
proposal contradicts one — in which case say so loudly, that is the most
valuable finding available here.

**Goal being served:** a small team (3–8 developers) collaborating through
shared memory, at the lowest achievable friction, where **each user owns their
memory and controls what leaves their machine.**

---

## 1. What Librarian is (context for a fresh reader)

An open-source personal context layer: a local, file-over-app memory system for
AI coding agents. Agent hooks append redacted telemetry to an **event log**; an
LLM **distiller** judges what is worth remembering and appends **notes**; an
**indexer** consumes the note log into one rebuildable SQLite index (FTS5 +
sqlite-vec); **recall** serves two paths — *push* (invisible per-prompt
injection, 0–5 notes, hard token budget) and *pull* (MCP tools). No daemon. All
storage under `~/.librarian`. Obsidian is a rendered view, never canonical.

Three storage classes matter below:

1. **Sacred logs** (`data/`) — append-only, replayable, never deleted.
2. **Diagnostics** (`diagnostics/`) — freely deletable, never ingested.
3. **Derived artifacts** (`index/`, vault `generated/`) — rebuildable at any
   time; deletion is safe and self-healing.

Full design: `docs/specs/librarian-design-consolidated.md`. Invariants:
`docs/specs/structural-invariants.md`.

## 2. Settled rulings this must respect (do not relitigate)

- **§15 team memory:** visibility is **structural, not a field**. No
  `visibility: private|team|public` per record — placement cannot leak via a
  forgotten filter. Team memory is a separate shared store; recall queries both.
  Peer memory = a read-only directory of foreign note-log segments per peer,
  synced by whatever the user already syncs files with. Trust = per-peer recall
  weights. Rejected: a teams/multi-user server schema, a resident daemon, a
  second store alongside the one blessed index.
- **§4 structural invariants beat policy invariants.** Where a rule matters,
  enforce it by construction — directory layout, record shape, validators.
- **§5 distill-only ingestion**, exactly two distillers (`llm`, `human`). The
  narrow waist has no side door.
- **§5 admission pipeline:** worth → novelty → faithfulness. **The verifier
  vetoes, never edits.** Every rejection fails closed.
- **§6 push physics:** 0–5 notes, never force-filled; a distractor is worse than
  an empty slot. Injected framing and authority labels are a **prior, not a
  guard** — only behavioral fixtures count as evidence a wording works.
- **§6 poisoning defense lives at admission**, never at the injected wording.
- **§5 identity follows the judgment, not the keyboard** (`revise_note`): a body
  the human approved verbatim is a human judgment, whatever channel carried it.
  Its honest defenses are provenance distinguishability and append-only
  recoverability.
- **§9 testing:** black-box integration fixtures only, plain files, no mocking
  framework. Every fixture set asserts what must *not* recall.

## 3. What the code says will hurt (verified against the tree)

Five findings; the first two are hard blockers for any sharing shape.

**3.1 Project identity is the silent killer.** `src/projectSlug.ts:5` derives
`project_slug` from the last path segment of `git_root`. Recall requires a
project match or explicit global scope (`src/recall/query.ts:144`). Two users
who cloned the same repo into differently-named directories produce two
different project scopes, so shared notes **recall nothing, with no error** —
the failure mode §6 calls worse than a distractor. The inverse also bites: two
unrelated repos both named `api` collapse into one scope, now across people.
`scope.git_remote` is already stamped on every note
(`src/distill/llmDistiller.ts:142-149`) and unused for identity. Remote-derived
project identity stops being a ponytail and becomes a prerequisite.

**3.2 The index is single-root by construction.** `indexNotes(db, dataDir)` has
a singleton cursor (`index_cursor WHERE id = 1`) carrying a `data_dir` column,
and a mismatch **wipes the entire index** (`src/index/indexer.ts:258-262`).
`note_state.note_id` is a global PRIMARY KEY. Consuming a peer's segments needs
a cursor per root — and hits an identity collision: deterministic IDs
(`project:{slug}:summary`, `daily:{date}`, `person:{name}`, `curated:{id}`) are
**identical across users**, and `applyRecord` resolves by latest `created_at`.
One peer's project summary silently overwrites another's. This is §15's
"deterministic-ID revision fork" with no owner to arbitrate.

**3.3 `origin: "peer:alice"` breaks the authority machinery.** `origin` means
*which surface produced it* (`claude-code`, `opencode`, `human`). Overloading it
with peer identity makes a peer's hand-curated note arrive as `peer:alice`
instead of `human`, losing the `human: 1.5` weight
(`src/recall/scoring.ts:20`) and the `high authority` label
(`src/recall/inject.ts:29-36`, which reads `source.distiller === 'human'`). Peer
identity wants to be a **third weight dimension derived from placement**, not a
value crammed into origin. This supersedes the shape §15 recorded in passing;
the *principle* (trust as one more factor in the weights mechanism) is unchanged.

**3.4 Sharing changes admission, not just recall.** `findNearDuplicate`
(`src/distill/noveltyGate.ts`) queries the same index that would hold peer rows,
so your distiller would begin NOOP-ing *your* notes as duplicates of a
teammate's — and if that teammate later unshares, nothing remains. Needs an
explicit ruling; today it would happen by accident.

**3.5 Foreign note_ids dead-end in the CLI/MCP surface.** `note show`,
`flag_note`, and `revise_note` resolve through the local note log
(`findLatestNote(dataDir, …)`, `src/cli.ts:1049`) and reject unknown ids — so a
peer note cannot be inspected or locally suppressed. `get_notes` works (it reads
the index). Provenance drill-down is *structurally* impossible for peer notes and
must degrade honestly: peers share notes, never event logs.

Smaller: the exporter's cursor is a **record count** over the local note log
(`src/export/exportRun.ts:84`), which peer records would corrupt; and the push
path's 0–5 slots are now contested by a second author.

**The asymmetry to exploit:** notes are shareable, events are not. Events hold
raw prompts and commands; notes are distilled from already-redacted events.
Sharing notes only is both the safe default and the cheap one.

## 4. Field survey (2026-07 web research)

| Tool | Scoping | Sharing |
|---|---|---|
| mem0 | `user_id` / `agent_id` / `run_id`, plus platform `org_id` / `project_id`; search returns what matches the ids you pass | `org_id` = shared across a deployment. No per-memory ACL — isolation *is* the filter |
| Zep / Graphiti | `group_id` namespaces every node and edge | "Group graphs": write org knowledge explicitly; search fans out over user + group graph |
| Cipher / ByteRover | Personal memory vs. **Workspace Memory** — a separate store, not a record flag | Explicit push/pull of team context; team sync via their cloud |
| Letta | Memory *blocks* attached to agents by id | One block attached to N agents = shared read/write. Read-only is per **block**, never per-agent |
| OpenMemory (local) | Per-app identity | Inverse model: pause/revoke a client at app or memory level, audit log of every read/write. Now sunset |
| claude-mem | project/type/date filters; `<private>` tags | None. Single-user; personal cloud backup only (a teams schema exists in the DB with no product on it) |
| Basic Memory | Markdown files; placement | No sharing feature. Documented team story is *put the vault in a git repo* |
| CLAUDE.md / AGENTS.md | Precedence by file location | A commit. Review is the PR |
| Claude (Team/Enterprise) | Per-user, project-scoped; admin can disable or edit summaries | Not a cross-user pool. Shared team memory is an open feature request |

Four takeaways:

1. **Scope-as-a-filterable-field is the dominant model and it is fragile.** The
   LlamaIndex/mem0 integration had a bug where passing both `user_id` and
   `agent_id` returned nothing — when correctness depends on always passing the
   right filter tuple, both leaks and silent-empty-recall are one mistake away.
   Independent convergence *against* it: every tool that actually ships sharing
   does it by writing to a different **place** (group graph, Workspace Memory,
   separate block, shared vault). §15's structural ruling is validated, not novel.
2. **Nobody solves "limit what I share" per record.** The strongest per-item
   permission in the field is Letta's read-only-for-everyone. Demand for
   per-recipient control appears thin; a coarse share/don't-share first cut is
   defensible.
3. **Promotion is explicit everywhere it exists.** No surveyed tool
   auto-publishes personal memory to a team.
4. **The file-in-git camp is what small teams actually adopt**, because the
   transport is a repo they already have and review is the gate.

Two honest notes. Librarian's differentiators are real: per-peer trust weights,
and the note/event asymmetry (mem0 and Zep ingest raw conversation server-side).
And the file-sync shape gives up something the server shapes have — **feedback**:
you can never learn which of your shared notes teammates actually used, because
their injection traces stay on their machines.

## 5. Chosen shape — published projections, consumed read-only

Each user publishes a **filtered projection** of their note log; each Librarian
consumes peers' projections read-only.

```text
local note log (sacred, private)
  → librarian share: rule → [critic] → dry-run diff → human confirm
    → projection: <share-root>/<author>/notes/*.ndjson   (derived, replaceable)
      → transport: the team's git repo (or any file sync)
        → peer roots consumed read-only at drain time
          → indexed with author identity → recall weights → [peer:x] in the block
```

Five load-bearing decisions:

- **A peer root is a derived artifact, not a sacred log** (§4's third storage
  class). This is the move §15 does not make, and it is what makes ownership
  real: unsharing works. Republish without the note and the consumer's next
  drain drops the row. Modelling a peer root as append-only instead would make
  every disclosure immortal on every teammate's disk.
- **Projections are per-author directories.** A single shared
  `notes/2026-07.ndjson` written by several people produces `.sync-conflict-`
  copies under file sync and silently loses records. Per-author segments also
  give peer identity for free, by placement.
- **Transport is the team's git repo** — a dedicated `team-memory` repo.
  Librarian writes files; a configured `syncCommand` runs the user's own
  `git pull`/`push`, so "the sync layer is someone else's app" survives. Git
  brings history, review, revocation, and access control with no new infra and
  nothing for a teammate to install.
- **Peer identity is a third weight dimension derived from placement**, not a
  value in `origin` (see 3.3). Default weight below 1.0 until the user raises it;
  `[peer:alice]` visible in every injected block. Per §6 the visible tag is a
  prior, not a guard — the guard is that peer notes never enter the local note
  log, so the distiller waist is never bypassed.
- **Peer ingest happens at drain time, never on the hot path**, preserving §4's
  contract (an injection performs zero index builds and zero full-log reads).

## 6. Control — who decides what leaves

Three mechanisms, expected to coexist:

| Mechanism | Friction | Risk |
|---|---|---|
| Per-note opt-in (`librarian share <note_id>`, or an MCP `share_note` so it lands in-flow) | Highest, paid at the moment of value | None |
| Deterministic rule (`project_slug ∈ {…}` ∧ `note_type ∈ {decision, project_summary, fact}` ∧ …) | Lowest | A misfiring rule leaks; mitigated by `--dry-run` |
| In-flow marker — `<team>…</team>`, mirroring the existing `<private>` primitive, collector-stamped | Very low | Coarse (session-level) |

`<private>` already never reaches the durable log, so sharing inherits that for
free. The dry-run diff *is* the review UI — `git add -p` for memory.

## 7. LLM-assisted share — critiqued, then narrowed

The question raised: could an LLM read some "share context" and *recommend* what
to project? Verdict: **not too invasive in principle, but the wrong polarity.**

Why the polarity matters:

- **Error costs are asymmetric.** A false negative costs a week's delay. A false
  positive lands private content in three teammates' git history, clones, and
  indexes — where the derived/replaceable property saves nothing. The analog of
  §6's "empty slot beats a distractor" is **an unshared note beats a leaked one**.
- **The judgment needs input the LLM does not have.** Worth-remembering (12.9) is
  content-local. "Should Alice and Bob see this" depends on which client the repo
  belongs to, whether a vendor is under NDA, whether a `person:` note carries a
  compensation remark, whether a teammate is a contractor. None of it is in the
  events or the notes. A hand-written share-context blob makes the judgment
  *possible* but goes stale silently, with no fixture able to detect that — the
  vacuous `config_snapshot` failure (#99) with a worse blast radius.
- **Injection becomes exfiltration.** Today a poisoned string in a repo can at
  worst get a bad note admitted, defended at admission per §6. If an LLM chooses
  what publishes, there is a path from *text in a repo you happened to work in* →
  note → recommender → data leaving the machine. Every existing defense governs
  what enters memory; none governs what leaves. §6's mechanistic finding kills the
  obvious mitigation: models internally flag injections and then ignore them.
- **The approval gate degrades exactly where it works.** §5's "identity follows
  the judgment" transfers structurally, but that ruling was acceptable because
  append-only recoverability means a bad revision destroys nothing. Disclosure is
  not recoverable, so the same mechanism does not clear the same bar. And 20
  pre-checked recommendations get rubber-stamped while 20 unchecked titles get
  read — a good recommender trains the user to stop looking.
- **The privacy gate would itself be a disclosure.** `inference.provider` is
  `claude` or `opencode` — remote. Shipping every candidate note body to a vendor
  to ask whether it is too sensitive for teammates is the objection a
  file-over-app user raises first.

**Narrowed shape — a withhold-only critic.** After the deterministic rule picks
the candidate set, an optional LLM pass may **only remove** notes from it, never
add:

- Reuses §5's *verifier vetoes, never edits* verbatim. The share set stays a
  deterministic function of the rule; the critic only subtracts.
- Fails closed: error, timeout, or unconfigured → withhold (or degrade to the
  plain diff for manual review), never auto-ship.
- Fixture-testable the way §9 demands: no fixture can assert "recommends the
  right things to share"; a fixture *can* plant a client name, a
  credential-shaped string, and a personnel remark and assert all three are
  withheld.
- Explainable: rule matched + critic passed is replayable; "a model chose this on
  Tuesday" is not. Only this version can ever support `librarian why-shared`.
- Complements rather than replaces, exactly as §5 frames `<private>` vs. secret
  regexes: declared intent, pattern detection, semantic critic — three threat
  models.

**Candidate ruling:** *the LLM may never add a note to a projection; it may only
withhold one. Sharing is a human act or a deterministic rule — reviewable before
it leaves, and fail-closed when anything is uncertain.*

## 8. Proposed phasing

**Phase 0 — prerequisites that pay for themselves alone.**
Remote-derived project identity (3.1); note lookup/flag/revise resolving through
the index so foreign ids degrade honestly instead of erroring (3.5). Both fix
latent single-user defects.
*Success signals:* two checkouts of one repo under different directory names
recall each other's notes in a fixture; a differently-named repo pair still
cannot cross-contaminate (negative fixture); `flag_note` on an id absent from the
local log suppresses it from recall instead of throwing.

**Phase 1 — the shape in §5, per-note opt-in plus a rule.**
Cursor-per-root indexing; author dimension in the index and the weights; peer
notes excluded from the novelty gate; `[peer:x]` in injected blocks;
`librarian share` with `--dry-run`; projection as a replaceable set.
*Success signals:* a fixture peer root recalls under a configured weight and
vanishes from recall after the projection is republished without it; a peer note
never appears in the local note log; an injection with a peer root present
performs zero index builds; the deterministic-ID collision fixture (two authors,
one `project:x:summary`) keeps both notes distinguishable.

**Phase 2 — only on demand.**
The withhold-only critic (§7); in-flow `share_note` / `<team>` marker; shared
deterministic-ID ownership (one shared append-target store); PR-review as
admission control.

## 9. Open questions for the reviewer

1. **Novelty gate and peers (3.4):** should a teammate's note suppress your own
   as a duplicate — corroboration or contamination? Recommended: exclude peer
   rows from the gate, on the grounds that a peer can unshare and leave nothing.
   Argue the other side.
2. **Default share rule:** opt-in per note, or scope-based with a mandatory
   dry-run? Where should the default sit for a 3–8 person team?
3. **Deterministic-ID collision (3.2):** namespace peer ids at index time
   (`peer:alice/project:x:summary`, keeps peer files byte-identical), or key the
   index by `(root, note_id)`? Which survives `why-not` and the trace format
   better?
4. **Does the withhold-only critic earn its keep at all**, given that the
   candidate set for a week is plausibly 5–30 notes and reviewing titles takes
   ~30 seconds? Name the operating point where it wins, or argue it should never
   be built.
5. **Absolute paths in shared notes:** `scope.git_root` carries
   `/Users/alice/...`. Strip at projection time, or accept?
6. **The feedback gap (§4 takeaway):** is "you cannot know which shared notes
   were used" acceptable permanently, or does it need a named trigger now?

## 10. Non-goals

Federated/served memory (an always-on box, auth, and it cannot serve the push
path at all — already rejected in §15); a `visibility` field on records; sharing
event logs; two-way sync of peer content; a merge engine for concurrent
deterministic-ID revisions in Phase 1; auto-publish without human confirmation.
