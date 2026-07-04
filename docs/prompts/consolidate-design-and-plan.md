# Task: Review prior design decisions, consolidate the specification, and produce an implementation plan

## Background
A previous Claude Code session ended before all questions could be answered. Your job is **not** to continue the previous conversation uncritically. Instead, independently evaluate the work completed so far. 

## Primary inputs
Read and understand: - `docs/specs/librarian-design-consolidated.md`

## Consolidate decisions
There are seven remaining decision areas.

1. Implementation language and runtime
  - Language: TypeScript
  - Runtime: Node.js LTS
  - Rejected Bun because it's another dependency
    - Package manager: pnpm or npm
    - CLI: TypeScript compiled to JS, exposed through bin/librarian
    - SQLite: better-sqlite3 (when needed)
    - MCP: @modelcontextprotocol/sdk (when needed)
2. Repo bootstrap: name, license, structure.
  - defer, librarian working name is fine.
3. Golden examples: embedded or extracted?
  - §10 extract JSON examples to JSON files
4. Test convention
  - Node --test following best practices for TypeScript
  - Black box/integration tests
  - No unit tests
5. Who executes the backlog — you, or your agents?
  - agents
6. Config file decision
  - ~/.librarian/config.json or ~/.config/librarian/config.json whichever is considered best practice
7. Does Librarian eat its own dog food during the build?
  - build sessions get recorded

Critique, identify inconsistencies, risk and better alternatives. Decide if to accept or reject. Consolidate the spec.

## Your objectives
Unless blockers or objections,  produce a detailed implementation plan that: 
- breaks the work into phases and stories
- explode stories from roadmap 1-4 into a backlog of tasks (`backlog/<task>.md`) with enough embedded context to survive a fresh session: a pointer to the spec section, the "do not relitigate §5" header, and the done-check. See #5. 
- task size sanity check: implementation + verifiable outcome verified in 15 minutes 
- commit changes and push on main