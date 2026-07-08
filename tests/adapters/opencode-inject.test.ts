import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spliceLibrarianInjection, type OpenCodeMessage } from '../../adapters/opencode/inject.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempRoot(): { dataDir: string; diagnosticsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-inject-'));
  return { dataDir: path.join(root, 'data'), diagnosticsDir: path.join(root, 'diagnostics') };
}

function note(index: number, overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `fact:opencode-inject-${index}`,
    revision_id: `rev-${index}`,
    created_at: `2026-07-06T10:${String(index).padStart(2, '0')}:00.000Z`,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'decision',
    title: `Adapter inject title ${index}`,
    scope: { project_slug: 'alpha' },
    provenance: {},
    links: [],
    body: { summary: `Adapter inject summary ${index} about wombat failover.` },
    ...overrides,
  };
}

function runInject(dataDir: string, diagnosticsDir: string, query: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'inject', '--project', 'alpha', '--global', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir], {
    input: query,
    encoding: 'utf8',
  });
}

function textParts(messages: OpenCodeMessage[]): string[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) => {
      const rec = part as Record<string, unknown>;
      return rec.type === 'text' && typeof rec.text === 'string' ? [rec.text] : [];
    }),
  );
}

test('splice pins turn-1 brief on the first user message', () => {
  const messages: OpenCodeMessage[] = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'first prompt' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'answer' }] },
  ];

  const spliced = spliceLibrarianInjection(messages, '<librarian-memory>recall</librarian-memory>\n', '<librarian-memory>brief</librarian-memory>\n');
  assert.equal((spliced[0].parts?.[0] as Record<string, unknown>).librarian, 'librarian-recall');
  assert.match((spliced[0].parts?.[0] as Record<string, string>).text, /recall/);
  assert.equal((spliced[0].parts?.[1] as Record<string, unknown>).librarian, 'librarian-brief');
  assert.match((spliced[0].parts?.[1] as Record<string, string>).text, /brief/);
});

test('splice keeps steady-state recall by the latest user while brief stays on the first user', () => {
  const messages: OpenCodeMessage[] = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'first prompt' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'answer' }] },
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'latest prompt' }] },
  ];

  const spliced = spliceLibrarianInjection(messages, '<librarian-memory>latest recall</librarian-memory>\n', '<librarian-memory>startup brief</librarian-memory>\n');
  assert.equal((spliced[0].parts?.[0] as Record<string, unknown>).librarian, 'librarian-brief');
  assert.match((spliced[0].parts?.[0] as Record<string, string>).text, /startup brief/);
  assert.equal((spliced[2].parts?.[0] as Record<string, unknown>).librarian, 'librarian-recall');
  assert.match((spliced[2].parts?.[0] as Record<string, string>).text, /latest recall/);
});

test('splice replaces prior tagged parts and is idempotent across repeated transforms', () => {
  const messages: OpenCodeMessage[] = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'first prompt' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'answer' }] },
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'latest prompt' }] },
  ];

  const once = spliceLibrarianInjection(messages, '<librarian-memory>new</librarian-memory>\n');
  const twice = spliceLibrarianInjection(once, '<librarian-memory>new</librarian-memory>\n');
  assert.deepEqual(twice, once);
  assert.equal(textParts(twice).filter((text) => text.includes('<librarian-memory')).length, 1);
  assert.equal((twice[2].parts?.[0] as Record<string, unknown>).librarian, 'librarian-recall');

  const replaced = spliceLibrarianInjection(twice, '<librarian-memory>replacement</librarian-memory>\n');
  assert.equal(textParts(replaced).filter((text) => text.includes('<librarian-memory')).length, 1);
  assert.ok(textParts(replaced).some((text) => text.includes('replacement')));
  assert.ok(!textParts(replaced).some((text) => text.includes('new')));
});

test('spawned inject output is spliced verbatim', () => {
  const t = tempRoot();
  appendNote(t.dataDir, note(1));
  for (let i = 0; i < 8; i += 1) {
    appendNote(t.dataDir, note(20 + i, { body: { summary: `Unrelated filler ${i}.` } }));
  }
  const result = runInject(t.dataDir, t.diagnosticsDir, 'wombat failover');
  assert.equal(result.status, 0, `inject should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /^<librarian-memory /);

  const spliced = spliceLibrarianInjection([{ role: 'user', parts: [{ type: 'text', text: 'wombat failover' }] }], result.stdout);
  assert.equal((spliced[0].parts?.[0] as Record<string, unknown>).text, result.stdout);
});

test('spawned inject output stays verbatim when a brief is also present', () => {
  const t = tempRoot();
  appendNote(t.dataDir, note(1));
  for (let i = 0; i < 8; i += 1) {
    appendNote(t.dataDir, note(20 + i, { body: { summary: `Unrelated filler ${i}.` } }));
  }
  const result = runInject(t.dataDir, t.diagnosticsDir, 'wombat failover');
  assert.equal(result.status, 0, `inject should exit 0; stderr: ${result.stderr}`);

  const spliced = spliceLibrarianInjection(
    [
      { role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { role: 'user', parts: [{ type: 'text', text: 'wombat failover' }] },
    ],
    result.stdout,
    '<librarian-memory>brief</librarian-memory>\n',
  );
  assert.equal((spliced[1].parts?.[0] as Record<string, unknown>).text, result.stdout);
});

test('below-floor prompt adds zero parts', () => {
  const t = tempRoot();
  for (let i = 0; i < 12; i += 1) {
    appendNote(t.dataDir, note(i, { body: { summary: `commonfloor token in every note ${i}` } }));
  }
  const result = runInject(t.dataDir, t.diagnosticsDir, 'commonfloor');
  assert.equal(result.status, 0, `inject should exit 0; stderr: ${result.stderr}`);
  assert.equal(result.stdout, '');

  const messages: OpenCodeMessage[] = [{ role: 'user', parts: [{ type: 'text', text: 'commonfloor' }] }];
  assert.equal(spliceLibrarianInjection(messages, undefined), messages);
});
