import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibrarianPlugin } from '../adapters/opencode/plugin.ts';
import { readAllNotes } from '../src/log/noteLog.ts';
import { readAll } from '../src/log/ndjson.ts';
import type { InjectionTrace } from '../src/diagnostics/injectionTrace.ts';

/**
 * Push-path capstone (issue #53, roadmap item 8).
 *
 * The full loop, end to end, through the REAL adapters — no mocked seams between pipeline
 * stages. Fixture events → `librarian collect` → `librarian distill` (fixture provider) →
 * index → the real adapter entrypoints splice the §6 block → `librarian why` replays the
 * trace by its injection_id.
 *
 * What each unit test already proves in isolation (cli/inject, cli/why, cli/why-not,
 * adapters/claudeCode, adapters/opencode-inject) is NOT re-derived here. The capstone's
 * job is the wire-up: a note minted by the real distiller, surfaced UNPROMPTED through
 * both transports off the same data dir, with the diagnostics trace and `why`/`why-not`
 * replay closing the loop — plus the negative (empty-slot-beats-distractor) proven through
 * the real transports, and the note log byte-identical throughout.
 */

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const HOOK = path.join(import.meta.dirname, '..', 'adapters', 'claude-code', 'hook.ts');
const PROJECT_SLUG = 'librarian';

// The judgment the fixture inference provider returns for the eligible session. Content that
// exists ONLY here (never in the raw events) proves the note came from real distillation.
const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Quokka index rebuild decision',
  summary: 'Rebuild the quokka search index nightly and keep the rollout global for every project.',
  bullets: ['The quokka index must be rebuilt nightly to stay consistent with the note log.'],
});

