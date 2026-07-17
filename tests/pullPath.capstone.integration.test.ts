import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendNote, readAllNotes } from '../src/log/noteLog.ts';
import { readAll } from '../src/log/ndjson.ts';
import type { InjectionTrace } from '../src/diagnostics/injectionTrace.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Periwinkle cache failover decision',
  summary: 'Use the periwinkle standby cache during coordinator failover and keep the rollout global.',
  bullets: ['Coordinator failover should prefer the standby cache before retrying writes.'],
});
const FAITHFUL_RESPONSE = JSON.stringify({ faithful: true, errors: [], reason: 'Supported by the events.' });

function makeTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-path-capstone-'));
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const indexDir = path.join(root, 'index');
  const fixturePath = path.join(root, 'llm-response.json');
  fs.writeFileSync(fixturePath, JSON.stringify([LLM_RESPONSE, FAITHFUL_RESPONSE]));
  return { root, dataDir, diagnosticsDir, indexDir, fixturePath };
}

function runCli(args: string[], stdin = ''): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

function event(sessionId: string, turn: number, overrides: Record<string, unknown>): Record<string, unknown> {
  const seq = String(turn).padStart(2, '0');
  const cwd = '/Users/magnus/dev/librarian';
  return {
    schema_version: 1,
    event_id: `01J8X7QP${seq}Z9R4M2N6P0S5T7WY`,
    ts: `2026-07-07T09:${seq}:00.000Z`,
    resource: {
      agent: 'opencode',
      agent_version: '1.2.3',
      machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX',
      cwd,
      git_root: cwd,
      git_remote: 'git@github.com:magnus-tornvall/librarian.git',
      git_branch: 'feat/pull-path-capstone',
    },
    context: { session_id: sessionId, turn, cwd },
    ...overrides,
  };
}

function fixtureEvents(sessionId: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    event(sessionId, 1, { type: 'prompt', prompt: 'Investigate the platypus-only telemetry spike in cache writes.' }),
    event(sessionId, 2, {
      type: 'tool',
      tool: { native_name: 'Write', canonical_name: 'write', category: 'file_write' },
      files: [{ path: 'src/cache/failover.ts' }],
    }),
    event(sessionId, 3, { type: 'prompt', prompt: 'Add coverage for the platypus telemetry path before finishing.' }),
  ];
  for (let turn = 4; turn <= 11; turn += 1) {
    events.push(
      event(sessionId, turn, {
        type: 'tool',
        tool: { native_name: 'Read', canonical_name: 'read', category: 'file_read' },
        files: [{ path: `src/cache/file-${turn}.ts` }],
      }),
    );
  }
  return events;
}

function collect(dataDir: string, events: Array<Record<string, unknown>>): void {
  const stdin = events.map((record) => JSON.stringify(record) + '\n').join('');
  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);
}

function distill(t: { dataDir: string; diagnosticsDir: string; indexDir: string; fixturePath: string }): void {
  const result = runCli([
    'distill',
    '--data-dir',
    t.dataDir,
    '--diagnostics-dir',
    t.diagnosticsDir,
    '--index-dir',
    t.indexDir,
    '--provider-fixture',
    t.fixturePath,
  ]);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);
}

function seedDecoyNotes(t: { dataDir: string; diagnosticsDir: string; indexDir: string; fixturePath: string }): void {
  for (let i = 0; i < 5; i += 1) {
    appendNote(t.dataDir, {
      kind: 'note_revision',
      schema_version: 1,
      note_id: `decoy:pull-${i}`,
      revision_id: `decoy-pull-rev-${i}`,
      created_at: `2026-07-07T08:${String(i).padStart(2, '0')}:00.000Z`,
      identity: { mode: 'episodic' },
      source: { origin: 'opencode', distiller: 'llm' },
      note_type: 'fact',
      title: `Unrelated filler note ${i}`,
      scope: { global: true },
      provenance: {},
      links: [],
      body: { summary: `Assorted unrelated content ${i} about release checklists and editor settings.` },
    });
  }
  const result = runCli(['drain', '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir, '--index-dir', t.indexDir, '--provider-fixture', t.fixturePath]);
  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);
}

function parseToolJson(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const [content] = result.content;
  assert.equal(content?.type, 'text');
  return JSON.parse(content.text) as Record<string, unknown>;
}

function readTraces(diagnosticsDir: string): InjectionTrace[] {
  const injectionsDir = path.join(diagnosticsDir, 'injections');
  if (!fs.existsSync(injectionsDir)) {
    return [];
  }
  return fs
    .readdirSync(injectionsDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .flatMap((name) => readAll(path.join(injectionsDir, name)) as InjectionTrace[]);
}

function snapshotNotes(dataDir: string): Record<string, string> {
  const notesDir = path.join(dataDir, 'notes');
  if (!fs.existsSync(notesDir)) {
    return {};
  }
  return Object.fromEntries(
    fs
      .readdirSync(notesDir)
      .filter((name) => name.endsWith('.ndjson'))
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(notesDir, name), 'utf8')]),
  );
}

