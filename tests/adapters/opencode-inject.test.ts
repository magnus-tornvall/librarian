import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibrarianPlugin, spliceLibrarianInjection, type OpenCodeMessage } from '../../adapters/opencode/plugin.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';

/**
 * The OpenCode plugin file itself (issue #155) — the one dependency-free file `librarian init`
 * writes into `~/.config/opencode/plugins/`.
 *
 * After the port to `librarian hook opencode` the plugin does exactly three things, and this
 * file covers all three through its real hook surface:
 *
 *   1. forwards each raw native payload in a `{hook, cwd, …}` envelope to the binary,
 *   2. caches the blocks that come back per session (a hook process lives for one event), and
 *   3. splices them into the outgoing message array — brief pinned to the first user message,
 *      recall adjacent to the latest, idempotent across repeated `messages.transform` fires.
 *
 * Mapping, resource facts, collection, and recall are the shell's; they are covered by
 * tests/adapters/opencodeHook.test.ts against the real subcommand. Here the binary is a stand-in
 * that records the envelopes it was handed, so these tests assert the plugin's contract with it.
 */

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempRoot(): { dataDir: string; diagnosticsDir: string; indexDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-inject-'));
  return { dataDir: path.join(root, 'data'), diagnosticsDir: path.join(root, 'diagnostics'), indexDir: path.join(root, 'index') };
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

function runInject(dataDir: string, diagnosticsDir: string, indexDir: string, query: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'inject', '--project', 'alpha', '--global', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--index-dir', indexDir], {
    input: query,
    encoding: 'utf8',
  });
}

function drain(dataDir: string, diagnosticsDir: string, indexDir: string): void {
  const result = spawnSync('node', [CLI, 'drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--index-dir', indexDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);
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

type Envelope = {
  hook: string;
  cwd?: string;
  agent_version?: string;
  brief?: boolean;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  event?: Record<string, unknown>;
};

/**
 * A stand-in for the installed binary. It answers `hook opencode` by echoing blocks derived
 * from the envelope it was handed, and records every envelope so a test can assert what the
 * plugin sent. `exit1`/`slow` drive the degradations the plugin must survive.
 */
function fakeBin(mode: 'ok' | 'exit1' | 'slow' = 'ok'): { bin: string; callsPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fake-bin-'));
  const bin = path.join(root, 'librarian.js');
  const callsPath = path.join(root, 'calls.ndjson');
  fs.writeFileSync(
    bin,
    `const fs = require('fs');
const callsPath = ${JSON.stringify(callsPath)};
const mode = ${JSON.stringify(mode)};
if (process.argv[2] !== 'hook' || process.argv[3] !== 'opencode') {
  process.stderr.write('unexpected argv: ' + JSON.stringify(process.argv.slice(2)) + '\\n');
  process.exit(64);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(callsPath, input.trim() + '\\n');
  if (mode === 'exit1') process.exit(7);
  const envelope = JSON.parse(input);
  if (envelope.hook !== 'chat.message') process.exit(0);
  const text = (envelope.output.parts || []).map((p) => p.text).join('');
  const result = { recall_ok: true, recall: '<librarian-memory injection_id="recall">' + text + '</librarian-memory>\\n' };
  if (envelope.brief) {
    result.brief_ok = true;
    result.brief = '<librarian-memory injection_id="brief">brief</librarian-memory>\\n';
  }
  const write = () => { process.stdout.write(JSON.stringify(result) + '\\n'); process.exit(0); };
  if (mode === 'slow') setTimeout(write, 6000);
  else write();
});
`,
  );
  return { bin, callsPath };
}

function readCalls(file: string): Envelope[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Envelope);
}

function textParts(messages: OpenCodeMessage[]): string[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) => {
      const rec = part as Record<string, unknown>;
      return rec.type === 'text' && typeof rec.text === 'string' ? [rec.text] : [];
    }),
  );
}

function userMessage(id: string, sessionID: string, text: string): [Record<string, unknown>, Record<string, unknown>] {
  return [{ sessionID }, { message: { id, role: 'user', sessionID }, parts: [{ type: 'text', text }] }];
}

// --- The splice (pure) -------------------------------------------------------------------

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

// --- The plugin's contract with `librarian hook opencode` ---------------------------------

