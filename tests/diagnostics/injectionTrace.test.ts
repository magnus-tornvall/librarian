import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeInjectionTrace,
  makeInjectionId,
  type InjectionTrace,
} from '../../src/diagnostics/injectionTrace.ts';
import { readAll } from '../../src/log/ndjson.ts';
import { validateEvent, DiagnosticRecordRejectedError } from '../../src/collector/validateEvent.ts';

function tempDiagnosticsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'injection-trace-test-'));
}

function exampleTrace(overrides: Partial<InjectionTrace> = {}): InjectionTrace {
  return {
    record_class: 'diagnostic',
    injection_id: makeInjectionId(),
    ts: '2026-07-05T10:00:00.000Z',
    query: 'how does recall scoring work',
    candidates: [
      { note_id: 'decision:01AAA', raw_score: 12.5, post_weight_score: 18.75 },
      { note_id: 'daily:01BBB', raw_score: 3.1, post_weight_score: 2.17, cut_reason: 'below_floor' },
    ],
    shipped_note_ids: ['decision:01AAA'],
    indexed_through: '01J8X9F1TZ6R3M8N0P5Q7S9VW9',
    config_snapshot: { origin_weights: { human: 1.5, opencode: 1.0 }, relevance_floor: 5 },
    ...overrides,
  };
}

test('a trace round-trips via readAll() including record_class:"diagnostic"', () => {
  const diagnosticsDir = tempDiagnosticsDir();
  const trace = exampleTrace();
  writeInjectionTrace(diagnosticsDir, trace);

  // Lands in the monthly segment file keyed by ts (§8: same NDJSON machinery).
  const segment = path.join(diagnosticsDir, 'injections', '2026-07.ndjson');
  assert.ok(fs.existsSync(segment), 'trace should land in the monthly injections segment');

  const records = readAll(segment) as InjectionTrace[];
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], trace);
  assert.equal(records[0].record_class, 'diagnostic');
});

test('writes only under the given diagnostics dir — never the vault, never real ~/.librarian', () => {
  const diagnosticsDir = tempDiagnosticsDir();
  writeInjectionTrace(diagnosticsDir, exampleTrace());

  // Everything the writer produced lives under the temp diagnostics dir, and
  // specifically under an injections/ segment — not a generated/ or curated/
  // vault path, and (being a mkdtemp path) not the real ~/.librarian.
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  const files = walk(diagnosticsDir);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(file.startsWith(diagnosticsDir), `${file} must be under the temp diagnostics dir`);
    const segments = file.split(path.sep);
    assert.ok(segments.includes('injections'), `${file} must live under injections/`);
    assert.ok(!segments.includes('generated'), 'diagnostics must never touch the vault generated/');
    assert.ok(!segments.includes('curated'), 'diagnostics must never touch the vault curated/');
  }
});

test('poison pill: feeding the trace to validateEvent() throws the diagnostic-rejection error', () => {
  // The cross-module invariant (§8): a diagnostic record's shape is deliberately
  // NOT a valid event/note. If a trace ever reached the collector boundary, it is
  // hard-rejected by construction — proven here, not just asserted in prose.
  const trace = exampleTrace();
  assert.throws(() => validateEvent(trace), DiagnosticRecordRejectedError);
});

test('makeInjectionId produces distinct, non-empty ids', () => {
  const a = makeInjectionId();
  const b = makeInjectionId();
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});
