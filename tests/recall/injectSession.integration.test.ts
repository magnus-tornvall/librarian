import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openIndexWrite } from '../../src/index/database.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import { buildInjection } from '../../src/recall/inject.ts';
import { readInjectionTraces, type InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';

/**
 * Issue #123: push traces carry `session_id` + `trigger`, distinguishing
 * session-start from prompt injections (which otherwise both write `path: 'push'`
 * with `query === ''`). Black-box through the real note-log → index →
 * buildInjection path, embedding disabled (no config) so recall is BM25-only.
 */

const NOW = '2026-07-18T12:00:00.000Z';

function dirs(): { dataDir: string; indexDir: string; diagnosticsDir: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-session-'));
  return { root, dataDir: path.join(root, 'data'), indexDir: path.join(root, 'index'), diagnosticsDir: path.join(root, 'diagnostics') };
}

function seed(): { dataDir: string; indexDir: string; diagnosticsDir: string; root: string } {
  const d = dirs();
  appendNote(d.dataDir, {
    kind: 'note_revision', schema_version: 1, note_id: 'fact:backups', revision_id: 'fact:backups-r1',
    created_at: NOW, identity: { mode: 'episodic' }, source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'curated', title: 'Backups', scope: { project_slug: 'alpha' }, provenance: {}, links: [],
    body: { summary: 'nightly backups run at 2am for the alpha service database' },
  });
  const db = openIndexWrite(d.indexDir);
  try {
    indexNotes(db, d.dataDir);
  } finally {
    db.close();
  }
  return d;
}

test('prompt injection trace carries the session id and trigger=prompt', async () => {
  const d = seed();
  await buildInjection({
    dataDir: d.dataDir, diagnosticsDir: d.diagnosticsDir, indexDir: d.indexDir,
    query: 'nightly backups', projectSlug: 'alpha', global: false, sessionStart: false, sessionId: 'S1',
  });
  const trace = readInjectionTraces(d.diagnosticsDir).at(-1);
  assert.equal(trace?.session_id, 'S1');
  assert.equal(trace?.trigger, 'prompt');
});

test('session-start injection trace carries the session id and trigger=session_start', async () => {
  const d = seed();
  await buildInjection({
    dataDir: d.dataDir, diagnosticsDir: d.diagnosticsDir, indexDir: d.indexDir,
    projectSlug: 'alpha', global: false, sessionStart: true, sessionId: 'S1',
  });
  const trace = readInjectionTraces(d.diagnosticsDir).at(-1);
  assert.equal(trace?.session_id, 'S1');
  assert.equal(trace?.trigger, 'session_start');
});

test('a legacy trace without the new fields reads back and is excluded by a session filter', () => {
  const d = dirs();
  const injectionsDir = path.join(d.diagnosticsDir, 'injections');
  fs.mkdirSync(injectionsDir, { recursive: true });
  const legacy: InjectionTrace = {
    record_class: 'diagnostic', injection_id: 'old-1', path: 'push', ts: NOW,
    query: '', candidates: [], shipped_note_ids: [], indexed_through: NOW,
    embedding: 'disabled', config_snapshot: {},
  };
  fs.writeFileSync(path.join(injectionsDir, '2026-07.ndjson'), JSON.stringify(legacy) + '\n');
  const all = readInjectionTraces(d.diagnosticsDir);
  assert.equal(all.length, 1, 'the legacy trace still reads back through readAll');
  const forS1 = all.filter((trace) => trace.session_id === 'S1');
  assert.equal(forS1.length, 0, 'the unscoped legacy trace is simply excluded by a --session filter');
});