test('plugin hooks inject brief on first user and recall on latest user', async () => {
  const cli = fakeBin();
  await withEnv({ LIBRARIAN_BIN: cli.bin }, async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-project-'));
    assert.equal(spawnSync('git', ['init'], { cwd: project }).status, 0);
    const hooks = await LibrarianPlugin({ directory: project });
    await hooks['chat.message'](...userMessage('m1', 's1', 'first'));
    await hooks['chat.message'](...userMessage('m2', 's1', 'wombat failover'));

    const output = {
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'answer' }] },
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] },
      ],
    };
    // OpenCode converts the array it handed us (`toModelMessagesEffect(ze)` after
    // `trigger(…, {messages: ze})`), so the splice must land IN the same array object. Hold a
    // reference to it and assert through that reference, not through a return value.
    const messages = output.messages;
    await hooks['experimental.chat.messages.transform']({}, output);
    assert.equal(output.messages, messages, 'the array object must not be replaced');
    assert.equal((messages[0].parts[0] as Record<string, unknown>).librarian, 'librarian-brief');
    assert.equal((messages[2].parts[0] as Record<string, unknown>).librarian, 'librarian-recall');
    assert.equal(
      (messages[2].parts[0] as Record<string, unknown>).text,
      '<librarian-memory injection_id="recall">wombat failover</librarian-memory>\n',
    );

    // Compaction: `context` arrives as an array and is what OpenCode builds the prompt from.
    const compacting: { context: string[]; prompt?: string } = { context: [] };
    await hooks['experimental.session.compacting']({}, compacting);
    assert.equal(compacting.context.length, 1, 'the memory must be pushed onto the context array in place');
    assert.match(compacting.context[0], /injection_id="brief"/);
    assert.match(compacting.context[0], /injection_id="recall"/);

    // A prompt another plugin already replaced is appended to instead.
    const withPrompt: { prompt: string } = { prompt: 'compact prompt' };
    await hooks['experimental.session.compacting']({}, withPrompt);
    assert.match(withPrompt.prompt, /compact prompt/);
    assert.match(withPrompt.prompt, /injection_id="brief"/);
    assert.match(withPrompt.prompt, /injection_id="recall"/);

    // Every envelope carries the session cwd — the shell resolves resource facts from it, and
    // no OpenCode payload contains it.
    const calls = readCalls(cli.callsPath);
    assert.ok(calls.length >= 4, `expected an envelope per hook fire, got ${calls.length}`);
    assert.ok(calls.every((envelope) => envelope.cwd === project), 'every envelope must carry the session cwd');
    const chat = calls.filter((envelope) => envelope.hook === 'chat.message');
    assert.equal(chat.length, 2);
    assert.equal(chat[0].brief, true, 'the first turn asks for the startup brief');
    assert.equal(chat[1].brief, false, 'a brief already held must not be re-fetched');
  });
});

test('plugin forwards the raw native payload untouched — no mapping in the host process', async () => {
  const cli = fakeBin();
  await withEnv({ LIBRARIAN_BIN: cli.bin }, async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-raw-'));
    const hooks = await LibrarianPlugin({ directory: project });
    const toolInput = { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'git status' } };
    await hooks['tool.execute.after'](toolInput, {});
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's1', version: '0.14.2' } } } });
    await hooks['chat.message'](...userMessage('m1', 's1', 'hello'));

    const calls = readCalls(cli.callsPath);
    const tool = calls.find((envelope) => envelope.hook === 'tool.execute.after');
    assert.deepEqual(tool?.input, toolInput, 'the tool payload goes over the wire verbatim');
    // Session.version appears only on session.created, so the plugin captures it there and
    // stamps that envelope and every later one (the shell is one process per event and cannot
    // remember). The tool fire came first, so it predates the version and carries none.
    assert.equal(calls.find((envelope) => envelope.hook === 'tool.execute.after')?.agent_version, undefined);
    assert.equal(calls.find((envelope) => envelope.hook === 'event')?.agent_version, '0.14.2');
    assert.equal(calls.find((envelope) => envelope.hook === 'chat.message')?.agent_version, '0.14.2');
  });
});

test('plugin forwards tool output for shell tools only — a read never pipes its file', async () => {
  const cli = fakeBin();
  await withEnv({ LIBRARIAN_BIN: cli.bin }, async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-output-'));
    const hooks = await LibrarianPlugin({ directory: project });

    await hooks['tool.execute.after'](
      { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'node -v' } },
      { title: 'node -v', output: 'v24.18.0\n', metadata: {} },
    );
    // A read's `output.output` IS the file. Forwarding it would serialize the whole file
    // into a spawn's stdin on the hottest tool there is, for a field the collector drops.
    await hooks['tool.execute.after'](
      { tool: 'read', sessionID: 's1', callID: 'c2', args: { filePath: '/repo/src/x.ts' } },
      { title: 'x.ts', output: 'SHOULD_NOT_BE_PIPED', metadata: {} },
    );

    const calls = readCalls(cli.callsPath);
    assert.equal(calls.length, 2, 'both tool fires still reach the binary');
    assert.deepEqual(
      (calls[0].output as Record<string, unknown>).output,
      'v24.18.0\n',
      'a shell tool forwards what it printed',
    );
    assert.equal(calls[1].output, undefined, 'a read forwards no output at all');
    assert.ok(
      !JSON.stringify(calls[1]).includes('SHOULD_NOT_BE_PIPED'),
      'the file contents never cross the pipe',
    );
  });
});