async function connectClient(dataDir: string, diagnosticsDir: string, indexDir: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'mcp', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--index-dir', indexDir],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'librarian-pull-path-capstone', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

test('pull path capstone: real collect/distill note is searchable by MCP and drills down to verbatim source events', async () => {
  const t = makeTempDirs();
  const sessionId = 'pull-path-capstone-session';
  const events = fixtureEvents(sessionId);

  seedDecoyNotes(t);
  collect(t.dataDir, events);
  distill(t);

  const notes = (readAllNotes(t.dataDir) as Array<Record<string, unknown>>).filter(
    (note) => (note.provenance as Record<string, unknown> | undefined)?.session_id === sessionId,
  );
  assert.equal(notes.length, 1, 'the real distill pass must mint exactly one source-provenanced note');
  const note = notes[0];
  const beforeNotes = snapshotNotes(t.dataDir);

  const { client, transport } = await connectClient(t.dataDir, t.diagnosticsDir, t.indexDir);
  try {
    const searchPayload = parseToolJson(
      await client.callTool({ name: 'search', arguments: { query: 'periwinkle', project_slug: 'librarian', limit: 10 } }),
    );
    const results = searchPayload.results as Array<Record<string, unknown>>;
    const hit = results.find((result) => result.note_id === note.note_id);
    assert.ok(hit, 'MCP search must hit the distilled note for content only present in the note judgment');
    assert.equal(hit.title, note.title, 'search result must include the note title');
    assert.equal(hit.summary, (note.body as Record<string, unknown>).summary, 'search result must include the note summary');
    assert.equal(hit.note_type, note.note_type, 'search result must include note_type metadata');
    assert.equal(hit.origin, 'opencode', 'search result must include origin metadata');
    assert.equal(typeof hit.date, 'string', 'search result must include date metadata');
    assert.equal(typeof hit.score, 'number', 'search result must include a score');
    assert.ok((hit.score as number) > 0, 'the scored hit must clear the relevance floor');
    assert.equal('body' in hit, false, 'search result must not include a full body');

    const notesPayload = parseToolJson(
      await client.callTool({ name: 'get_notes', arguments: { note_ids: [note.note_id] } }),
    );
    assert.deepEqual(notesPayload, { notes: [{ note_id: note.note_id, body: note.body }] }, 'get_notes must return the full body from the note log');

    const notePayload = parseToolJson(
      await client.callTool({ name: 'get_note', arguments: { note_id: note.note_id, with_provenance: true } }),
    );
    assert.deepEqual(notePayload.note, note, 'MCP get_note must return the same note that search found');
    assert.deepEqual(
      notePayload.provenance_events,
      events,
      'MCP get_note with provenance must recover the exact source events verbatim',
    );

    const eventOnlyPayload = parseToolJson(
      await client.callTool({ name: 'search', arguments: { query: 'platypus', project_slug: 'librarian', limit: 10 } }),
    );
    assert.deepEqual(
      eventOnlyPayload.results,
      [],
      'MCP search must not hit content that exists only in raw events and did not survive distillation',
    );
  } finally {
    await client.close();
    await transport.close();
  }

  assert.deepEqual(snapshotNotes(t.dataDir), beforeNotes, 'MCP search/get_note must leave the note log byte-identical');

  const traces = readTraces(t.diagnosticsDir);
  assert.ok(
    traces.some((trace) => trace.path === 'pull' && trace.query === 'periwinkle' && trace.shipped_note_ids.includes(note.note_id as string)),
    'diagnostics must contain a pull-marked trace for the successful search',
  );
  assert.ok(
    traces.some((trace) => trace.path === 'pull' && trace.query === 'platypus' && trace.shipped_note_ids.length === 0),
    'diagnostics must contain a pull-marked trace for the event-only negative search',
  );
});
