# Push path — manual dogfooding protocol

The push path is proven end-to-end in code by
[`tests/pushPath.capstone.integration.test.ts`](../tests/pushPath.capstone.integration.test.ts)
(roadmap item 8, §12): fixture events → `collect` → `distill` → index → both real adapter
entrypoints splice the §6 block → `librarian why` replays the trace. This document is the
**human** counterpart — the dogfooding moment the capstone test cannot assert: a real Claude
Code session on this repo, with the hook registered, memory surfacing unprompted. Run it in
≤15 min and paste the transcript into the PR (evidence, not a test assertion — #44 precedent).

## What you are proving

A note that already lives in Librarian's own memory arrives **invisibly** with your next
prompt (as Claude Code `additionalContext`), and its `injection_id` replays the full recall
trace via `librarian why`. No tool call, no `@`-mention — the memory just shows up.

## Protocol

1. **Register the hook.** Merge
   [`adapters/claude-code/settings-snippet.json`](../adapters/claude-code/settings-snippet.json)
   into `~/.claude/settings.json` (global) or `.claude/settings.json`
   (this repo only), replacing `/ABSOLUTE/PATH/TO/librarian` with your checkout path. The
   `UserPromptSubmit` and `SessionStart` entries are the injection-capable ones; see
   [`adapters/claude-code/README.md`](../adapters/claude-code/README.md) for the full
   registration steps and CLI-resolution order (`LIBRARIAN_BIN` → config `bin` → built
   `dist/cli.js` → bare `librarian`).

2. **Seed memory (if empty).** The push path only surfaces what has been distilled. Have at
   least one real session about this repo collected and distilled, plus a handful of unrelated
   notes so the corpus IDF stays positive — a lone note scores below the relevance floor (§6,
   the empty-slot-beats-distractor rule) and correctly surfaces nothing. Confirm the note
   exists: `librarian recall "<a few salient words from it>" --global --json`.

3. **Ask a question whose answer lives in that note.** In a Claude Code session inside this
   repo, submit a prompt built from the note's salient content words. BM25 AND-matches every
   token, so phrase it with words that actually appear in the note (a keyword-style question
   works; a sentence full of stopwords like "where does … get …" will not match).

4. **Observe the injected block.** The hook fires on `UserPromptSubmit`, shells out to
   `librarian inject`, and returns the `<librarian-memory …>` block as `additionalContext` —
   the model sees it prepended to your prompt, invisibly. Capture it (from the hook's stdout,
   or by re-running `inject` with the same prompt on stdin).

5. **Replay the trace.** Extract `injection_id="…"` from the block and run
   `librarian why <injection_id>`. It replays the query, the shipped note, every cut candidate,
   and the config snapshot — the full explanation of why that memory surfaced.

6. **Record the transcript** (the block + the matching `why` output) in the PR description.

## Reference transcript

Captured from a real run of this protocol against a temp Librarian home on this repo. The
seeded note was a `decision` about diagnostics isolation; the prompt used its content words.

**The block that arrived with the prompt (Claude Code `additionalContext`, verbatim):**

```
<librarian-memory injection_id="01KX3ASD9AGC19J1YDNJ799C9Y" indexed_through="2026-07-09T11:39:11.529Z">
Possibly relevant prior context. Prefer current repository evidence and current user instructions if they conflict.

1. [decision · llm/claude-code · 2026-07-09 · medium authority]
   Diagnostics isolation is a hard invariant
   All Librarian recall traces are written under ~/.librarian/diagnostics and never touch the append-only note log; the note log stays byte-identical across recall.
   src: decision:01KX3AQ42YSJ5CDWKADNEB816C#01KX3AQ42YTT3BYN2QT79TMV3C
</librarian-memory>
```

**`librarian why 01KX3ASD9AGC19J1YDNJ799C9Y` on its `injection_id`:**

```
Injection: 01KX3ASD9AGC19J1YDNJ799C9Y
Path: push
Query: Librarian recall diagnostics traces and the note log
Indexed Through: 2026-07-09T11:39:11.529Z
Config: {"originWeights":{"human":1.5,"opencode":1,"email":0.6},"typeWeights":{"curated":1.4,"decision":1.2,"project_summary":1,"fact":0.9,"daily":0.7,"episode":0.7},"relevanceFloor":0.1,"recencyHalfLifeDays":90,"projectBoost":1.5}
Candidates:
- decision:01KX3AQ42YSJ5CDWKADNEB816C: raw=9.4633 -> post=11.3558 shipped
```

The block arrived unprompted with the prompt; `why` replays exactly the query, the shipped
note, and the scoring config that put it there. That closes the push loop.
