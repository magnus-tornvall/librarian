# Librarian — Pull-Path Implementation Analysis (MCP vs. Skill vs. subagent)

**Date:** 2026-07-06. **Status:** analysis, not a settled decision. Companion to `docs/specs/librarian-design-consolidated.md` (the spec, §6 recall contract, §7 storage/rendering, roadmap §12 item 7). If this document disagrees with the spec, the spec wins. Nothing here changes §5's "deleted/deferred" register or the push/pull split — it examines an implementation choice *inside* the pull path that the spec's roadmap item 7 leaves implicit.

**Do not relitigate:** the push/pull split (§1, §6) and "no unified push/pull interface" (spec §6, §15) are settled and correct. This document does not reopen them. It records that "pull path" ≠ "MCP" — MCP is one of three model-initiated pull mechanisms — and captures the tradeoff so roadmap item 7 is a deliberate choice rather than an unexamined default.

**Question that prompted this:** *Roadmap #7 names MCP as the pull path. For Claude Code, why MCP over a plugin/hook abstraction to do what the MCP would do? MCP looks like the more token-hungry option with no real benefit.*

---

## 1. Answer in one paragraph

For Claude Code, a plugin/hook **cannot** be the pull path at all — Claude Code hooks are deterministic lifecycle triggers, and the model never decides to invoke one. Pull requires a *tool the model chooses to call*, and hooks are not tools. So "MCP vs. plugin for pull" is a category error: the real choice is **MCP vs. model-invocable Skill vs. subagent**, all three of which are model-initiated tools that can wrap the same `librarian recall` / `librarian note show --with-provenance` CLI the spec already builds (§8). Among those, for a **Claude-Code-only** target a Skill is strictly leaner (no `@modelcontextprotocol/sdk`, no server process, no tool schema resident in context when idle). MCP's *sole* advantage is the one thing a Skill cannot do: reach the hook-less vendor chat apps (ChatGPT, Claude.ai, Gemini) that §1 names as the cross-vendor promise. The token critique is therefore correct **conditional on usage**: if Librarian is only ever consumed from coding agents, MCP is over-built for the job and deferrable behind a named trigger; if the §1 cross-vendor north star is real for the user, MCP is the floor a Skill can't reach and the two are not redundant.

## 2. Why push ≠ pull, and why pull ≠ plugin (the physics)

Spec §1/§6 split recall into two first-class paths with "different injection physics." The distinction is a property of the *harness*, not of Librarian:

- **Push** = prompt augmentation the harness performs on a lifecycle event. In Claude Code this is a hook (`SessionStart` digest, per-prompt injection on `UserPromptSubmit`) writing `additionalContext`. Deterministic: it fires because an *event* fired, never because the model asked. This is roadmap item 8.
- **Pull** = retrieval the *model* initiates mid-turn because it decided it needs something. This requires a mechanism the model can call. This is roadmap item 7.

The user's proposed alternative — "a plugin abstraction to do what the MCP would do" — assumes a plugin/hook can serve the pull role. In Claude Code it cannot, and this is verifiable from the harness's own contract:

- Anthropic's hooks reference (`https://docs.anthropic.com/en/docs/claude-code/hooks`) describes hooks as *"user-defined shell commands, HTTP endpoints, or LLM prompts that execute automatically at specific points in Claude Code's lifecycle."* The trigger is always a lifecycle event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, …). A matcher/`if` filter narrows *when*; nothing lets the model elect to fire a hook.
- Hooks can *push* text via `hookSpecificOutput.additionalContext` (wrapped in a system reminder, read on the next model request) on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolBatch`, `Stop`, `SubagentStart`, etc. That is injection (push), not model-initiated retrieval (pull).
- This matches the SuperBrain precedent (spec §3): SessionStart digest and per-prompt `sb-recall` on UserPromptSubmit were the deterministic **push** points; the `sb-mcp` MCP search server was the **on-demand** (model-initiated) pull. SuperBrain already drew this exact line.

**Conclusion:** the push/pull split is sound, and pull genuinely cannot be a hook. The user is not missing anything on that point. What the roadmap leaves implicit is the *next* fork.

## 3. Claude Code exposes three model-initiated pull mechanisms, not one

A model-initiated pull in Claude Code is **anything the model can call as a tool**. There are three tool families, verified against Anthropic docs:

1. **MCP tools** — `mcp__librarian__search`. The canonical case; what SuperBrain used (`sb-mcp`). MCP servers *"give Claude Code access to your tools, databases, and APIs … Claude can read and act on that system directly instead of working from what you paste"* (`https://docs.anthropic.com/en/docs/claude-code/mcp`). MCP tools appear as ordinary callable tools in the agentic loop (and, per the hooks doc, match in `PreToolUse`/`PostToolUse` like any other tool).
2. **The Skill tool** — a model-invocable skill (custom slash commands were merged into skills). *"Both you and Claude can invoke any skill … Claude can load it automatically when relevant"* (`https://docs.anthropic.com/en/docs/claude-code/skills`). A skill whose body shells out to `librarian recall <query>` and returns the result is a model-initiated pull. `disable-model-invocation: true` makes it user-only; `user-invocable: false` makes it model-only — so the invocation surface is configurable.
3. **The Agent tool** — subagent delegation. *"When Claude encounters a task that matches a subagent's description, it delegates to that subagent, which works independently and returns results"* (`https://docs.anthropic.com/en/docs/claude-code/sub-agents`). A subagent that retrieves and returns a summary is a model-initiated pull.

