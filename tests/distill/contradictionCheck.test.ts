import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { detectContradictions } from '../../src/distill/contradictionCheck.ts';
import { makeFixtureProvider } from '../../src/distill/provider.ts';
import { writeInjectionTrace } from '../../src/diagnostics/injectionTrace.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import { migrate } from '../../src/index/schema.ts';
import { appendNote, readAllNotes } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';
import { recall } from '../../src/recall/query.ts';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contradiction-check-'));
  return { dataDir: path.join(root, 'data'), diagnosticsDir: path.join(root, 'diagnostics') };
}

const sessionId = 'correcting-session';
const events = Array.from({ length: 11 }, (_, index) => ({
  event_id: `event-${index}`, ts: `2026-07-16T10:${String(index).padStart(2, '0')}:00.000Z`,
  type: index === 0 ? 'prompt' : 'tool', prompt: index === 0 ? 'No, that is wrong; the service uses the new endpoint.' : undefined,
}));

function note(overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    kind: 'note_revision', schema_version: 1, note_id: 'fact:wrong-endpoint', revision_id: 'wrong-rev',
    created_at: '2026-07-16T09:00:00.000Z', identity: { mode: 'episodic' },
    source: { origin: 'test', distiller: 'llm' }, note_type: 'fact', title: 'Service endpoint',
    scope: { global: true }, provenance: { session_id: 'original-session' }, links: [],
    body: { summary: 'The service uses the old wrong endpoint.' }, ...overrides,
  };
}

function trace(diagnosticsDir: string, ts = '2026-07-16T10:05:00.000Z'): void {
  writeInjectionTrace(diagnosticsDir, {
    record_class: 'diagnostic', injection_id: 'trace-1', path: 'push', session_id: sessionId, ts,
    query: 'endpoint', candidates: [], shipped_note_ids: ['fact:wrong-endpoint'], indexed_through: ts, config_snapshot: {},
  });
}

async function detect(dataDir: string, diagnosticsDir: string, provider = makeFixtureProvider('{"contradicted":true,"reason":"User explicitly corrected the endpoint."}')) {
  const reports: Array<{ noteId: string; contradicted: boolean; error?: string }> = [];
  const contradictions = await detectContradictions({
    dataDir, diagnosticsDir, sessionId, events, provider,
    report: (noteId, verdict, error) => reports.push({ noteId, contradicted: verdict.contradicted, error }),
  });
  return { contradictions, reports };
}

test('explicit correction of an injected note appends an invalidation and recall excludes it', async () => {
  const t = setup();
  appendNote(t.dataDir, note());
  trace(t.diagnosticsDir);

  const result = await detect(t.dataDir, t.diagnosticsDir);
  assert.equal(result.contradictions, 1);
  assert.deepEqual(result.reports, [{ noteId: 'fact:wrong-endpoint', contradicted: true, error: undefined }]);
  const supersession = (readAllNotes(t.dataDir) as Array<Record<string, unknown>>).find((record) => record.kind === 'note_supersession');
  assert.deepEqual(supersession?.source, { kind: 'detector', session_id: sessionId });
  assert.match(supersession?.reason as string, /explicitly corrected/);

  const db = new Database(':memory:');
  try {
    migrate(db);
    indexNotes(db, t.dataDir);
    assert.deepEqual(recall(db, 'wrong endpoint', { global: true }), []);
  } finally {
    db.close();
  }
});

test('near miss, absent trace, self-correction, late trace, and provider failure do not invalidate', async () => {
  const cases = [
    { name: 'near miss', response: '{"contradicted":false,"reason":"Discussed but not corrected."}', traced: true },
    { name: 'no trace', response: '{"contradicted":true,"reason":"unused"}', traced: false },
    { name: 'late trace', response: '{"contradicted":true,"reason":"unused"}', traced: 'late' as const },
    { name: 'provider failure', response: undefined, traced: true },
  ];
  for (const row of cases) {
    const t = setup();
    appendNote(t.dataDir, note());
    if (row.traced === true) trace(t.diagnosticsDir);
    if (row.traced === 'late') trace(t.diagnosticsDir, '2026-07-16T10:12:00.000Z');
    const provider = row.response === undefined
      ? { complete: async () => { throw new Error('detector unavailable'); } }
      : makeFixtureProvider(row.response);
    const result = await detect(t.dataDir, t.diagnosticsDir, provider);
    assert.equal(result.contradictions, 0, row.name);
    assert.equal((readAllNotes(t.dataDir) as Array<Record<string, unknown>>).some((record) => record.kind === 'note_supersession'), false, row.name);
    if (row.name === 'provider failure') assert.equal(result.reports[0]?.error, 'detector unavailable');
  }

  const t = setup();
  appendNote(t.dataDir, note({ provenance: { session_id: sessionId } }));
  trace(t.diagnosticsDir);
  let calls = 0;
  const result = await detect(t.dataDir, t.diagnosticsDir, { complete: async () => { calls += 1; return '{}'; } });
  assert.equal(result.contradictions, 0);
  assert.equal(calls, 0, 'a note distilled from this delta must never be checked');
});
