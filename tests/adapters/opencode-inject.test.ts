import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibrarianPlugin } from '../../adapters/opencode/plugin.ts';
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

async function withEnv<T>(env: Partial<Record<'LIBRARIAN_BIN' | 'MACHINE_ID_PATH', string | null>>, fn: () => Promise<T>): Promise<T> {
  const prev = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeCli(mode: 'ok' | 'exit1' | 'slow' = 'ok'): { bin: string; machineIdPath: string; callsPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fake-cli-'));
  const bin = path.join(root, 'librarian.js');
  const machineIdPath = path.join(root, 'machine-id');
  const callsPath = path.join(root, 'calls.ndjson');
  fs.writeFileSync(machineIdPath, 'machine-test-id\n');
  fs.writeFileSync(
    bin,
    `const fs = require('fs');
const callsPath = ${JSON.stringify(callsPath)};
fs.appendFileSync(callsPath, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = ${JSON.stringify(mode)};
const command = process.argv[2];
if (command === 'machine-id') { process.stdout.write('machine-test-id\\n'); process.exit(0); }
if (command === 'collect') { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
if (command === 'inject') {
  if (mode === 'exit1') process.exit(7);
  const sessionStart = process.argv.includes('--session-start');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const write = () => process.stdout.write(sessionStart
      ? '<librarian-memory injection_id="brief">brief</librarian-memory>\\n'
      : '<librarian-memory injection_id="recall">' + input.trim() + '</librarian-memory>\\n');
    if (mode === 'slow') setTimeout(write, 1500);
    else write();
  });
}
`,
  );
  return { bin, machineIdPath, callsPath };
}

function textParts(messages: OpenCodeMessage[]): string[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) => {
      const rec = part as Record<string, unknown>;
      return rec.type === 'text' && typeof rec.text === 'string' ? [rec.text] : [];
    }),
  );
}

function readCalls(file: string): string[][] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
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

test('splice does not strip ordinary user text that mentions librarian-memory', () => {
  const messages: OpenCodeMessage[] = [{ role: 'user', parts: [{ type: 'text', text: 'show <librarian-memory> literally' }] }];
  assert.equal(spliceLibrarianInjection(messages, undefined), messages);
});

test('plugin hooks inject brief on first user and recall on latest user', async () => {
  const cli = fakeCli();
  await withEnv({ LIBRARIAN_BIN: cli.bin, MACHINE_ID_PATH: cli.machineIdPath }, async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-project-'));
    assert.equal(spawnSync('git', ['init'], { cwd: project }).status, 0);
    const hooks = await LibrarianPlugin({ directory: project });
    await hooks['chat.message']({ sessionID: 's1' }, { message: { id: 'm1', role: 'user', sessionID: 's1' }, parts: [{ type: 'text', text: 'first' }] });
    await hooks['chat.message']({ sessionID: 's1' }, { message: { id: 'm2', role: 'user', sessionID: 's1' }, parts: [{ type: 'text', text: 'wombat failover' }] });

    const output = {
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'answer' }] },
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] },
      ],
    };
    const transformed = await hooks['experimental.chat.messages.transform']({}, output);
    assert.equal((output.messages[0].parts[0] as Record<string, unknown>).librarian, 'librarian-brief');
    assert.equal((output.messages[2].parts[0] as Record<string, unknown>).librarian, 'librarian-recall');
    assert.equal((transformed?.messages[2].parts[0] as Record<string, unknown>).text, '<librarian-memory injection_id="recall">wombat failover</librarian-memory>\n');

    const compacted = await hooks['experimental.session.compacting']({}, { prompt: 'compact prompt' });
    assert.match(compacted?.prompt as string, /compact prompt/);
    assert.match(compacted?.prompt as string, /injection_id="brief"/);
    assert.match(compacted?.prompt as string, /injection_id="recall"/);

    const contextCompacted = await hooks['experimental.session.compacting']({}, { context: 'compact context' });
    assert.match(contextCompacted?.context as string, /compact context/);
    assert.match(contextCompacted?.context as string, /injection_id="brief"/);
    assert.match(contextCompacted?.context as string, /injection_id="recall"/);

    const injectCalls = readCalls(cli.callsPath).filter((args) => args[0] === 'inject');
    assert.ok(injectCalls.every((args) => args.includes('--global')), 'inject always passes --global');
    assert.ok(injectCalls.every((args) => args.includes('--project') && args.includes(path.basename(project))), 'inject passes git-root basename as --project');
  });
});

test('plugin compacting leaves output alone when no memory is cached', async () => {
  const cli = fakeCli();
  await withEnv({ LIBRARIAN_BIN: cli.bin, MACHINE_ID_PATH: cli.machineIdPath }, async () => {
    const hooks = await LibrarianPlugin({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-empty-')) });
    assert.equal(await hooks['experimental.session.compacting']({}, { prompt: 'compact prompt' }), undefined);
  });
});

test('plugin hooks contain missing librarian failures and inject nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-missing-cli-'));
  const machineIdPath = path.join(root, 'machine-id');
  fs.writeFileSync(machineIdPath, 'machine-test-id\n');
  await withEnv({ LIBRARIAN_BIN: path.join(root, 'missing-librarian'), MACHINE_ID_PATH: machineIdPath }, async () => {
    const hooks = await LibrarianPlugin({ directory: root });
    await assert.doesNotReject(() =>
      hooks['chat.message']({ sessionID: 's1' }, { message: { id: 'm1', role: 'user', sessionID: 's1' }, parts: [{ type: 'text', text: 'wombat failover' }] }),
    );
    const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }] };
    const transformed = await hooks['experimental.chat.messages.transform']({ sessionID: 's1' }, output);
    assert.deepEqual(transformed?.messages, [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }]);
  });
});

test('plugin hooks contain non-zero and slow librarian inject failures', async () => {
  for (const mode of ['exit1', 'slow'] as const) {
    const cli = fakeCli(mode);
    await withEnv({ LIBRARIAN_BIN: cli.bin, MACHINE_ID_PATH: cli.machineIdPath }, async () => {
      const hooks = await LibrarianPlugin({ directory: fs.mkdtempSync(path.join(os.tmpdir(), `opencode-${mode}-cli-`)) });
      await assert.doesNotReject(() =>
        hooks['chat.message']({ sessionID: mode }, { message: { id: `m-${mode}`, role: 'user', sessionID: mode }, parts: [{ type: 'text', text: 'wombat failover' }] }),
      );
      const transformed = await hooks['experimental.chat.messages.transform']({ sessionID: mode }, {
        messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }],
      });
      assert.deepEqual(transformed?.messages, [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }]);
    });
  }
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
