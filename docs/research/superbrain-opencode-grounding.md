# SuperBrain × OpenCode Integration — Grounding Document

**Date:** 2026-07-03. All findings verified by reading SuperBrain source (`m3talux/superbrain`, v0.11.0, commit `571a738`, 2026-06-13) and current OpenCode plugin docs/community plugins.

**Current status: the write side works.** An OpenCode plugin appends events to SuperBrain's NDJSON logs; SuperBrain's Claude Code-hosted distiller picks them up and routes notes into the vault. Verified end-to-end. Next phase: recall (read side) in OpenCode.

---

## 1. SuperBrain architecture (as verified from source)

**Write path:** Claude Code hooks (`PostToolUse`/`UserPromptSubmit`, matcher `"*"`, no LLM) → `sb-observe` appends events to `~/.superbrain/sessions/{sid}.ndjson` → deterministic salience scorer adds markers → checkpoints (`bin/sb-checkpoint.ts` handles Stop/PreCompact/SessionEnd; Stop gated on `{sid}.pending`) snapshot transcript, acquire `distill` lock, spawn detached `sb-distill` → distiller runs `claude -p` over the event delta (byte cursor in `{sid}.cursor`) → routes notes to vault (`projects/`, `decisions/`, `people/`, `daily/`, `capture/`, `meta/`) → **calls `indexNote()` per written note** (index freshness is tied to distill, not reconcile).

**Orphan pickup (what makes the OpenCode write side work):** `sb-session-start` spawns `sb-reconcile` (debounced 10 min via `shouldSpawnReconcile`) → `sweepOrphanedSessions()` scans **all** of `~/.superbrain/sessions/` for logs with: mtime idle ≥ 3h (`SUPERBRAIN_ORPHAN_IDLE_HOURS`, default 3), size > cursor, < 3 attempts (`MAX_DISTILL_ATTEMPTS`; after 3 failures cursor force-advances). **Global scope** — any Claude Code session anywhere triggers it; project routing comes from per-event `cwd`. Secondary path: `{sid}.needs-distill` flag files swept at the end of every real distill.

**Event schema (NDJSON, one JSON/line):**
```json
{"type":"prompt","cwd":"/abs/path","prompt":"...","ts":"ISO8601"}
{"type":"tool","cwd":"...","tool":"Write","command":"(Bash only)","file":"(file tools)","ts":"..."}
{"type":"salient","reason":"write_threshold|git_commit|cwd_switch|pushback","cwd":"...","files":[],"prompt_excerpt":"≤200 chars","ts":"..."}
```
Distillation is **purely NDJSON-driven** (transcript snapshot only feeds the session-note assistant tail + GC). Tool names must be Claude Code-cased: skip heuristic counts `Write/Edit/MultiEdit/Bash`; salience `WRITE_TOOLS = Write/Edit/NotebookEdit/ctx_edit` + `git commit` regex on Bash commands. Sessions with 0 markers, 0 write tools, <2 prompts, <10 events are skipped. OpenCode observer maps lowercase tool names accordingly, ports the ~60-line salience scorer, prefixes sids (`oc-…`), appends only (never touches cursors/locks/flags).

**Recall path (Claude Code side):** hybrid index at `~/.superbrain/index.db` — FTS5 BM25 (contentless, `content=''`) + sqlite-vec int8 KNN over local static embeddings (`minishlab/potion-base-8M`, 256-dim, hand-rolled model2vec inference in `src/staticEmbed/`, no npm equivalent exists). `hybridRecall`: RRF fusion → 2× project/global boost → recency decay `exp(-ageDays/90)` → archive penalty 10% → project-scoped recall reserves ~25% slots for global background, **fail-closed** (untagged notes excluded). Injection points: SessionStart 4-slot digest (project anchor ~400 tok, global ~100, prefs core `meta/preferences-core.md` ~150, open threads); per-prompt `sb-recall` on UserPromptSubmit (top-5, wikilink + heading + 160-char excerpt, 120 tok/note, ~500 total, per-session slug dedup); mini-brief every 10 turns; on-demand `sb-mcp` MCP search server.

**Distill triggering (deferred decision):** `sb-distill` does **not** self-acquire the lock (caller passes `SUPERBRAIN_LOCK_TOKEN`). Escalation path if passive latency hurts: (1) live with orphan sweep; (2) backdate ndjson mtime on `session.idle` (2 lines, next reconcile sweeps immediately); (3) full OpenCode-initiated distill = replicate lock protocol (~30 lines, more coupling, still shells to `claude -p`).

---

## 2. OpenCode recall design (agreed architecture)

**Two-phase hook pattern** (proven by oh-my-opencode's context injector; Superpowers uses the same transform hook):

1. **`chat.message`** — fires once per user submission with prompt text. Compute BM25 recall, apply dedup + budget caps, stash in session-keyed Map. Do **not** mutate `output.parts` (mutations persist to history → token accumulation; TUI rendering quirks; plugin-ordering conflicts).
2. **`experimental.chat.messages.transform`** — signature `(input: {}, output: {messages: {info, parts}[]})`. Fires per **inference call** (many per turn in tool loops) on the outgoing payload only — ephemeral, never persisted; OpenCode's closest analog to Claude Code `additionalContext`. Splice ONE tagged synthetic part (`<superbrain-recall>…`) adjacent to latest user message, removing prior tagged parts first (idempotent). Turn-1 brief + prefs core ride the same part, prepended to first user message (avoids `system.transform`'s multi-system-message breakage on some models, e.g. Qwen).

