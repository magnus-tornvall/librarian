import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDistillVerdict, readDistillVerdicts, type DistillVerdict } from '../../src/diagnostics/distillVerdict.ts';
import { writeInjectionTrace, type InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';
import { computeStats } from '../../src/diagnostics/stats.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function verdict(id: string, ts: string, decision: DistillVerdict['decision'], extra: Partial<DistillVerdict> = {}): DistillVerdict {
  return {
    record_class: 'diagnostic', verdict_id: id, ts, session_id: `session-${id}`, decision,
    reason: decision, counts: { events: 1, prompts: 1, write_tools: 0, salience_hints: 0 }, ...extra,
  };
}

function trace(id: string, ts: string, noteId: string, cutReason?: 'below_floor' | 'budget' | 'scope_mismatch', shipped: string[] = []): InjectionTrace {
  return {
    record_class: 'diagnostic', injection_id: id, ts, query: id,
    candidates: [{ note_id: noteId, raw_score: 1, post_weight_score: 1, ...(cutReason ? { cut_reason: cutReason } : {}) }],
    shipped_note_ids: shipped, indexed_through: ts, config_snapshot: {},
  };
}

function note(noteId: string, title: string, createdAt = '2026-05-01T00:00:00.000Z'): NoteRevision {
  return {
    kind: 'note_revision', schema_version: 1, note_id: noteId, revision_id: `rev-${noteId}`,
    created_at: createdAt, identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' }, note_type: 'fact', title,
    scope: { global: true }, provenance: {}, links: [], body: { summary: title },
  };
}

function runStats(dataDir: string, diagnosticsDir: string, json = false): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'stats', ...(json ? ['--json'] : []), '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir], { encoding: 'utf8' });
}

test('stats joins monthly verdicts, note usage, perpetual candidates, and cut reasons', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-stats-'));
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const verdicts = [
    verdict('v1', '2026-05-01T00:00:00.000Z', 'distilled', { origin: 'opencode', provider: 'openai/gpt-5' }),
    verdict('v2', '2026-05-02T00:00:00.000Z', 'noop', { origin: 'opencode', provider: 'openai/gpt-5' }),
    verdict('v3', '2026-06-01T00:00:00.000Z', 'duplicate'),
  ];
  for (const row of verdicts) writeDistillVerdict(diagnosticsDir, row);
  assert.deepEqual(readDistillVerdicts(diagnosticsDir), verdicts);

  const traces = [
    trace('t1', '2026-06-20T00:00:00.000Z', 'shipped', undefined, ['shipped']),
    trace('t2', '2026-06-21T00:00:00.000Z', 'perpetual', 'below_floor'),
    trace('t3', '2026-06-22T00:00:00.000Z', 'perpetual', 'below_floor'),
    trace('t4', '2026-06-23T00:00:00.000Z', 'perpetual', 'below_floor'),
    trace('t5', '2026-06-24T00:00:00.000Z', 'other', 'scope_mismatch'),
  ];
  for (const row of traces) writeInjectionTrace(diagnosticsDir, row);
  for (const row of [note('shipped', 'Shipped note'), note('perpetual', 'Perpetual note'), note('never-seen', 'Never seen'), note('young', 'Young note', '2026-07-01T00:00:00.000Z')]) appendNote(dataDir, row);

  const report = computeStats({ verdicts, traces, notes: [
    { note_id: 'shipped', title: 'Shipped note', created_at: '2026-05-01T00:00:00.000Z' },
    { note_id: 'perpetual', title: 'Perpetual note', created_at: '2026-05-01T00:00:00.000Z' },
    { note_id: 'never-seen', title: 'Never seen', created_at: '2026-05-01T00:00:00.000Z' },
    { note_id: 'young', title: 'Young note', created_at: '2026-07-01T00:00:00.000Z' },
  ], now: new Date('2026-07-01T00:00:00.000Z') });
  assert.deepEqual(report.admission.by_month['2026-05'].decisions.noop, { count: 1, rate: 0.5 });
  assert.equal(report.admission.by_month['2026-06'].decisions.duplicate.rate, 1);
  assert.equal(report.admission.by_origin.opencode.total, 2);
  assert.equal(report.admission.by_origin.unknown.total, 1);
  assert.equal(report.admission.by_provider.unknown.total, 1);
  assert.deepEqual(report.usage.injections_per_note, { shipped: 1 });
  assert.deepEqual(report.usage.dead_notes.map((row) => row.note_id), ['never-seen', 'perpetual']);
  assert.equal(report.usage.dead_note_ratio, 2 / 3);
  assert.deepEqual(report.usage.perpetual_candidates, [{ note_id: 'perpetual', title: 'Perpetual note', appearances: 3 }]);
  assert.equal(report.cut_reasons.total, 4);
  assert.equal(report.cut_reasons.mix.unknown.count, 0);
  assert.equal(Object.values(report.cut_reasons.mix).reduce((sum, row) => sum + row.count, 0), 4);

  const json = runStats(dataDir, diagnosticsDir, true);
  assert.equal(json.status, 0, json.stderr);
  const cliReport = JSON.parse(json.stdout) as typeof report;
  assert.equal(cliReport.admission.total, report.admission.total);
  assert.equal(cliReport.cut_reasons.total, report.cut_reasons.total);
  assert.equal(cliReport.usage.perpetual_candidates.length, report.usage.perpetual_candidates.length);

  const text = runStats(dataDir, diagnosticsDir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Admission funnel/);
  assert.match(text.stdout, /noop 1 \(50\.0%\)/);
  assert.match(text.stdout, /Usage/);
  assert.match(text.stdout, /Perpetual candidates \(>=3\): 1/);
  assert.match(text.stdout, /Cut-reason mix/);
  assert.match(text.stdout, /Total cut candidates: 4/);
});

test('stats does not infer dead notes without observations inside the trailing window', () => {
  const report = computeStats({
    verdicts: [],
    traces: [trace('old', '2026-05-01T00:00:00.000Z', 'old-note', 'below_floor')],
    notes: [{ note_id: 'old-note', title: 'Old note', created_at: '2026-01-01T00:00:00.000Z' }],
    now: new Date('2026-07-01T00:00:00.000Z'),
  });
  assert.deepEqual(report.usage.dead_notes, []);
  assert.equal(report.usage.dead_note_ratio, 0);
});

test('stats returns an empty report when diagnostics are missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-stats-empty-'));
  const dataDir = path.join(root, 'data');
  appendNote(dataDir, note('existing', 'Existing note'));
  const result = runStats(dataDir, path.join(root, 'missing'), true);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.admission.total, 0);
  assert.equal(report.usage.trace_count, 0);
  assert.deepEqual(report.usage.dead_notes, []);
  assert.equal(report.cut_reasons.total, 0);
});
