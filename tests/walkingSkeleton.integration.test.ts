import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// The nine pipeline stages, imported from the exact modules the roadmap names
// (010–025). This test is the wiring map: each import below is one stage.
import { readAll } from '../src/log/ndjson.ts'; // 010/011 — fixture + ndjson reader
import { appendEvent } from '../src/collector/append.ts'; // 015 — collector append
import { renderEventsForDistill } from '../src/render/distillPrompt.ts'; // 016 — renderer
import { makeFixtureProvider } from '../src/distill/provider.ts'; // 017 — fixture provider
import { distill } from '../src/distill/llmDistiller.ts'; // 018 — LLM distiller
import { appendNote } from '../src/log/noteLog.ts'; // 019 — note log
import { exportNoteToVault } from '../src/export/obsidian.ts'; // 020 — Obsidian export
import { migrate } from '../src/index/schema.ts'; // 021 — FTS5 schema
import { indexNotes } from '../src/index/indexer.ts'; // 022 — indexer
import { recall } from '../src/recall/query.ts'; // 024 — recall query
import { writeInjectionTrace, makeInjectionId, type InjectionTrace } from '../src/diagnostics/injectionTrace.ts'; // 025 — injection trace

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'events', 'session-001.ndjson');

// The canned distill judgment (017 fixture provider — NOT a live `claude -p`,
// per §14's test convention). Its title/summary carry the distinctive term
// "redirect" that the recall query below matches on.
const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Expire check before redirect',
  summary: 'Fixed the login redirect loop by checking token expiry before redirect.',
});

const SESSION_ID = '01J8X7QK40M8Q3N6P0R5S7TVWX';
const ORIGIN = 'opencode';
const QUERY_TERM = 'redirect'; // a term from the note's title/summary

// Decoy notes: FTS5's bm25() IDF term collapses to ~0 in a single-document
// corpus, so a lone note scores below the relevance floor and recall returns
// []. A realistic corpus is needed for a nonzero score (mirrors the decoy-rows
// idiom in tests/recall/query.test.ts). None of these contain "redirect", so
// the distilled note stays the ONLY match — recall still returns exactly one.
const DECOY_NOTES = Array.from({ length: 5 }, (_, i) => ({
  kind: 'note_revision',
  schema_version: 1,
  note_id: `${ORIGIN}:decoy-${i}`,
  revision_id: `decoy-rev-${i}`,
  created_at: '2026-07-05T09:00:00.000Z',
  identity: { mode: 'episodic' },
  source: { origin: ORIGIN, distiller: 'llm' },
  note_type: 'fact',
  title: `Unrelated filler note ${i}`,
  scope: {},
  provenance: {},
  links: [],
  body: { summary: `Miscellaneous unrelated content number ${i} about assorted topics.` },
}));

/** One fresh set of temp dirs per run so the test never touches ~/.librarian. */
function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walking-skeleton-'));
  return {
    root,
    dataDir: path.join(root, 'data'),
    vaultDir: path.join(root, 'vault'),
    diagnosticsDir: path.join(root, 'diagnostics'),
    eventLog: path.join(root, 'data', 'events', 'session-001.ndjson'),
    cursorPath: path.join(root, 'data', 'cursor.json'),
  };
}

