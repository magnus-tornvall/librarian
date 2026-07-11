# Provider qualification fixtures

Each child directory is auto-discovered and contains a realistic `events.ndjson`, a
canned `response.json` for offline CI, and structural assertions in `expected.json`.

Assertions are structural, never verbatim because model wording varies: the note must
land and pass note validation; `note_type` must route as expected; `scope` must carry
the right project slug; `provenance.event_range` must cover the session events; link
targets must be well-formed; `body.summary` and `title` must be non-empty; and
`source.model` must equal the model string configured for the run.

Keep future fixtures model-agnostic. Expected files may name routing, provenance, and
required link targets, but must not pin generated prose.
