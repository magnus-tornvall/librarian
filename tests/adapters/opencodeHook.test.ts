import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll } from '../../src/log/ndjson.ts';
import { appendNote } from '../../src/log/noteLog.ts';
import type { NoteRevision } from '../../src/note.ts';

/**
 * `librarian hook opencode` — the OpenCode plugin's entry point (issue #155, spec §14
 * amendment: thin plugin routed through the installed bin).
 *
 * Black-box only: every test spawns the REAL subcommand, feeds it the envelope the plugin
 * sends (`{hook, cwd, input, output}` wrapping the RAW native OpenCode payload), and asserts
 * on what crosses the two contracts the plugin depends on —
 *
 *   1. canonical events land on the per-session NDJSON log via the real `librarian collect`,
 *   2. the injection blocks the plugin splices come back as JSON on stdout,
 *
 * — plus the hook-safety contract: whatever the input, the process exits 0 and never prints
 * partial garbage on stdout (the plugin parses stdout as JSON; garbage there is worse than
 * silence). The pure mapping is covered by the fixtures in tests/adapters/opencode.test.ts;
 * nothing here re-tests it.
 */

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const HOOK_ARGS = [CLI, 'hook', 'opencode'] as const;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitRepo(projectSlug = 'alpha'): string {
  const root = tempDir('opencode-hook-');
  const repo = path.join(root, projectSlug);
  fs.mkdirSync(repo);
  const init = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  return repo;
}

/**
 * A stand-in `librarian` on the resolution path: it routes `collect`/`inject` to the real CLI
 * against temp dirs, so the hook's own spawns are real work in an isolated store. `failInject`
 * / `slowInject` drive the two degradation paths the plugin must survive.
 */
function makeLibrarianBin(
  dataDir: string,
  diagnosticsDir: string,
  indexDir: string,
  mode: 'ok' | 'fail-inject' | 'slow-inject' = 'ok',
): string {
  const bin = tempDir('opencode-bin-');
  const script = path.join(bin, 'librarian');
  const inject =
    mode === 'fail-inject'
      ? 'exit 99'
      : mode === 'slow-inject'
        ? 'sleep 3'
        : `exec node ${JSON.stringify(CLI)} inject "$@" --data-dir ${JSON.stringify(dataDir)} --diagnostics-dir ${JSON.stringify(diagnosticsDir)} --index-dir ${JSON.stringify(indexDir)}`;
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"
shift || true
case "$cmd" in
  collect) exec node ${JSON.stringify(CLI)} collect --data-dir ${JSON.stringify(dataDir)} ;;
  inject) ${inject} ;;
  machine-id) printf 'test-machine-id\\n' ;;
  *) exec node ${JSON.stringify(CLI)} "$cmd" "$@" ;;
