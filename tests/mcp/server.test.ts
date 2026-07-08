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

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
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

async function connectClient(dataDir: string, diagnosticsDir: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'mcp', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir],
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
  const sessionId = 'sess-mcp-provenance';
  const events = [event(sessionId, 1, 'remember the exact MCP prompt'), event(sessionId, 2, 'second provenance event')];

  for (let i = 0; i < 3; i += 1) {
    appendNote(dataDir, note(i));
  }
  appendNote(dataDir, note(9, { note_id: 'fact:mcp-email', source: { origin: 'email', distiller: 'llm' } }));
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

  const noteLogPath = path.join(dataDir, 'notes', '2026-07.ndjson');
  const beforeNoteLog = fs.readFileSync(noteLogPath, 'utf8');
  const { client, transport } = await connectClient(dataDir, diagnosticsDir);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['get_note', 'search'],
    );
    assert.match(tools.tools.find((tool) => tool.name === 'search')?.description ?? '', /current repository evidence/i);

    const mcpSearch = parseToolJson(
      await client.callTool({ name: 'search', arguments: { query: 'narwhal', project_slug: 'alpha', origin: 'email', limit: 50 } }),
    );
    const cliSearch = runCli([
      'recall',
      'narwhal',
      '--project',
      'alpha',
      '--origin',
      'email',
      '--limit',
      '50',
      '--json',
      '--data-dir',
      dataDir,
      '--diagnostics-dir',
      diagnosticsDir,
    ]);
    assert.equal(cliSearch.status, 0, `recall CLI should exit 0; stderr: ${cliSearch.stderr}`);
    assert.deepEqual(mcpSearch.results, JSON.parse(cliSearch.stdout));

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
  appendNote(dataDir, note(1, { provenance: { session_id: 'missing-session', event_ids: ['01J8X7QM01Z9R4M2N6P0S5T7WY'] } }));
  const { client, transport } = await connectClient(dataDir, diagnosticsDir);

  try {
    const result = await client.callTool({ name: 'get_note', arguments: { note_id: 'fact:mcp-1', with_provenance: true } });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /missing provenance session log/);
  } finally {
    await client.close();
    await transport.close();
  }
});
