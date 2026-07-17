import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendNote } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';
import { appendRecord } from '../../src/log/ndjson.ts';
import { readAll } from '../../src/log/ndjson.ts';
import { openIndexWrite } from '../../src/index/database.ts';
import { indexNotes } from '../../src/index/indexer.ts';
import type { InjectionTrace } from '../../src/diagnostics/injectionTrace.ts';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

function bootstrapIndex(dataDir: string, indexDir: string): void {
  const db = openIndexWrite(indexDir);
  try {
    indexNotes(db, dataDir);
  } finally {
    db.close();
  }
}

function note(index: number, overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `fact:mcp-${index}`,
    revision_id: `rev-${index}`,
    created_at: `2026-07-05T09:${String(index).padStart(2, '0')}:00.000Z`,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'fact',
    title: `MCP title ${index}`,
    scope: { project_slug: 'alpha' },
    provenance: {},
    links: [],
    body: { summary: `MCP summary ${index} with narwhal search term.` },
    ...overrides,
  };
}

function event(sessionId: string, turn: number, prompt: string): Record<string, unknown> {
  const seq = String(turn).padStart(2, '0');
  return {
    schema_version: 1,
    event_id: `01J8X7QM${seq}Z9R4M2N6P0S5T7WY`,
    ts: `2026-07-05T09:${seq}:00.000Z`,
    type: 'prompt',
    prompt,
    resource: { agent: 'opencode', machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX', cwd: os.tmpdir() },
    context: { session_id: sessionId, turn, cwd: os.tmpdir() },
  };
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

async function connectClient(dataDir: string, diagnosticsDir: string, indexDir: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'mcp', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--index-dir', indexDir],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'librarian-mcp-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

test('MCP stdio tools match recall/note CLI output and keep the note log read-only', async () => {
  const root = tempDir('mcp-server-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const indexDir = path.join(root, 'index');
  const sessionId = 'sess-mcp-provenance';
  const events = [event(sessionId, 1, 'remember the exact MCP prompt'), event(sessionId, 2, 'second provenance event')];

  for (let i = 0; i < 3; i += 1) {
    appendNote(dataDir, note(i));
  }
  appendNote(dataDir, note(9, {
    note_id: 'fact:mcp-email',
    source: { origin: 'email', distiller: 'llm' },
    body: { summary: 'MCP summary 9 with swordfish\nsearch term.' },
  }));
  appendNote(
    dataDir,
    note(10, {
      note_id: 'fact:mcp-provenance',
      provenance: { session_id: sessionId, event_ids: events.map((storedEvent) => storedEvent.event_id as string) },
    }),
  );
  for (const storedEvent of events) {
    appendRecord(path.join(dataDir, 'events', `${sessionId}.ndjson`), storedEvent);
  }
  bootstrapIndex(dataDir, indexDir);

  const noteLogPath = path.join(dataDir, 'notes', '2026-07.ndjson');
  const beforeNoteLog = fs.readFileSync(noteLogPath, 'utf8');
  const { client, transport } = await connectClient(dataDir, diagnosticsDir, indexDir);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['get_note', 'get_notes', 'search'],
    );
    assert.match(tools.tools.find((tool) => tool.name === 'search')?.description ?? '', /get_notes/i);
    assert.match(tools.tools.find((tool) => tool.name === 'get_note')?.description ?? '', /with_provenance to true/i);

    const mcpSearch = parseToolJson(
      await client.callTool({ name: 'search', arguments: { query: 'swordfish', project_slug: 'alpha', origin: 'email', limit: 50 } }),
    );
    const searchResults = mcpSearch.results as Array<Record<string, unknown>>;
    assert.equal(searchResults.length, 1);
    assert.deepEqual(Object.keys(searchResults[0]).sort(), ['date', 'note_id', 'note_type', 'origin', 'score', 'summary', 'title']);
    assert.equal(searchResults[0].note_id, 'fact:mcp-email');
    assert.equal(searchResults[0].summary, 'MCP summary 9 with swordfish search term.');
    assert.ok(
      readTraces(diagnosticsDir).some(
        (trace) => trace.path === 'pull' && trace.query === 'swordfish' && trace.candidates.length > 0,
      ),
      'MCP search must write a pull-marked diagnostics trace',
    );

    const mcpNotes = parseToolJson(
      await client.callTool({ name: 'get_notes', arguments: { note_ids: ['fact:mcp-email', 'fact:mcp-provenance', 'fact:missing'] } }),
    );
    assert.deepEqual(mcpNotes, {
      notes: [
        { note_id: 'fact:mcp-email', body: { summary: 'MCP summary 9 with swordfish\nsearch term.' } },
        { note_id: 'fact:mcp-provenance', body: { summary: 'MCP summary 10 with narwhal search term.' } },
        { note_id: 'fact:missing', error: 'unknown note_id' },
      ],
    });
    const invalidIds = await client.callTool({ name: 'get_notes', arguments: { note_ids: [''] } });
    assert.equal(invalidIds.isError, true);
    assert.match(invalidIds.content[0]?.type === 'text' ? invalidIds.content[0].text : '', /non-empty array of non-empty strings/);

    const mcpNote = parseToolJson(
      await client.callTool({ name: 'get_note', arguments: { note_id: 'fact:mcp-provenance', with_provenance: true } }),
    );
    const cliNote = runCli(['note', 'show', 'fact:mcp-provenance', '--data-dir', dataDir, '--with-provenance', '--json']);
    assert.equal(cliNote.status, 0, `note show CLI should exit 0; stderr: ${cliNote.stderr}`);
    assert.deepEqual(mcpNote, JSON.parse(cliNote.stdout));

    const missingScope = parseToolJson(await client.callTool({ name: 'search', arguments: { query: 'narwhal' } }));
    assert.deepEqual(missingScope.results, []);
    assert.match(String(missingScope.message), /fail-closed/i);

    const unknown = await client.callTool({ name: 'get_note', arguments: { note_id: 'fact:missing' } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0]?.type === 'text' ? unknown.content[0].text : '', /unknown note_id: fact:missing/);
  } finally {
    await client.close();
    await transport.close();
  }

  assert.equal(fs.readFileSync(noteLogPath, 'utf8'), beforeNoteLog, 'MCP session must not write to the note log');
});

test('MCP get_note surfaces missing provenance logs as tool errors', async () => {
  const root = tempDir('mcp-server-missing-log-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const indexDir = path.join(root, 'index');
  appendNote(dataDir, note(1, { provenance: { session_id: 'missing-session', event_ids: ['01J8X7QM01Z9R4M2N6P0S5T7WY'] } }));
  bootstrapIndex(dataDir, indexDir);
  const { client, transport } = await connectClient(dataDir, diagnosticsDir, indexDir);

  try {
    const result = await client.callTool({ name: 'get_note', arguments: { note_id: 'fact:mcp-1', with_provenance: true } });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /missing provenance session log/);
  } finally {
    await client.close();
    await transport.close();
  }
});

test('MCP get_notes reads indexed note state when the note log is unavailable', async () => {
  const root = tempDir('mcp-server-warm-index-');
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const indexDir = path.join(root, 'index');
  const target = note(1, {
    note_id: 'fact:mcp-warm-index',
    body: { summary: 'Lantern protocol persists in the index.' },
  });
  appendNote(dataDir, target);
  for (let i = 2; i < 8; i += 1) {
    appendNote(dataDir, note(i));
  }
  bootstrapIndex(dataDir, indexDir);
  fs.renameSync(path.join(dataDir, 'notes'), path.join(dataDir, 'notes-unavailable'));
  const { client, transport } = await connectClient(dataDir, diagnosticsDir, indexDir);

  try {
    const searchPayload = parseToolJson(
      await client.callTool({ name: 'search', arguments: { query: 'lantern', project_slug: 'alpha' } }),
    );
    const searchResults = searchPayload.results as Array<Record<string, unknown>>;
    assert.ok(searchResults.some((result) => result.note_id === target.note_id));

    const notesPayload = parseToolJson(
      await client.callTool({ name: 'get_notes', arguments: { note_ids: [target.note_id] } }),
    );
    assert.deepEqual(notesPayload, { notes: [{ note_id: target.note_id, body: target.body }] });
  } finally {
    await client.close();
    await transport.close();
  }
});
