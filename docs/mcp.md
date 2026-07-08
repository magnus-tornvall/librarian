# Librarian MCP Server

`librarian mcp` starts a local MCP stdio server. The MCP client owns the process lifetime; Librarian does not run a daemon.

Register it in Claude Code:

```sh
claude mcp add librarian -- librarian mcp
```

For development or tests, the command also accepts `--data-dir <dir>` and `--diagnostics-dir <dir>`.

## Tools

`search` queries the same recall implementation as `librarian recall --json`. Parameters are `query` (required), `project_slug`, `global`, `origin`, and `limit`. `limit` defaults to 10 and is capped at 10. Results are scored notes with the same metadata shape as recall JSON: `note_id`, `title`, `summary`, `note_type`, `origin`, `created_at`, `project_slug`, `is_global`, and `score`. If neither `project_slug` nor `global` is supplied, recall fails closed with empty results and a message explaining why.

`get_note` reads the same note-show path as `librarian note show --json`. Parameters are `note_id` (required) and `with_provenance`. With provenance enabled, it returns `{ note, provenance_events }`; unknown notes and missing provenance logs surface as MCP tool errors.

Both tools are read-only against the note DB/log. `search` writes the same pull-marked diagnostics trace as the CLI.

## Authority

MCP results are possibly relevant prior context. Current repository evidence and current user instructions win on conflict.

## Remote Transport

The v1 server is stdio-only for local MCP agents such as Claude Code and Cursor. A remote/HTTP transport should be built only under the named trigger from the research note: actually wanting Librarian inside a hook-less vendor surface.