**Hooks to avoid/know:** `experimental.chat.system.transform` receives no user message (feature requests closed as not planned) — unusable for targeted recall. `session.created` bus event = init turn counter only (events can't inject). `experimental.session.compacting` — push open-thread pointers so recall context survives compaction. Stability: `experimental.` hooks have an open proposal to replace `messages.transform` with `pre_chat.messages.transform`, and `system.transform` fires *after* `messages.transform`; wrap splice logic in one adapter function.

**Turn-1 brief (v1 scope):** read `meta/preferences-core.md` directly + top-5 recall on project slug. Skip full digest parity (open threads/edges/budget machinery).

---

## 3. Recall feasibility — showstoppers cleared, hassles known

**Cleared:**
- Index freshness: distill calls `indexNote()` per note → OpenCode-authored notes searchable at distill time. Reconcile only catches manual vault edits.
- Concurrency: `journal_mode=WAL`, `busy_timeout=10000`. Plugin opens **read-only** — safe alongside running distill.
- FTS5 without sqlite-vec: `vec_chunks` (vec0) coexists but is never touched by BM25 queries; Bun's `bun:sqlite` ships FTS5. Contentless FTS → hydrate rowids via `SELECT rel_path,heading_path,anchor,text FROM chunks WHERE id=?`.
- FTS injection: copy upstream sanitizer verbatim — strip `[^\w\s]`, split whitespace, OR-join terms.

**Silent-failure trap:** project slug parity. `resolveProjectSlug` = `classifyPath(cwd)` → `git rev-parse --show-toplevel` → `basenameSlug(gitRoot)`. Wrong slug ⇒ empty project arm, silent degradation to global (fail-closed). **Vendor `projectDetect.ts` exactly.** Known quirk (parity with SuperBrain): linked git worktrees resolve to worktree basename → different slug.

**Accepted gap:** BM25-only (supported degradation path in `hybridRecall`). Vector arm would need sqlite-vec extension loading — on macOS, `bun:sqlite` requires `Database.setCustomSQLite()` pointing at Homebrew libsqlite3 (system SQLite blocks extensions) — plus JS potion inference. Not worth it until BM25 proves insufficient.

**Hassles:** vendor ~80 lines of scoring math (RRF, decay, boosts, 75/25 split) under commit pin; best-effort discipline (try/catch + short timeout, degrade to no-injection — SuperBrain time-boxes recall at 12s); dedup Map dies on restart (one duplicate injection after resume — acceptable).

---

## 4. Package-replacement analysis

SuperBrain's 4 runtime deps: `better-sqlite3`, `sqlite-vec`, `gray-matter`, `@modelcontextprotocol/sdk`. Hand-rolling elsewhere is deliberate policy (69-line lockfile, 47-line atomic write, 40-line chunker).

- Genuinely 1:1: `atomicWrite.ts` → `write-file-atomic`; `claudeCli.ts`/`spawnChild.ts` → `@anthropic-ai/claude-agent-sdk`; `chunker.ts` → remark (fixes `#`-in-code-fence bug — upstream PR candidate, irrelevant to the plugin); token estimate → `js-tiktoken` (unneeded).
- Almost: `lockfile.ts` → `proper-lockfile`, **except** the cross-process release-by-token handoff (checkpoint acquires, detached child releases via env) doesn't fit its same-process release model.
- Not replaceable: `staticEmbed/` (no `model2vec` on npm — confirmed); all domain logic (salience, RRF/scoring, router, prompts, budgets, GC, gating).
- **Decision rule for the plugin:** parity-critical code (slug, FTS sanitizer, scoring weights) → vendor SuperBrain's exact lines even where packages exist (matching bugs beats fixing them). Plugin-own infrastructure (state files, future locks) → use packages freely.

## 5. Strategy decisions on record

- **No long-lived fork.** Vendor the small parity modules with the upstream commit pinned in comments. Fork only as a short-lived PR vehicle.
- **Upstream pitch:** propose an `integrations/opencode` observer or exported observer primitives (salience, event schema, ndjson writer) to m3talux/superbrain. Project grain favors bug fixes and exposed primitives, not dependency swaps.
- **Version-pin + smoke test:** append synthetic log to temp `SUPERBRAIN_DATA_DIR` → run `sb-distill` with `SUPERBRAIN_SESSION_ID` → assert note lands. Run after every SuperBrain upgrade.
- **Structural dependency:** distill trigger and LLM call are Claude Code-hosted (`claude -p`). Full migration off Claude Code would require OpenCode shelling out to standalone `bin/sb-distill.ts` — which still invokes `claude -p`.
- Non-facts for the record: SuperBrain has no TodoRead/TodoWrite handling (those are Claude Code built-ins observed generically, zero salience weight — safe to filter or repurpose as `plan_update` markers later); npm package `superbrain` (v1.1.4) is an unrelated project.

## 6. Next step

Implement the recall side: `chat.message` (BM25 query via read-only `bun:sqlite` against `index.db`, vendored slug/sanitizer/scoring, session Map) + `experimental.chat.messages.transform` (tagged idempotent splice) + `experimental.session.compacting` (open-thread pointers). Then evaluate distilled-note quality from real OpenCode sessions before any distill-trigger work.