function makeTempDirs(): { root: string; dataDir: string; diagnosticsDir: string; fixturePath: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-path-capstone-'));
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = path.join(root, 'llm-response.json');
  fs.writeFileSync(fixturePath, LLM_RESPONSE);
  // A real git repo named after the project so both adapters attribute --project <slug>.
  const repo = path.join(root, PROJECT_SLUG);
  fs.mkdirSync(repo);
  assert.equal(spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' }).status, 0, 'git init should succeed');
  return { root, dataDir, diagnosticsDir, fixturePath, repo };
}

function runCli(args: string[], stdin = ''): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

function event(sessionId: string, turn: number, overrides: Record<string, unknown>): Record<string, unknown> {
  const seq = String(turn).padStart(2, '0');
  const cwd = '/Users/magnus/dev/librarian';
  return {
    schema_version: 1,
    event_id: `01J8X7QR${seq}Z9R4M2N6P0S5T7WY`,
    ts: `2026-07-08T09:${seq}:00.000Z`,
    resource: {
      agent: 'opencode',
      agent_version: '1.2.3',
      machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX',
      cwd,
      git_root: cwd,
      git_remote: 'git@github.com:magnus-tornvall/librarian.git',
      git_branch: 'feat/push-path-capstone',
    },
    context: { session_id: sessionId, turn, cwd },
    ...overrides,
  };
}

/** An eligible session: ≥10 events, ≥2 prompts, ≥1 write → the distill heuristic mints a note. */
function fixtureEvents(sessionId: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    event(sessionId, 1, { type: 'prompt', prompt: 'Investigate the aardvark-only latency spike in index rebuilds.' }),
    event(sessionId, 2, {
      type: 'tool',
      tool: { native_name: 'Write', canonical_name: 'write', category: 'file_write' },
      files: [{ path: 'src/index/rebuild.ts' }],
    }),
    event(sessionId, 3, { type: 'prompt', prompt: 'Add coverage for the aardvark rebuild path before finishing.' }),
  ];
  for (let turn = 4; turn <= 11; turn += 1) {
    events.push(
      event(sessionId, turn, {
        type: 'tool',
        tool: { native_name: 'Read', canonical_name: 'read', category: 'file_read' },
        files: [{ path: `src/index/file-${turn}.ts` }],
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

function distill(t: { dataDir: string; diagnosticsDir: string; fixturePath: string }): void {
  const result = runCli([
    'distill',
    '--data-dir',
    t.dataDir,
    '--diagnostics-dir',
    t.diagnosticsDir,
    '--provider-fixture',
    t.fixturePath,
  ]);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);
}

/**
 * A fake `librarian` on PATH for the Claude Code hook that delegates collect/inject to the
 * REAL CLI against the capstone's temp dirs. Identical delegation to the adapter unit tests —
 * the hook still spawns a real process, this only redirects the data dir so the hook reads the
 * distilled note. (The alternative — mutating ~/.librarian — is what diagnostics isolation forbids.)
 */
function makeLibrarianBin(root: string, dataDir: string, diagnosticsDir: string): string {
  const bin = fs.mkdtempSync(path.join(root, 'cc-bin-'));
  const script = path.join(bin, 'librarian');
  const body = `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"
shift || true
case "$cmd" in
  collect) exec node ${JSON.stringify(CLI)} collect --data-dir ${JSON.stringify(dataDir)} ;;
  inject) exec node ${JSON.stringify(CLI)} inject "$@" --data-dir ${JSON.stringify(dataDir)} --diagnostics-dir ${JSON.stringify(diagnosticsDir)} ;;
  machine-id) printf 'capstone-machine-id\\n' ;;
  *) exec node ${JSON.stringify(CLI)} "$cmd" "$@" ;;
esac
`;
  fs.writeFileSync(script, body);
  fs.chmodSync(script, 0o755);
  return bin;
}

/**
 * A JS `LIBRARIAN_BIN` for the OpenCode plugin that execs the REAL CLI, appending the temp
 * data/diagnostics dirs (the plugin's injectArgs deliberately omit them → default ~/.librarian).
 * Node runs this .js shim, the shim spawns `node src/cli.ts …` — a real process both hops.
 */
function makeOpenCodeBin(root: string, dataDir: string, diagnosticsDir: string): string {
  const bin = path.join(fs.mkdtempSync(path.join(root, 'oc-bin-')), 'librarian.js');
  fs.writeFileSync(
    bin,
    `const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const cmd = args[0];
const dirs = cmd === 'inject'
  ? ['--data-dir', ${JSON.stringify(dataDir)}, '--diagnostics-dir', ${JSON.stringify(diagnosticsDir)}]
  : cmd === 'collect'
    ? ['--data-dir', ${JSON.stringify(dataDir)}]
    : [];
if (cmd === 'machine-id') { process.stdout.write('capstone-machine-id\\n'); process.exit(0); }
const r = spawnSync('node', [${JSON.stringify(CLI)}, ...args, ...dirs], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`,
  );
  return bin;
}

function runHookEntry(payload: unknown, repo: string, bin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
}

function normalizeBlock(block: string): string {
  return block
    .replace(/injection_id="[^"]+"/, 'injection_id="<id>"')
    .replace(/indexed_through="[^"]+"/, 'indexed_through="<ts>"');
}

function injectionIdOf(block: string): string {
  const match = block.match(/injection_id="([^"]+)"/);
  assert.ok(match, `block must carry an injection_id: ${block}`);
  return match[1];
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

/** Recursively enumerate every file written under a directory, relative to it. */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full).map((child) => path.join(entry.name, child)));
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/** Byte-snapshot every file under a directory, keyed by relative path — for whole-tree immutability checks. */
function snapshotDir(dir: string): Record<string, string> {
  return Object.fromEntries(listFiles(dir).map((rel) => [rel, fs.readFileSync(path.join(dir, rel), 'utf8')]));
}

/**
 * The distiller is dumb — it mints an episodic note with a fresh ULID id, not a stable one.
 * Seed enough realistic decoys that the corpus IDF stays positive (a lone note scores below
 * floor, §6), then distill so the ONE source-provenanced note is the real thing recall ships.
 */
function seedDecoysViaSession(t: { dataDir: string; diagnosticsDir: string; fixturePath: string }): void {
  // Five extra eligible sessions with unrelated content → five extra distilled notes as decoys.
  for (let d = 0; d < 5; d += 1) {
    const sessionId = `push-capstone-decoy-${d}`;
    const decoyFixture = path.join(path.dirname(t.fixturePath), `decoy-${d}.json`);
    fs.writeFileSync(
      decoyFixture,
      JSON.stringify({
        note_type: 'fact',
        title: `Unrelated release checklist ${d}`,
        summary: `Assorted release checklist ${d} covering editor settings and changelog hygiene.`,
        bullets: [`Release checklist ${d} step about tagging the changelog.`],
      }),
    );
    const events: Array<Record<string, unknown>> = [
      event(sessionId, 1, { type: 'prompt', prompt: `Draft the release checklist number ${d} for the changelog.` }),
      event(sessionId, 2, {
        type: 'tool',
        tool: { native_name: 'Write', canonical_name: 'write', category: 'file_write' },
        files: [{ path: `docs/checklist-${d}.md` }],
      }),
      event(sessionId, 3, { type: 'prompt', prompt: `Review the release checklist ${d} once more.` }),
    ];
    for (let turn = 4; turn <= 11; turn += 1) {
      events.push(
        event(sessionId, turn, {
          type: 'tool',
          tool: { native_name: 'Read', canonical_name: 'read', category: 'file_read' },
          files: [{ path: `docs/misc-${d}-${turn}.md` }],
        }),
      );
    }
    collect(t.dataDir, events);
    distill({ dataDir: t.dataDir, diagnosticsDir: t.diagnosticsDir, fixturePath: decoyFixture });
  }
}

test('push path capstone: a real distilled note surfaces unprompted through BOTH adapters, replays via `why`, and never leaks past diagnostics', async () => {
  const t = makeTempDirs();
  const sessionId = 'push-path-capstone-session';

  // --- Real pipeline: collect → distill (fixture provider) → index -----------------------
  seedDecoysViaSession(t);
  collect(t.dataDir, fixtureEvents(sessionId));
  distill(t);

  const minted = (readAllNotes(t.dataDir) as Array<Record<string, unknown>>).filter(
    (note) => (note.provenance as Record<string, unknown> | undefined)?.session_id === sessionId,
  );
  assert.equal(minted.length, 1, 'the real distill pass must mint exactly one source-provenanced note for the target session');
  const note = minted[0];
  const noteId = note.note_id as string;

  const notesBefore = snapshotNotes(t.dataDir);
  const query = 'quokka index rebuild'; // content that lives only in the distilled note, not the events

  // --- Ground truth: the seam itself renders the §6 block for this query -----------------
  const seam = runCli(
    ['inject', '--global', '--project', PROJECT_SLUG, '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir],
    query,
  );
  assert.equal(seam.status, 0, `seam inject should exit 0; stderr: ${seam.stderr}`);
  assert.match(seam.stdout, /^<librarian-memory /, 'the query should surface the distilled note as a §6 block');
  assert.match(seam.stdout, /Quokka index rebuild decision/, 'the block carries the distilled note title');

  // --- Adapter A: Claude Code hook (UserPromptSubmit) → additionalContext ----------------
  const bin = makeLibrarianBin(t.root, t.dataDir, t.diagnosticsDir);
  const ccResult = runHookEntry(
    { session_id: 'cc-capstone', cwd: t.repo, hook_event_name: 'UserPromptSubmit', prompt: query },
    t.repo,
    bin,
  );
  assert.equal(ccResult.status, 0, `claude-code hook should exit 0; stderr: ${ccResult.stderr}`);
  const ccOutput = JSON.parse(ccResult.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assert.equal(ccOutput.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ccBlock = ccOutput.hookSpecificOutput.additionalContext;
  assert.equal(
    normalizeBlock(ccBlock),
    normalizeBlock(seam.stdout),
    'the Claude Code additionalContext must be byte-identical to the seam block (modulo the fresh injection_id/indexed_through)',
  );

  // The injection_id carried invisibly with the prompt replays the full trace via `librarian why`.
  const ccInjectionId = injectionIdOf(ccBlock);
  const ccWhy = runCli(['why', ccInjectionId, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(ccWhy.status, 0, `why <cc injection_id> should exit 0; stderr: ${ccWhy.stderr}`);
  assert.match(ccWhy.stdout, /Path: push/, 'why must replay the push trace for the hook injection');
  assert.match(ccWhy.stdout, new RegExp(`Query: ${query}`), 'why must echo the shipped query');
  assert.match(ccWhy.stdout, new RegExp(`${noteId}:.*shipped`), 'why must show the distilled note as the shipped candidate');
  assert.match(ccWhy.stdout, /Config: .*relevanceFloor/, 'why must include the config snapshot');

  // Cross-check against the raw trace: the injection_id, path, query, and shipped set all line up.
  const ccTrace = readTraces(t.diagnosticsDir).find((row) => row.injection_id === ccInjectionId);
  assert.ok(ccTrace, 'the hook injection_id must resolve to a persisted push trace');
  assert.equal(ccTrace.path, 'push');
  assert.equal(ccTrace.query, query);
  assert.deepEqual(ccTrace.shipped_note_ids, [noteId], 'the trace ships exactly the distilled note');

  // --- Adapter B: OpenCode two-phase splice → exactly one tagged part ---------------------
  const ocBin = makeOpenCodeBin(t.root, t.dataDir, t.diagnosticsDir);
  const prevBin = process.env.LIBRARIAN_BIN;
  const prevRuntime = process.env.LIBRARIAN_RUNTIME;
  const prevMachine = process.env.MACHINE_ID_PATH;
  const machineIdPath = path.join(t.root, 'machine-id');
  fs.writeFileSync(machineIdPath, 'capstone-machine-id\n');
  try {
    process.env.LIBRARIAN_BIN = ocBin;
    process.env.LIBRARIAN_RUNTIME = process.execPath;
    process.env.MACHINE_ID_PATH = machineIdPath;

    const hooks = await LibrarianPlugin({ directory: t.repo });
    // Phase 1: the user's prompt drives collect + inject; recall is cached for this session.
    await hooks['chat.message'](
      { sessionID: 'oc-capstone' },
      { message: { id: 'oc-m1', role: 'user', sessionID: 'oc-capstone' }, parts: [{ type: 'text', text: query }] },
    );
    // Phase 2: the transform splices the cached block onto the latest user message.
    const output = {
      messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: query }] }],
    };
    await hooks['experimental.chat.messages.transform']({ sessionID: 'oc-capstone' }, output);

    const taggedParts = output.messages
      .flatMap((message) => message.parts as Array<Record<string, unknown>>)
      .filter((part) => part.librarian === 'librarian-recall');
    assert.equal(taggedParts.length, 1, 'OpenCode must splice exactly one tagged recall part');
    const ocBlock = taggedParts[0].text as string;
    assert.equal(
      normalizeBlock(ocBlock),
      normalizeBlock(seam.stdout),
      'the OpenCode tagged part must carry the same §6 block content the seam emits',
    );

    // Same loop closes: the OpenCode injection_id replays its own push trace.
    const ocInjectionId = injectionIdOf(ocBlock);
    const ocWhy = runCli(['why', ocInjectionId, '--diagnostics-dir', t.diagnosticsDir]);
    assert.equal(ocWhy.status, 0, `why <oc injection_id> should exit 0; stderr: ${ocWhy.stderr}`);
    assert.match(ocWhy.stdout, /Path: push/, 'the OpenCode injection must also replay as a push trace');
    assert.match(ocWhy.stdout, new RegExp(`${noteId}:.*shipped`), 'the OpenCode trace ships the distilled note');
  } finally {
    restoreEnv('LIBRARIAN_BIN', prevBin);
    restoreEnv('LIBRARIAN_RUNTIME', prevRuntime);
    restoreEnv('MACHINE_ID_PATH', prevMachine);
  }

  // --- Isolation: the NOTE log is byte-identical (memory is read-only across recall) -----
  // Note the scope of this claim: the adapters DO write to data/events/ — driving the real
  // hook/plugin collects the prompt as an event (that is instrumentation, by design). What must
  // never change is data/notes/: recall/injection may not rewrite distilled memory. The stronger
  // "only diagnostics changes" claim is proven for the bare inject/why seam in its own test below.
  assert.deepEqual(
    snapshotNotes(t.dataDir),
    notesBefore,
    'neither adapter nor `why` may mutate the note log — distilled memory is read-only across recall',
  );
  const diagFiles = listFiles(t.diagnosticsDir);
  assert.ok(
    diagFiles.some((rel) => rel.startsWith(`injections${path.sep}`)),
    'injection traces must land under diagnostics/injections/',
  );
});

test('push path capstone (negative): a below-floor prompt yields NO injection through either adapter, and the trace records the below_floor cut', async () => {
  const t = makeTempDirs();

  // A corpus where a shared token appears in EVERY note → its IDF collapses → any query on it
  // scores below the relevance floor. This is the empty-slot-beats-distractor rule (§6): a lone
  // distractor never gets force-filled into an empty slot.
  for (let d = 0; d < 6; d += 1) {
    const sessionId = `push-capstone-floor-${d}`;
    const floorFixture = path.join(path.dirname(t.fixturePath), `floor-${d}.json`);
    fs.writeFileSync(
      floorFixture,
      JSON.stringify({
        note_type: 'decision',
        title: `Commonfloor decision ${d}`,
        summary: `Commonfloor commonfloor commonfloor note ${d} about commonfloor routine housekeeping.`,
        bullets: [`Commonfloor step ${d} in the commonfloor housekeeping routine.`],
      }),
    );
    const events: Array<Record<string, unknown>> = [
      event(sessionId, 1, { type: 'prompt', prompt: `Note the commonfloor housekeeping routine ${d}.` }),
      event(sessionId, 2, {
        type: 'tool',
        tool: { native_name: 'Write', canonical_name: 'write', category: 'file_write' },
        files: [{ path: `docs/floor-${d}.md` }],
      }),
      event(sessionId, 3, { type: 'prompt', prompt: `Confirm the commonfloor routine ${d}.` }),
    ];
    for (let turn = 4; turn <= 11; turn += 1) {
      events.push(
        event(sessionId, turn, {
          type: 'tool',
          tool: { native_name: 'Read', canonical_name: 'read', category: 'file_read' },
          files: [{ path: `docs/floor-${d}-${turn}.md` }],
        }),
      );
    }
    collect(t.dataDir, events);
    distill({ dataDir: t.dataDir, diagnosticsDir: t.diagnosticsDir, fixturePath: floorFixture });
  }

  const floorNote = (readAllNotes(t.dataDir) as Array<Record<string, unknown>>).find((note) =>
    (note.note_id as string).startsWith('decision:'),
  );
  assert.ok(floorNote, 'the floor corpus must contain at least one distilled decision note');
  const floorNoteId = floorNote.note_id as string;
  const query = 'commonfloor';
  const notesBefore = snapshotNotes(t.dataDir);

  // Ground truth: the seam itself ships nothing for a below-floor query.
  const seam = runCli(
    ['inject', '--global', '--project', PROJECT_SLUG, '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir],
    query,
  );
  assert.equal(seam.status, 0, `seam inject should exit 0; stderr: ${seam.stderr}`);
  assert.equal(seam.stdout, '', 'a below-floor query surfaces no block');

  // Adapter A: Claude Code hook emits no additionalContext at all. Its own diagnostics dir keeps
  // its trace store separate from the direct-seam one above, so the below_floor assertion below
  // is proven against the trace THIS transport wrote, not the seam's.
  const ccDiag = path.join(t.root, 'cc-diag');
  const bin = makeLibrarianBin(t.root, t.dataDir, ccDiag);
  const ccResult = runHookEntry(
    { session_id: 'cc-floor', cwd: t.repo, hook_event_name: 'UserPromptSubmit', prompt: query },
    t.repo,
    bin,
  );
  assert.equal(ccResult.status, 0, `claude-code hook should exit 0; stderr: ${ccResult.stderr}`);
  assert.equal(ccResult.stdout, '', 'below-floor: the hook must emit no hookSpecificOutput through the real transport');

  // Adapter B: OpenCode splices zero tagged parts — likewise against its own diagnostics dir.
  const ocDiag = path.join(t.root, 'oc-diag');
  const ocBin = makeOpenCodeBin(t.root, t.dataDir, ocDiag);
  const prevBin = process.env.LIBRARIAN_BIN;
  const prevRuntime = process.env.LIBRARIAN_RUNTIME;
  const prevMachine = process.env.MACHINE_ID_PATH;
  const machineIdPath = path.join(t.root, 'machine-id');
  fs.writeFileSync(machineIdPath, 'capstone-machine-id\n');
  try {
    process.env.LIBRARIAN_BIN = ocBin;
    process.env.LIBRARIAN_RUNTIME = process.execPath;
    process.env.MACHINE_ID_PATH = machineIdPath;

    const hooks = await LibrarianPlugin({ directory: t.repo });
    await hooks['chat.message'](
      { sessionID: 'oc-floor' },
      { message: { id: 'oc-floor-1', role: 'user', sessionID: 'oc-floor' }, parts: [{ type: 'text', text: query }] },
    );
    const output = { messages: [{ info: { role: 'user' }, parts: [{ type: 'text', text: query }] }] };
    await hooks['experimental.chat.messages.transform']({ sessionID: 'oc-floor' }, output);
    const taggedParts = output.messages
      .flatMap((message) => message.parts as Array<Record<string, unknown>>)
      .filter((part) => part.librarian === 'librarian-recall');
    assert.equal(taggedParts.length, 0, 'below-floor: OpenCode must splice zero tagged parts through the real transport');
  } finally {
    restoreEnv('LIBRARIAN_BIN', prevBin);
    restoreEnv('LIBRARIAN_RUNTIME', prevRuntime);
    restoreEnv('MACHINE_ID_PATH', prevMachine);
  }

  // The diagnostics trace proves the drop was a below_floor cut, not a silent miss — the empty
  // slot beat the distractor on the record. Asserted PER TRANSPORT against each adapter's own
  // diagnostics dir, so each trace can only have come from that adapter's real inject call.
  for (const [label, diag] of [
    ['seam', t.diagnosticsDir],
    ['claude-code', ccDiag],
    ['opencode', ocDiag],
  ] as const) {
    const floorTrace = readTraces(diag).find(
      (row) => row.path === 'push' && row.query === query && row.shipped_note_ids.length === 0,
    );
    assert.ok(floorTrace, `${label}: diagnostics must contain a push trace for the below-floor query that shipped nothing`);
    const cut = floorTrace.candidates.find((candidate) => candidate.note_id === floorNoteId);
    assert.ok(cut, `${label}: the below-floor note must appear as a recorded candidate`);
    assert.equal(cut.cut_reason, 'below_floor', `${label}: the candidate must be cut for below_floor, proving the floor gate fired`);
  }

  // `why-not` on the same note names the gate the floor applied — the human-facing explanation.
  const whyNot = runCli(['why-not', query, floorNoteId, '--global', '--project', PROJECT_SLUG, '--data-dir', t.dataDir]);
  assert.equal(whyNot.status, 0, `why-not should exit 0; stderr: ${whyNot.stderr}`);
  assert.match(whyNot.stdout, /Gate: below_floor/, 'why-not must name the below_floor gate for the cut note');

  assert.deepEqual(snapshotNotes(t.dataDir), notesBefore, 'the negative path must leave the note log byte-identical too');
});

test('push path capstone (isolation): the bare inject/why seam confines every write to diagnostics — all of data/ is byte-identical', () => {
  // The positive/negative tests drive the full adapters, which also collect prompt events (an
  // expected write to data/events/). This test isolates the injection/recall seam itself — the
  // one path that must be strictly read-only against the whole data dir — by driving `inject`
  // and `why` directly, with no `collect` in the loop. Here the strong claim holds: nothing
  // under data/ may change, and the only new writes land under diagnostics/.
  const t = makeTempDirs();
  seedDecoysViaSession(t);
  collect(t.dataDir, fixtureEvents('push-isolation-session'));
  distill(t);

  const dataBefore = snapshotDir(t.dataDir);
  const query = 'quokka index rebuild';

  const seam = runCli(
    ['inject', '--global', '--project', PROJECT_SLUG, '--data-dir', t.dataDir, '--diagnostics-dir', t.diagnosticsDir],
    query,
  );
  assert.equal(seam.status, 0, `seam inject should exit 0; stderr: ${seam.stderr}`);
  const injectionId = injectionIdOf(seam.stdout);

  const why = runCli(['why', injectionId, '--diagnostics-dir', t.diagnosticsDir]);
  assert.equal(why.status, 0, `why should exit 0; stderr: ${why.stderr}`);

  // The whole data dir — events AND notes — is untouched by inject/why.
  assert.deepEqual(snapshotDir(t.dataDir), dataBefore, 'inject/why must not write anything under data/ — the seam is read-only');
  // And the only place a write landed is diagnostics/injections/.
  assert.ok(
    listFiles(t.diagnosticsDir).some((rel) => rel.startsWith(`injections${path.sep}`)),
    'the injection trace must land under diagnostics/injections/',
  );
});

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}