All three bottom out on the **same CLI** the spec already commits to: `librarian recall` (BM25 + weights + floor, §6) and `librarian note show <id> --with-provenance` (drill-down to verbatim event excerpts, §6/§8). The pull *transport* is a thin skin over that CLI, whichever family is chosen. This is the crux: the choice is skin-deep, and the spec's own "no generic abstraction" discipline (§5, §15) argues for the thinnest skin that reaches the required surfaces.

> Note: MCP's *tool* facet is the model-initiated one. MCP **prompts** surface as user-typed `/mcp__server__prompt` commands and MCP **resources** as user `@`-mentions — both user-initiated, not the pull path. Only the tool facet is relevant here.

## 4. The tradeoff the roadmap doesn't record: MCP vs. Skill (Claude-Code-only)

Subagent-as-pull is the odd one out (delegation semantics, summary-not-results, extra turn) — not the natural fit for "return me scored memory." The live comparison is **MCP server vs. model-invocable Skill wrapping the CLI**:

| | MCP server | Model-invocable Skill (CLI wrapper) |
|---|---|---|
| Model-initiated pull | Yes | Yes |
| Context cost when idle | Tool schema always advertised in the model's context | Only the skill's one-line description is always-on; body loads on invocation |
| New runtime dependency | `@modelcontextprotocol/sdk` + a server process/transport to run and supervise | None — reuses the existing `bin/librarian` CLI |
| Provenance drill-down (§6) | Natural as a second MCP tool | Natural as `librarian note show --with-provenance` |
| Origin/scope filters (§6) | Tool parameters | CLI flags |
| **Cross-vendor reach** | **ChatGPT, Claude.ai, Gemini, any MCP agent** | **Claude Code only** (skills are a Claude Code feature) |

Reading of the table:

- **The user's token critique is correct for a Claude-Code-only target.** A Skill delivers the same model-initiated pull for fewer always-on tokens and zero new dependencies. MCP's tool schema sits in context whether or not the model ever searches; the Skill's footprint when idle is a single description line.
- **MCP's only advantage is the last row** — and it is decisive *iff* the hook-less vendor chat apps are in scope. That row is the entire §1 cross-vendor promise: *"one implementation serves ChatGPT, Claude.ai, Gemini, and any MCP-speaking agent."* On those surfaces there is no hook and no Skill; MCP is the only door. A Skill cannot substitute for MCP there, and MCP is not wasteful there — it is the floor.

So MCP and Skill are not competitors on the same surface; they cover different surfaces, exactly like push and pull do. Building both *for Claude Code alone* would be redundant. Building MCP *for the cross-vendor floor* is not.

## 5. The decision hinges on one usage judgment

The question "is roadmap item 7 (as an MCP server) worth its cost?" reduces to a single fact about the user, not about the architecture:

- **If Librarian is consumed meaningfully from hook-less vendor chat apps** (ChatGPT/Claude.ai/Gemini): MCP is the floor a Skill can't reach. Build it. The token cost buys reach that is otherwise unavailable, and the §1 north star is the justification.
- **If Librarian is consumed essentially only from coding agents** (OpenCode, Claude Code, Cursor, Aider): the Skill-over-CLI is the leaner pull path for Claude Code, MCP's advantage goes unconsumed, and the token critique lands. MCP becomes deferrable behind a **named trigger** — *"actually wanting Librarian inside a hook-less surface"* — consistent with §15's practice of deferring with a preserved escape hatch rather than building speculatively.

This is a **prioritization / implementation** call within item 7, not a challenge to the push/pull architecture, which stands either way. Recording it here so that whoever explodes item 7 into backlog tasks chooses MCP deliberately (for reach) rather than by default (because "pull path" was read as synonymous with "MCP").

## 6. Recommendation (non-binding — spec is unchanged)

When roadmap item 7 is exploded:

1. Treat the deliverable as **"expose a model-initiated pull over the recall CLI,"** with the transport as an explicit sub-decision, not a foregone MCP build.
2. If the user's surfaces are Claude-Code-dominant at that time, ship the **Skill-over-CLI** first (cheap, no new deps) and gate MCP behind the cross-vendor trigger above.
3. If/when MCP is built, keep it a thin skin over the identical CLI (`recall` + `note show --with-provenance`), so both transports share one implementation and one set of §9 fixtures — no forked recall logic behind a second interface.

None of the above is settled; it is input to the item-7 explosion. The spec's §6 pull-path contract (up to ~10 scored results, full metadata, origin/scope filters, provenance drill-down; push-path austerity does **not** apply) governs the *behavior* regardless of which transport is chosen.

---

## Sources

- Anthropic Claude Code — Hooks reference: `https://docs.anthropic.com/en/docs/claude-code/hooks` (deterministic lifecycle triggers; `additionalContext` push; event list).
- Anthropic Claude Code — MCP: `https://docs.anthropic.com/en/docs/claude-code/mcp` (model-callable tools; prompts/resources are user-initiated).
- Anthropic Claude Code — Skills: `https://docs.anthropic.com/en/docs/claude-code/skills` (model-invocable skills; `disable-model-invocation` / `user-invocable`).
- Anthropic Claude Code — Sub-agents: `https://docs.anthropic.com/en/docs/claude-code/sub-agents` (model-initiated delegation).
- Local: `docs/specs/librarian-design-consolidated.md` §1 (push/pull split, cross-vendor promise), §3 (SuperBrain precedent: push points vs. `sb-mcp` on-demand pull), §6 (recall & injection contract, pull-path physics), §12 item 7, §15 (deferral-with-trigger practice; do not unify push/pull behind one interface).