test('plugin skips assistant messages and repeated message ids without spawning', async () => {
  const cli = fakeBin();
  await withEnv({ LIBRARIAN_BIN: cli.bin }, async () => {
    const hooks = await LibrarianPlugin({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-dedup-')) });
    await hooks['chat.message']({ sessionID: 's1' }, { message: { id: 'a1', role: 'assistant', sessionID: 's1' }, parts: [{ type: 'text', text: 'answer' }] });
    await hooks['chat.message'](...userMessage('m1', 's1', 'hello'));
    await hooks['chat.message'](...userMessage('m1', 's1', 'hello'));

    const calls = readCalls(cli.callsPath);
    assert.equal(calls.length, 1, 'an assistant message and a re-delivered id must not reach the binary');
    assert.equal(calls[0].hook, 'chat.message');
  });
});

test('plugin compacting leaves output alone when no memory is cached', async () => {
  const cli = fakeBin();
  await withEnv({ LIBRARIAN_BIN: cli.bin }, async () => {
    const hooks = await LibrarianPlugin({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-empty-')) });
    const compacting = { prompt: 'compact prompt', context: [] as string[] };
    await hooks['experimental.session.compacting']({}, compacting);
    assert.deepEqual(compacting, { prompt: 'compact prompt', context: [] }, 'nothing cached means nothing added');
  });
});

test('plugin hooks contain a missing librarian and inject nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-missing-cli-'));
  await withEnv({ LIBRARIAN_BIN: path.join(root, 'missing-librarian') }, async () => {
    const hooks = await LibrarianPlugin({ directory: root });
    await assert.doesNotReject(() => hooks['chat.message'](...userMessage('m1', 's1', 'wombat failover')));
    const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }] };
    await hooks['experimental.chat.messages.transform']({ sessionID: 's1' }, output);
    assert.deepEqual(output.messages, [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }]);
  });
});

test('plugin hooks contain a non-zero exit and a hung binary', async () => {
  for (const mode of ['exit1', 'slow'] as const) {
    const cli = fakeBin(mode);
    await withEnv({ LIBRARIAN_BIN: cli.bin }, async () => {
      const hooks = await LibrarianPlugin({ directory: fs.mkdtempSync(path.join(os.tmpdir(), `opencode-${mode}-cli-`)) });
      await assert.doesNotReject(() => hooks['chat.message'](...userMessage(`m-${mode}`, mode, 'wombat failover')));
      const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }] };
      await hooks['experimental.chat.messages.transform']({ sessionID: mode }, output);
      assert.deepEqual(output.messages, [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'wombat failover' }] }]);
    });
  }
});

// --- The block the plugin splices is `librarian inject`'s stdout, byte for byte ------------

test('spawned inject output is spliced verbatim', () => {
  const t = tempRoot();
  appendNote(t.dataDir, note(1));
  for (let i = 0; i < 8; i += 1) {
    appendNote(t.dataDir, note(20 + i, { body: { summary: `Unrelated filler ${i}.` } }));
  }
  drain(t.dataDir, t.diagnosticsDir, t.indexDir);
  const result = runInject(t.dataDir, t.diagnosticsDir, t.indexDir, 'wombat failover');
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
  drain(t.dataDir, t.diagnosticsDir, t.indexDir);
  const result = runInject(t.dataDir, t.diagnosticsDir, t.indexDir, 'wombat failover');
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
  drain(t.dataDir, t.diagnosticsDir, t.indexDir);
  const result = runInject(t.dataDir, t.diagnosticsDir, t.indexDir, 'commonfloor');
  assert.equal(result.status, 0, `inject should exit 0; stderr: ${result.stderr}`);
  assert.equal(result.stdout, '');

  const messages: OpenCodeMessage[] = [{ role: 'user', parts: [{ type: 'text', text: 'commonfloor' }] }];
  assert.equal(spliceLibrarianInjection(messages, undefined), messages);
});