esac
`,
  );
  fs.chmodSync(script, 0o755);
  return path.join(bin, 'librarian');
}

function runHook(envelope: unknown, cwd: string, bin?: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [...HOOK_ARGS], {
    input: typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
    cwd,
    encoding: 'utf8',
    env: bin ? { ...process.env, LIBRARIAN_BIN: bin } : { ...process.env },
  });
}

function events(dataDir: string, sessionId: string): Array<Record<string, unknown>> {
  const file = path.join(dataDir, 'events', `${sessionId}.ndjson`);
  return fs.existsSync(file) ? (readAll(file) as Array<Record<string, unknown>>) : [];
}

function note(index: number, projectSlug: string, overrides: Partial<NoteRevision> = {}): NoteRevision {
  return {
    kind: 'note_revision',
    schema_version: 1,
    note_id: `fact:opencode-hook-${index}`,
    revision_id: `rev-${index}`,
    created_at: `2026-07-06T10:${String(index).padStart(2, '0')}:00.000Z`,
    identity: { mode: 'episodic' },
    source: { origin: 'opencode', distiller: 'llm' },
    note_type: 'decision',
    title: `OpenCode hook title ${index}`,
    scope: { project_slug: projectSlug },
    provenance: {},
    links: [],
    body: { summary: `OpenCode hook summary ${index} about wombat failover.` },
    ...overrides,
  };
}

function drain(dataDir: string, diagnosticsDir: string, indexDir: string): void {
  const result = spawnSync(
    'node',
    [CLI, 'drain', '--data-dir', dataDir, '--diagnostics-dir', diagnosticsDir, '--index-dir', indexDir],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `drain should exit 0; stderr: ${result.stderr}`);
}

/** A corpus that makes `librarian inject` produce a real block for "wombat failover" plus a
 *  startup brief. Mirrors the shape tests/adapters/claudeCode.test.ts uses. */
function seededStore(projectSlug: string): { dataDir: string; diagnosticsDir: string; indexDir: string } {
  const dataDir = tempDir('opencode-hook-data-');
  const diagnosticsDir = tempDir('opencode-hook-diag-');
  const indexDir = tempDir('opencode-hook-index-');
  appendNote(dataDir, note(1, projectSlug));
  appendNote(
    dataDir,
    note(2, projectSlug, {
      note_id: `project:${projectSlug}:summary`,
      revision_id: 'summary-rev',
      note_type: 'project_summary',
      title: 'Alpha project summary',
      body: { summary: 'Alpha summary brief for session start.' },
    }),
  );
  for (let i = 0; i < 8; i += 1) {
    appendNote(dataDir, note(20 + i, projectSlug, { body: { summary: `Unrelated filler ${i}.` } }));
  }
  drain(dataDir, diagnosticsDir, indexDir);
  return { dataDir, diagnosticsDir, indexDir };
}

// --- Collection: every hook the plugin forwards lands as a canonical event --------------

test('hook opencode: a chat.message envelope collects the prompt event with resource facts', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-hook-chat-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  const result = runHook(
    {
      hook: 'chat.message',
      cwd: repo,
      input: { sessionID: 'oc-chat' },
      output: { message: { id: 'm1', role: 'user', sessionID: 'oc-chat' }, parts: [{ type: 'text', text: 'wombat failover' }] },
    },
    repo,
    bin,
  );
  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);

  const [event] = events(dataDir, 'oc-chat');
  assert.equal(event?.type, 'prompt');
  assert.equal(event.prompt, 'wombat failover', 'the raw prompt is shipped; the collector redacts (§5)');
  const resource = event.resource as Record<string, unknown>;
  assert.equal(resource.agent, 'opencode');
  assert.equal(resource.machine_id, 'test-machine-id');
  assert.equal(resource.cwd, repo, 'cwd comes from the envelope — OpenCode payloads do not carry it');
  assert.equal(resource.git_root, fs.realpathSync(repo), 'git facts are resolved from the envelope cwd');
  assert.equal(resource.agent_version, undefined, 'a fact we were not given must be omitted, never invented');
});

test('hook opencode: agent_version from the envelope is stamped onto resource', () => {
  // OpenCode surfaces Session.version only on session.created, so the plugin captures it and
  // stamps every later envelope. The shell is one process per event and cannot remember it.
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-hook-version-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  const result = runHook(
    {
      hook: 'event',
      cwd: repo,
      agent_version: '0.14.2',
      event: { type: 'session.created', properties: { info: { id: 'oc-start', version: '0.14.2' } } },
    },
    repo,
    bin,
  );
  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);

  const [event] = events(dataDir, 'oc-start');
  assert.equal(event?.type, 'session');
  assert.equal(event.action, 'start');
  assert.equal((event.resource as Record<string, unknown>).agent_version, '0.14.2');
  assert.equal(result.stdout, '', 'only chat.message returns anything to the plugin');
});

test('hook opencode: tool, compacting, and session.deleted envelopes each collect one event', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-hook-rest-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  const tool = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: { tool: 'bash', sessionID: 'oc-rest', callID: 'c1', args: { command: 'git commit -m wip' } },
    },
    repo,
    bin,
  );
  assert.equal(tool.status, 0, `tool hook should exit 0; stderr: ${tool.stderr}`);

  const compact = runHook({ hook: 'experimental.session.compacting', cwd: repo, input: { sessionID: 'oc-rest' } }, repo, bin);
  assert.equal(compact.status, 0, `compacting hook should exit 0; stderr: ${compact.stderr}`);

  const ended = runHook(
    { hook: 'event', cwd: repo, event: { type: 'session.deleted', properties: { info: { id: 'oc-rest' } } } },
    repo,
    bin,
  );
  assert.equal(ended.status, 0, `session.deleted hook should exit 0; stderr: ${ended.stderr}`);

  const collected = events(dataDir, 'oc-rest');
  assert.equal(collected.length, 3, 'each envelope collects exactly one event');
  assert.equal(collected[0].type, 'tool');
  assert.equal((collected[0].tool as Record<string, unknown>).category, 'vcs_commit', 'lowering reads args off input.args');
  assert.deepEqual(collected[0].hints, { possibly_salient: true, reason: 'vcs_commit' });
  // The commit landed (no exit code, no interruption) so it closed an arc; the boundary rides
  // the same event as the hint and survives the whole lowering→map→collect path (issue #169).
  assert.deepEqual(collected[0].boundary, { kind: 'semantic', signal: 'git_commit' });
  assert.equal(collected[1].action, 'compact');
  assert.deepEqual(
    collected[1].boundary,
    { kind: 'compaction', signal: 'compact' },
    'compaction is a recorded landmark — collected, but never a completion signal',
  );
  // `session.deleted` lowers to action `end`, not `stop`: it is the one-shot terminal signal,
  // and it must arrive with the same marker Claude Code's `SessionEnd` produces.
  assert.equal(collected[2].action, 'end');
  assert.deepEqual(collected[2].boundary, { kind: 'terminal', signal: 'session_end' });
});

test('hook opencode: a todowrite envelope carries its list through lowering to a todos_complete boundary', () => {
  // The other three markers are proven end-to-end above; this is the one whose detection depends
  // on the plugin forwarding a tool ARG the lowering has to lift (`input.args.todos`). Without it
  // the mapper sees no list and the signal silently never fires (issue #169).
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-hook-todos-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  const done = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: {
        tool: 'todowrite',
        sessionID: 'oc-todos',
        callID: 'c1',
        args: { todos: [{ id: 't1', content: 'ship the boundary events', status: 'completed', priority: 'high' }] },
      },
      output: { title: 'todos', output: '', metadata: {} },
    },
    repo,
    bin,
  );
  assert.equal(done.status, 0, `todowrite hook should exit 0; stderr: ${done.stderr}`);

  const [event] = events(dataDir, 'oc-todos');
  assert.equal(event?.type, 'tool');
  assert.equal((event.tool as Record<string, unknown>).native_name, 'todowrite');
  assert.deepEqual(event.boundary, { kind: 'semantic', signal: 'todos_complete' });
});

test('hook opencode: a bash tool lowers output.output onto the event, a read tool does not', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-hook-outcome-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  const bash = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: { tool: 'bash', sessionID: 'oc-outcome', callID: 'c1', args: { command: 'node -v' } },
      output: { title: 'node -v', output: 'v24.18.0\n', metadata: {} },
    },
    repo,
    bin,
  );
  assert.equal(bash.status, 0, `bash hook should exit 0; stderr: ${bash.stderr}`);

  // A read's `output.output` is the file's contents. The plugin does not even forward it
  // (see the `args.command` gate there), but the shell must drop it regardless — the two
  // halves ship independently, so neither may rely on the other.
  const read = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: { tool: 'read', sessionID: 'oc-outcome', callID: 'c2', args: { filePath: '/repo/src/x.ts' } },
      output: { title: 'x.ts', output: 'export const x = 1;\n', metadata: {} },
    },
    repo,
    bin,
  );
  assert.equal(read.status, 0, `read hook should exit 0; stderr: ${read.stderr}`);

  const collected = events(dataDir, 'oc-outcome');
  assert.equal(collected.length, 2);
  assert.deepEqual(collected[0].outcome, { stdout: 'v24.18.0\n' }, 'a command keeps what it printed');
  assert.equal(collected[1].outcome, undefined, 'a file_read keeps nothing');
});

test('hook opencode: metadata.exit is lifted and drives the command_failed hint', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-hook-exit-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  // The exit code is OpenCode's own verdict, in the same `output` object the plugin already
  // forwards. It is why this adapter can honour command_failed where Claude Code cannot.
  const failed = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: { tool: 'bash', sessionID: 'oc-exit', callID: 'c1', args: { command: 'npm test' } },
      output: { title: 'npm test', output: 'ℹ fail 1\n', metadata: { exit: 1, truncated: false } },
    },
    repo,
    bin,
  );
  assert.equal(failed.status, 0, `hook should exit 0; stderr: ${failed.stderr}`);

  const passed = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: { tool: 'bash', sessionID: 'oc-exit', callID: 'c2', args: { command: 'npm test' } },
      output: { title: 'npm test', output: 'ℹ fail 0\n', metadata: { exit: 0, truncated: false } },
    },
    repo,
    bin,
  );
  assert.equal(passed.status, 0, `hook should exit 0; stderr: ${passed.stderr}`);

  // 12 of 3673 real calls carried a null exit; it must lower to no exit, not to NaN or 0.
  const unknown = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: { tool: 'bash', sessionID: 'oc-exit', callID: 'c3', args: { command: 'echo hi' } },
      output: { title: 'echo hi', output: 'hi\n', metadata: { exit: null } },
    },
    repo,
    bin,
  );
  assert.equal(unknown.status, 0, `hook should exit 0; stderr: ${unknown.stderr}`);

  const collected = events(dataDir, 'oc-exit');
  assert.equal(collected.length, 3);
  assert.deepEqual(collected[0].outcome, { stdout: 'ℹ fail 1\n', exit: 1 });
  assert.deepEqual(collected[0].hints, { possibly_salient: true, reason: 'command_failed' });
  assert.deepEqual(collected[1].outcome, { stdout: 'ℹ fail 0\n', exit: 0 }, 'a zero exit is recorded too');
  assert.equal(collected[1].hints, undefined, 'a zero exit is not a failure');
  assert.deepEqual(collected[2].outcome, { stdout: 'hi\n' }, 'a null exit lowers to no exit at all');
  assert.equal(collected[2].hints, undefined);
});

test('hook opencode: a file tool lowers filePath into files[] with the matching action', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-hook-file-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  const result = runHook(
    {
      hook: 'tool.execute.after',
      cwd: repo,
      input: { tool: 'edit', sessionID: 'oc-file', args: { filePath: '/repo/src/x.ts' } },
    },
    repo,
    bin,
  );
  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);

  const [event] = events(dataDir, 'oc-file');
  assert.deepEqual(event.files, [{ path: '/repo/src/x.ts', action: 'edit' }]);
  assert.deepEqual(event.hints, { possibly_salient: true, reason: 'file_write' });
});

// --- Recall: the blocks the plugin splices come back on stdout ---------------------------

test('hook opencode: chat.message returns the same blocks `librarian inject` renders', () => {
  const projectSlug = 'alpha';
  const repo = makeGitRepo(projectSlug);
  const store = seededStore(projectSlug);
  const bin = makeLibrarianBin(store.dataDir, store.diagnosticsDir, store.indexDir);

  const normalize = (block: string): string =>
    block.replace(/injection_id="[^"]+"/, 'injection_id="<id>"').replace(/indexed_through="[^"]+"/, 'indexed_through="<ts>"');
  const direct = (args: string[], input: string): string => {
    const run = spawnSync(
      'node',
      [CLI, 'inject', '--global', '--project', projectSlug, ...args, '--data-dir', store.dataDir, '--diagnostics-dir', store.diagnosticsDir, '--index-dir', store.indexDir],
      { input, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `direct inject should exit 0; stderr: ${run.stderr}`);
    assert.notEqual(run.stdout, '', 'the seeded corpus should produce a block');
    return run.stdout;
  };

  const result = runHook(
    {
      hook: 'chat.message',
      cwd: repo,
      brief: true,
      input: { sessionID: 'oc-recall' },
      output: {
        message: { id: 'm1', role: 'user', sessionID: 'oc-recall' },
        parts: [{ type: 'text', text: 'wombat failover' }],
      },
    },
    repo,
    bin,
  );
  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);

  const payload = JSON.parse(result.stdout) as { brief_ok: boolean; brief: string; recall_ok: boolean; recall: string };
  assert.equal(payload.brief_ok, true);
  assert.equal(payload.recall_ok, true);
  assert.equal(normalize(payload.brief), normalize(direct(['--session-start', '--session', 'oc-recall'], '')));
  assert.equal(normalize(payload.recall), normalize(direct(['--session', 'oc-recall'], 'wombat failover')));
  assert.equal(events(store.dataDir, 'oc-recall').length, 1, 'recall must not suppress instrumentation');
});

test('hook opencode: `brief: false` asks for recall only', () => {
  const projectSlug = 'alpha';
  const repo = makeGitRepo(projectSlug);
  const store = seededStore(projectSlug);
  const bin = makeLibrarianBin(store.dataDir, store.diagnosticsDir, store.indexDir);

  const result = runHook(
    {
      hook: 'chat.message',
      cwd: repo,
      brief: false,
      input: { sessionID: 'oc-nobrief' },
      output: { message: { id: 'm2', role: 'user', sessionID: 'oc-nobrief' }, parts: [{ type: 'text', text: 'wombat failover' }] },
    },
    repo,
    bin,
  );
  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.brief_ok, undefined, 'a brief the plugin already holds must not be re-fetched');
  assert.equal(payload.recall_ok, true);
});

test('hook opencode: a below-floor prompt reports ok-with-no-block, distinct from a failure', () => {
  // ok:true + no block is what stops the plugin re-asking for a brief every turn; ok:false is
  // what makes it retry. Collapsing the two would either spam inject or lose the brief.
  const projectSlug = 'alpha';
  const repo = makeGitRepo(projectSlug);
  const dataDir = tempDir('opencode-floor-data-');
  const diagnosticsDir = tempDir('opencode-floor-diag-');
  const indexDir = tempDir('opencode-floor-index-');
  for (let i = 0; i < 12; i += 1) {
    appendNote(dataDir, note(i, projectSlug, { body: { summary: `commonfloor token in every note ${i}` } }));
  }
  drain(dataDir, diagnosticsDir, indexDir);
  const bin = makeLibrarianBin(dataDir, diagnosticsDir, indexDir);

  const result = runHook(
    {
      hook: 'chat.message',
      cwd: repo,
      brief: false,
      input: { sessionID: 'oc-floor' },
      output: { message: { id: 'm1', role: 'user', sessionID: 'oc-floor' }, parts: [{ type: 'text', text: 'commonfloor' }] },
    },
    repo,
    bin,
  );
  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.recall_ok, true, 'inject ran fine');
  assert.equal(payload.recall, undefined, 'it just had nothing above the floor to say');
  assert.equal(events(dataDir, 'oc-floor').length, 1, 'a below-floor prompt still collects');
});

test('hook opencode: a failing inject reports recall_ok false, exits 0, and still collects', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-injectfail-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'), 'fail-inject');

  const result = runHook(
    {
      hook: 'chat.message',
      cwd: repo,
      brief: true,
      input: { sessionID: 'oc-injectfail' },
      output: { message: { id: 'm1', role: 'user', sessionID: 'oc-injectfail' }, parts: [{ type: 'text', text: 'wombat failover' }] },
    },
    repo,
    bin,
  );
  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.brief_ok, false);
  assert.equal(payload.recall_ok, false);
  assert.equal(payload.recall, undefined);
  assert.equal(events(dataDir, 'oc-injectfail').length, 1, 'a failed inject must not suppress instrumentation');
});

test('hook opencode: a hanging inject is cut off by the 1s budget, not left to stall the turn', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-injectslow-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'), 'slow-inject');

  const started = process.hrtime.bigint();
  const result = runHook(
    {
      hook: 'chat.message',
      cwd: repo,
      brief: false,
      input: { sessionID: 'oc-injectslow' },
      output: { message: { id: 'm1', role: 'user', sessionID: 'oc-injectslow' }, parts: [{ type: 'text', text: 'wombat failover' }] },
    },
    repo,
    bin,
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.recall_ok, false, 'a timed-out inject is reported as no-block, never as an error');
  assert.ok(elapsedMs < 3_000, `the 1s inject budget must bound the turn; took ${Math.round(elapsedMs)}ms`);
  assert.equal(events(dataDir, 'oc-injectslow').length, 1, 'a timed-out inject must not suppress instrumentation');
});

// --- Hook safety: nothing the plugin can send may break the host session -----------------

test('hook opencode hook-safety: malformed stdin exits 0, prints nothing on stdout, logs to stderr', () => {
  const result = runHook('not json at all {{{', process.cwd());
  assert.equal(result.status, 0, `the hook must exit 0 on a malformed payload; got ${result.status}`);
  assert.equal(result.stdout, '', 'the plugin parses stdout as JSON — garbage there is worse than silence');
  assert.match(result.stderr, /librarian-opencode: ignoring malformed hook payload/);
});

test('hook opencode hook-safety: empty stdin exits 0 silently', () => {
  const result = runHook('', process.cwd());
  assert.equal(result.status, 0, 'the hook must exit 0 on empty stdin');
  assert.equal(result.stdout, '');
});

test('hook opencode hook-safety: an envelope with no `hook` field exits 0 and says why', () => {
  const result = runHook({ cwd: process.cwd(), input: {} }, process.cwd());
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /librarian-opencode: ignoring hook payload with no "hook" field/);
});

test('hook opencode: unrecognized hooks and non-user messages collect nothing', () => {
  const repo = makeGitRepo();
  const dataDir = tempDir('opencode-noop-');
  const bin = makeLibrarianBin(dataDir, tempDir('d-'), tempDir('i-'));

  const cases: unknown[] = [
    // A hook name we do not subscribe to.
    { hook: 'chat.params', cwd: repo, input: { sessionID: 'oc-noop' } },
    // An assistant message — only user prompts are events.
    {
      hook: 'chat.message',
      cwd: repo,
      input: { sessionID: 'oc-noop' },
      output: { message: { id: 'a1', role: 'assistant', sessionID: 'oc-noop' }, parts: [{ type: 'text', text: 'hi' }] },
    },
    // A user message whose only parts are synthetic (our own injected blocks).
    {
      hook: 'chat.message',
      cwd: repo,
      input: { sessionID: 'oc-noop' },
      output: { message: { id: 'm9', role: 'user', sessionID: 'oc-noop' }, parts: [{ type: 'text', text: 'x', synthetic: true }] },
    },
    // session.idle repeats per turn and is deliberately not mapped.
    { hook: 'event', cwd: repo, event: { type: 'session.idle', properties: { info: { id: 'oc-noop' } } } },
    // A tool payload with no tool name.
    { hook: 'tool.execute.after', cwd: repo, input: { sessionID: 'oc-noop', args: {} } },
  ];

  for (const envelope of cases) {
    const result = runHook(envelope, repo, bin);
    assert.equal(result.status, 0, `hook should exit 0; stderr: ${result.stderr}`);
    assert.equal(result.stdout, '', 'a no-op must return nothing to splice');
  }
  assert.equal(events(dataDir, 'oc-noop').length, 0, 'none of these may produce a canonical event');
});

test('hook opencode: a missing librarian is contained — exit 0, no stdout, error on stderr', () => {
  const repo = makeGitRepo();
  const result = runHook(
    {
      hook: 'chat.message',
      cwd: repo,
      brief: true,
      input: { sessionID: 'oc-nobin' },
      output: { message: { id: 'm1', role: 'user', sessionID: 'oc-nobin' }, parts: [{ type: 'text', text: 'wombat failover' }] },
    },
    repo,
    '/nonexistent/librarian-that-cannot-run',
  );
  assert.equal(result.status, 0, `the hook must exit 0 when it cannot reach the CLI; stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.recall_ok, false, 'no CLI means no recall, reported as a failure so the plugin retries');
  assert.match(result.stderr, /librarian-opencode: librarian collect failed to spawn/);
});

test('hook opencode: an unknown hook agent is a loud usage error, not a silent no-op', () => {
  // Only reachable by hand-wiring; a typo must not fail silently and leave an operator
  // wondering why nothing collects.
  const result = spawnSync('node', [CLI, 'hook', 'nope'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /expected hook subcommand: claude-code or opencode/);
});