test('walking skeleton: fixture events → distill → note log → export → index → recall → trace', async () => {
  const t = makeTempDirs();

  // 1. Read the fixture events (010) via readAll() (011).
  const fixtureEvents = readAll(FIXTURE) as Array<Record<string, unknown>>;
  assert.equal(fixtureEvents.length, 4, 'stage 1 (fixture readAll): expected 4 fixture events');

  // 2. Append each event to a temp event log via appendEvent() (015).
  for (const event of fixtureEvents) {
    appendEvent(t.eventLog, event);
  }
  assert.ok(fs.existsSync(t.eventLog), 'stage 2 (appendEvent): event log file should exist after appends');

  // 3. Read them back and render via renderEventsForDistill() (016) — non-empty.
  const loggedEvents = readAll(t.eventLog) as Array<Record<string, unknown>>;
  assert.equal(loggedEvents.length, 4, 'stage 3 (read-back): all 4 appended events should read back');
  const rendered = renderEventsForDistill(loggedEvents);
  assert.equal(typeof rendered, 'string', 'stage 3 (render): render output must be a string');
  assert.ok(rendered.length > 0, 'stage 3 (render): rendered prompt text must be non-empty');

  // 4. Distill via distill() (018) using makeFixtureProvider() (017) — NOT live inference.
  const note = await distill(loggedEvents, SESSION_ID, makeFixtureProvider(LLM_RESPONSE), ORIGIN);
  assert.equal(note.kind, 'note_revision', 'stage 4 (distill): result must be a note_revision');
  assert.ok(
    note.note_id.startsWith(`${note.note_type}:`),
    'stage 4 (distill): note_id must be stamped under the note type',
  );
  assert.equal(note.source.distiller, 'llm', 'stage 4 (distill): distiller must be stamped llm');

  // 5. Append the resulting note via appendNote() (019). Decoys give the FTS
  //    index a realistic corpus; the distilled note is the only "redirect" match.
  for (const decoy of DECOY_NOTES) {
    appendNote(t.dataDir, decoy);
  }
  appendNote(t.dataDir, note as unknown as Record<string, unknown>);
  const notesSegment = path.join(t.dataDir, 'notes', `${note.created_at.slice(0, 7)}.ndjson`);
  assert.ok(fs.existsSync(notesSegment), 'stage 5 (appendNote): the note log segment should exist');

  // 6. Export via exportNoteToVault() (020); assert the file exists under generated/.
  const exportedPath = exportNoteToVault(t.vaultDir, note as unknown as Record<string, unknown>);
  assert.ok(fs.existsSync(exportedPath), 'stage 6 (export): exported markdown file must exist on disk');
  const generatedRoot = path.join(t.vaultDir, 'generated');
  assert.ok(
    exportedPath.startsWith(generatedRoot + path.sep),
    'stage 6 (export): exported file must live under the vault generated/ tree',
  );

  // 7. Migrate + index: migrate() (021) on an in-memory db, indexNotes() (022) on temp data dir.
  const db = new Database(':memory:');
  migrate(db);
  const indexedCount = indexNotes(db, t.dataDir, t.cursorPath);
  assert.equal(
    indexedCount,
    DECOY_NOTES.length + 1,
    'stage 7 (index): every appended note (decoys + distilled) should be indexed',
  );

  // 8. Query via recall() (024): exactly one result, whose note_id is the distilled note.
  const results = recall(db, QUERY_TERM, { projectSlug: 'librarian' });
  assert.equal(results.length, 1, 'stage 8 (recall): expected exactly one result for the query term');
  assert.equal(
    results[0].note_id,
    note.note_id,
    'stage 8 (recall): the single result must be the distilled note',
  );

  // 9. Write an injection trace via writeInjectionTrace() (025) recording this
  //    query/result; read it back and assert shipped_note_ids contains the note_id.
  const shippedNoteId = results[0].note_id;
  const trace: InjectionTrace = {
    record_class: 'diagnostic',
    injection_id: makeInjectionId(),
    ts: new Date().toISOString(),
    query: QUERY_TERM,
    candidates: results.map((r) => ({
      note_id: r.note_id,
      raw_score: r.raw_bm25,
      post_weight_score: r.score,
    })),
    shipped_note_ids: [shippedNoteId],
    indexed_through: note.revision_id,
    config_snapshot: {},
  };
  writeInjectionTrace(t.diagnosticsDir, trace);

  const traceSegment = path.join(t.diagnosticsDir, 'injections', `${trace.ts.slice(0, 7)}.ndjson`);
  assert.ok(fs.existsSync(traceSegment), 'stage 9 (trace): the injection trace segment should exist');
  const traces = readAll(traceSegment) as InjectionTrace[];
  assert.equal(traces.length, 1, 'stage 9 (trace): exactly one trace should have been written');
  assert.ok(
    traces[0].shipped_note_ids.includes(note.note_id),
    'stage 9 (trace): shipped_note_ids must contain the distilled note_id',
  );
});
