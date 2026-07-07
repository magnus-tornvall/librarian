import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Roadmap item 6 capstone (issue #32): prove REAL instrumentation end-to-end.
//
// This is the item-6 analog of tests/walkingSkeleton.integration.test.ts (item 4)
// and tests/curatedPath.integration.test.ts (item 5). It walks recorded NATIVE
// agent events from BOTH adapters through the full pipeline —
//
//   native payload → adapter map() → spawned `librarian collect`
//     → spawned `librarian distill --provider-fixture …` → note log
//     → index → recall
//
// — and asserts the loop closes with correct origins, weights, and diagnostics.
//
// The two pure adapters are the ONLY per-adapter logic here; everything downstream
// is shared. `collect` and `distill` are the REAL CLI, spawned against real temp
// dirs (§14) — never an in-process call. Per the Definition of Done the collect
// step must NOT reach the log through the collector's in-process append primitive;
// it is proven only through the spawned CLI boundary. The §4 test at the bottom is
// the guard that keeps that honest by scanning this file's own source.
import * as opencodeAdapter from '../adapters/opencode/map.ts';
import * as claudeCodeAdapter from '../adapters/claude-code/map.ts';
// Downstream pipeline stages, imported from the exact modules the roadmap names.
import { migrate } from '../src/index/schema.ts'; // FTS5 schema
import { indexNotes } from '../src/index/indexer.ts'; // indexer
import { recall } from '../src/recall/query.ts'; // recall query
import { readAll } from '../src/log/ndjson.ts'; // ndjson reader (event + verdict logs)
import { appendNote } from '../src/log/noteLog.ts'; // note log (decoy corpus only)
import { readAllNotes } from '../src/log/noteLog.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

// ---------------------------------------------------------------------------
// Adapter matrix. Each row wires the capstone to one real, merged adapter: its
// pure `map()`, its origin (the `resource.agent` the plugin/hook stamps and the
// distiller denormalizes into `source.origin`, §5), and a builder that lowers a
// terse per-adapter session script into that adapter's NATIVE payload shape.
//
// OpenCode's native payload is the SDK-normalized terse shape ({kind, tool, …});
// Claude Code's is the real hook JSON ({hook_event_name, tool_name, tool_input,
// …}). The capstone drives BOTH through their own native surface so it exercises
// the adapters as production would, not a shared stand-in.
// ---------------------------------------------------------------------------

type SessionStep =
  | { kind: 'prompt'; text: string }
  | { kind: 'write'; file: string }
  | { kind: 'read'; file: string };

type Adapter = {
  origin: string;
  map: (payload: any, env: any) => any[];
  /** Lower one terse step into this adapter's native payload shape. */
  toNative: (step: SessionStep, sessionId: string, cwd: string) => Record<string, unknown>;
};

const OPENCODE: Adapter = {
  origin: 'opencode',
  map: opencodeAdapter.map as (payload: any, env: any) => any[],
  toNative(step) {
    switch (step.kind) {
      case 'prompt':
        return { kind: 'prompt', text: step.text };
      case 'write':
        return { kind: 'tool', tool: 'write', files: [{ path: step.file }] };
      case 'read':
        return { kind: 'tool', tool: 'read', files: [{ path: step.file }] };
    }
  },
};

const CLAUDE_CODE: Adapter = {
  origin: 'claude-code',
  map: claudeCodeAdapter.map as (payload: any, env: any) => any[],
  toNative(step, sessionId, cwd) {
    const common = { session_id: sessionId, cwd };
    switch (step.kind) {
      case 'prompt':
        return { ...common, hook_event_name: 'UserPromptSubmit', prompt: step.text };
      case 'write':
        return {
          ...common,
          hook_event_name: 'PostToolUse',
          tool_name: 'Write',
          tool_input: { file_path: step.file, content: '// ...\n' },
        };
      case 'read':
        return {
          ...common,
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: step.file },
        };
    }
  },
};

// ---------------------------------------------------------------------------
// Fixtures shared across adapters.
// ---------------------------------------------------------------------------

/** The canned distill judgment — a fixture provider, NOT a live model (§2/§14). */
const LLM_RESPONSE = JSON.stringify({
  note_type: 'decision',
  title: 'Guard token expiry before redirect',
  summary:
    'Fixed the login redirect loop by checking token expiry before redirect; added a regression test.',
});

/**
 * A realistic ELIGIBLE session script: 11 native events with ≥2 prompts and a
 * file write, so the distiller's skip heuristic (§3: ≥10 events, and a write /
 * ≥2 prompts) admits it. Parameterized by a distinctive query TERM woven into a
 * prompt so recall can find exactly this session's note and no other.
 */
function eligibleScript(term: string): SessionStep[] {
  const steps: SessionStep[] = [
    { kind: 'prompt', text: `fix the login ${term} bug, it loops on expired tokens` },
    { kind: 'write', file: 'src/auth/session.ts' },
    { kind: 'prompt', text: `now add a regression test for the ${term} expiry path` },
  ];
  for (let i = 4; i <= 11; i += 1) {
    steps.push({ kind: 'read', file: `src/file-${i}.ts` });
  }
  return steps; // 11 events, 2 prompts, 1 write
}

/**
 * Decoy corpus. FTS5's bm25() IDF term collapses to ~0 in a tiny single-document
 * corpus, so a lone note scores below the relevance floor and recall returns [].
 * Realistic filler (none of it carrying the distinctive query terms) gives bm25 a
 * nonzero, honest score for the notes under test — mirrors the decoy idiom in the
 * walking-skeleton and curated-path capstones. Dated near "now" so the recency
 * term does not separate them; only lexis + the §6 weights decide recall.
 */
function seedDecoyNotes(dataDir: string): void {
  const createdAt = new Date().toISOString();
  for (let i = 0; i < 5; i += 1) {
    appendNote(dataDir, {
      kind: 'note_revision',
      schema_version: 1,
      note_id: `decoy:${i}`,
      revision_id: `decoy-rev-${i}`,
      created_at: createdAt,
      identity: { mode: 'episodic' },
      source: { origin: 'opencode', distiller: 'llm' },
      note_type: 'fact',
      title: `Unrelated filler note ${i}`,
      scope: { global: true },
      provenance: {},
      links: [],
      body: { summary: `Miscellaneous unrelated content number ${i} about assorted topics.` },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers: temp dirs + the REAL CLI (spawned), never an in-process call.
// ---------------------------------------------------------------------------

function makeTempDirs(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, 'data');
  const diagnosticsDir = path.join(root, 'diagnostics');
  const fixturePath = path.join(root, 'llm-response.json');
  fs.writeFileSync(fixturePath, LLM_RESPONSE);
  return { root, dataDir, diagnosticsDir, fixturePath, cursorPath: path.join(dataDir, 'index-cursor.json') };
}

function runCli(args: string[], stdin: string): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, ...args], { input: stdin, encoding: 'utf8' });
}

/** Pipe canonical events through the REAL `librarian collect` (spawned). */
function collect(dataDir: string, events: Array<Record<string, unknown>>): void {
  const stdin = events.map((e) => JSON.stringify(e) + '\n').join('');
  const result = runCli(['collect', '--data-dir', dataDir], stdin);
  assert.equal(result.status, 0, `collect should exit 0; stderr: ${result.stderr}`);
}

/** Run the REAL `librarian distill` with the offline fixture provider (spawned). */
function distill(t: { dataDir: string; diagnosticsDir: string; fixturePath: string }): ReturnType<typeof spawnSync> {
  return runCli(
    [
      'distill',
      '--data-dir',
      t.dataDir,
      '--diagnostics-dir',
      t.diagnosticsDir,
      '--provider-fixture',
      t.fixturePath,
    ],
    '',
  );
}

function noteRevisions(dataDir: string): Array<Record<string, unknown>> {
  return (readAllNotes(dataDir) as Array<Record<string, unknown>>).filter((n) => n.kind === 'note_revision');
}

/**
 * Map a whole session script through an adapter's PURE map(), stamping a fixed
 * per-step ULID/ts (the plugin/hook shell owns this I/O in production; here the
 * capstone injects it, exactly as the adapter unit tests do). Returns the
 * canonical events ready for the wire.
 */
function mapSession(adapter: Adapter, sessionId: string, script: SessionStep[]): Array<Record<string, unknown>> {
  const cwd = '/Users/magnus/dev/librarian';
  const resource = {
    agent: adapter.origin, // the origin the distiller denormalizes into source.origin (§5)
    agent_version: '1.2.3',
    machine_id: '01J8X7QK3VZ9R4M2N6P0S5T7WX',
    cwd,
    git_root: cwd,
    git_remote: 'git@github.com:magnus-tornvall/librarian.git',
    git_branch: 'feat/instrumentation-capstone',
  };

  const events: Array<Record<string, unknown>> = [];
  script.forEach((step, i) => {
    const seq = String(i + 1).padStart(2, '0');
    const env = {
      event_id: `01J8X7QK${seq}Z9R4M2N6P0S5T7WY`,
      ts: `2026-07-06T09:${seq}:00.000Z`,
      resource,
      context: { session_id: sessionId, turn: i + 1, cwd },
    };
    const mapped = adapter.map(adapter.toNative(step, sessionId, cwd), env);
    // Every eligible-script step maps to exactly one canonical event.
    assert.equal(mapped.length, 1, `${adapter.origin} step ${i + 1} must map to exactly one event`);
    events.push(mapped[0] as Record<string, unknown>);
  });
  return events;
}

/**
 * The distinctive recall term woven into every eligible fixture. The decoy
 * corpus deliberately never uses it, so bm25's IDF stays high and the distilled
 * note clears the relevance floor. Each §1 case runs in its own temp data dir, so
 * the shared term never causes cross-session collisions there; §2 relies on both
 * notes matching this same term to prove both origins surface in one recall.
 */
const QUERY_TERM = 'redirect';

// ===========================================================================
// Section 1 — per-adapter loop closure (opencode + claude-code).
//
// For EACH adapter: a realistic eligible native session → mapped → real collect
// → real distill (fixture provider) → exactly one NoteRevision on the note log
// carrying the adapter's origin, distiller "llm", and provenance event_ids that
// all exist in the event log. Then index + recall on a term from the fixture →
// the note is returned and its ORIGIN survives into the recall result.
// ===========================================================================

for (const adapter of [OPENCODE, CLAUDE_CODE]) {
  test(`instrumentation §1 [${adapter.origin}]: native events → collect → distill → one origin-stamped note; recall carries origin`, () => {
    const t = makeTempDirs(`instr-${adapter.origin}-`);
    seedDecoyNotes(t.dataDir);

    const sessionId = `${adapter.origin}-eligible-session`;
    const term = QUERY_TERM;
    const script = eligibleScript(term);

    // 1. Native → canonical via the REAL pure adapter.
    const events = mapSession(adapter, sessionId, script);
    assert.ok(events.length >= 10, 'the eligible session must carry >= 10 native events');
    assert.ok(events.filter((e) => e.type === 'prompt').length >= 2, 'the session must carry >= 2 prompts');
    assert.ok(
      events.some((e) => e.type === 'tool' && (e.tool as Record<string, unknown>).category === 'file_write'),
      'the session must carry a file write',
    );

    // 2. Real `librarian collect` (spawned) ingests them onto the per-session log.
    collect(t.dataDir, events);
    const eventLogPath = path.join(t.dataDir, 'events', `${sessionId}.ndjson`);
    assert.ok(fs.existsSync(eventLogPath), 'the per-session event log must exist after collect');
    const loggedEventIds = new Set(
      (readAll(eventLogPath) as Array<Record<string, unknown>>).map((e) => e.event_id as string),
    );

    // 3. Real `librarian distill` (spawned, fixture provider) mints exactly one note.
    const result = distill(t);
    assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);

    const notes = noteRevisions(t.dataDir).filter((n) => (n.provenance as Record<string, unknown>).session_id === sessionId);
    assert.equal(notes.length, 1, 'exactly one NoteRevision should be minted for the session');
    const note = notes[0];

    // origin is the adapter's origin, denormalized from resource.agent (§5).
    assert.equal(
      (note.source as Record<string, unknown>).origin,
      adapter.origin,
      `source.origin must be the ${adapter.origin} adapter's origin`,
    );
    assert.equal((note.source as Record<string, unknown>).distiller, 'llm', 'source.distiller must be llm');

    // provenance.event_ids must all exist in the event log (real provenance, §5).
    const provenance = note.provenance as Record<string, unknown>;
    assert.equal(provenance.session_id, sessionId, 'provenance.session_id must be the session');
    const provIds = provenance.event_ids as string[];
    assert.ok(Array.isArray(provIds) && provIds.length === events.length, 'provenance must cover every ingested event');
    for (const id of provIds) {
      assert.ok(loggedEventIds.has(id), `provenance event id ${id} must exist in the event log`);
    }

    // 4. Index the note log; recall a fixture term → the note is returned with its origin.
    const db = new Database(':memory:');
    migrate(db);
    indexNotes(db, t.dataDir, t.cursorPath);

    const results = recall(db, term, { global: true });
    const hit = results.find((r) => r.note_id === note.note_id);
    assert.ok(hit, `recall("${term}") must return the distilled ${adapter.origin} note`);
    assert.equal(hit!.origin, adapter.origin, `the recalled note's origin must survive as ${adapter.origin}`);

    db.close();
  });
}

// ===========================================================================
// Section 2 — both origins appear in ONE recall result set (DoD).
//
// Distill an eligible session from EACH adapter into the SAME data dir, index
// once, and run a single global recall on the shared fixture term. Both origins
// (`opencode`, `claude-code`) must appear among the results — origin carried
// end-to-end from two different native surfaces into one recall (§6: origin is
// carried and weighable/filterable, not retuned here).
// ===========================================================================

test('instrumentation §2 both origins: opencode AND claude-code both appear in a single recall result set', () => {
  const t = makeTempDirs('instr-both-origins-');
  seedDecoyNotes(t.dataDir);

  const term = QUERY_TERM;
  const perOrigin: Record<string, string> = {};
  for (const adapter of [OPENCODE, CLAUDE_CODE]) {
    const sessionId = `${adapter.origin}-both-session`;
    perOrigin[adapter.origin] = sessionId;
    collect(t.dataDir, mapSession(adapter, sessionId, eligibleScript(term)));
  }

  const result = distill(t);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);

  // Two eligible sessions → two distilled notes (plus decoys on the log).
  const notes = noteRevisions(t.dataDir).filter((n) => {
    const sid = (n.provenance as Record<string, unknown>).session_id;
    return sid === perOrigin.opencode || sid === perOrigin['claude-code'];
  });
  assert.equal(notes.length, 2, 'both eligible sessions should each mint one note');

  const db = new Database(':memory:');
  migrate(db);
  indexNotes(db, t.dataDir, t.cursorPath);

  const results = recall(db, term, { global: true });
  const origins = new Set(results.map((r) => r.origin));
  assert.ok(origins.has('opencode'), 'the opencode origin must appear in the recall results');
  assert.ok(origins.has('claude-code'), 'the claude-code origin must appear in the recall results');

  db.close();
});

// ===========================================================================
// Section 3 — cross-cutting assertions (one instance each, not per-adapter).
// ===========================================================================

// §8: a skip-worthy session (few read-only events) yields a distill verdict in
// the diagnostics dir and NO note. Uses the opencode adapter as the carrier; the
// skip heuristic is origin-agnostic, so one instance suffices.
test('instrumentation §3a skip: a low-signal session mints no note and writes a distill verdict to diagnostics', () => {
  const t = makeTempDirs('instr-skip-');

  const sessionId = 'opencode-skip-session';
  // 3 read-only events: fewer than 10 → skipped (§3).
  const script: SessionStep[] = [
    { kind: 'read', file: 'README.md' },
    { kind: 'read', file: 'src/index.ts' },
    { kind: 'read', file: 'package.json' },
  ];
  collect(t.dataDir, mapSession(OPENCODE, sessionId, script));

  const result = distill(t);
  assert.equal(result.status, 0, `distill should exit 0; stderr: ${result.stderr}`);

  // No note.
  assert.equal(noteRevisions(t.dataDir).length, 0, 'a skipped session must mint no note');

  // A distill verdict lives in the DIAGNOSTICS dir (memory is sacred; verdicts are diagnostics, §8).
  const verdictDir = path.join(t.diagnosticsDir, 'distill');
  assert.ok(fs.existsSync(verdictDir), 'a distill verdict segment dir should exist');
  const verdicts = fs
    .readdirSync(verdictDir)
    .filter((n) => n.endsWith('.ndjson'))
    .flatMap((n) => readAll(path.join(verdictDir, n)) as Array<Record<string, unknown>>);
  assert.equal(verdicts.length, 1, 'exactly one verdict should be written');
  assert.equal(verdicts[0].record_class, 'diagnostic', 'the verdict must carry record_class:diagnostic');
  assert.equal(verdicts[0].decision, 'skipped', 'the verdict decision must be skipped');
  assert.equal(verdicts[0].session_id, sessionId, 'the verdict must name the skipped session');

  // The verdict must NOT be under the data dir.
  assert.equal(
    fs.existsSync(path.join(t.dataDir, 'distill')),
    false,
    'no verdict segment may exist under the data dir',
  );
});

// §5: re-running `librarian distill` over the finished state mints nothing new
// (idempotency by cursor; a clean re-run reads a zero-length delta).
test('instrumentation §3b idempotency: re-running distill over the finished state mints nothing new', () => {
  const t = makeTempDirs('instr-idempotent-');

  const sessionId = 'opencode-idempotent-session';
  collect(t.dataDir, mapSession(OPENCODE, sessionId, eligibleScript(QUERY_TERM)));

  const first = distill(t);
  assert.equal(first.status, 0, `first distill should exit 0; stderr: ${first.stderr}`);
  assert.equal(noteRevisions(t.dataDir).length, 1, 'the first pass mints exactly one note');

  const second = distill(t);
  assert.equal(second.status, 0, `second distill should exit 0; stderr: ${second.stderr}`);
  assert.equal(noteRevisions(t.dataDir).length, 1, 're-running distill must mint no second note');
});

// §8/§9: feeding a diagnostics NDJSON file to `librarian collect` is a HARD
// rejection at the real CLI boundary — structural isolation proven end-to-end.
// Two halves, both at the spawned-CLI boundary:
//   (a) a REAL diagnostics record produced by the pipeline (a distill verdict,
//       record_class:"diagnostic") is hard-rejected and appends nothing; and
//   (b) the poison-pill BY CLASS — a diagnostics record that would otherwise
//       route (it carries a context.session_id) is refused *because* it is a
//       diagnostic, naming the diagnostic rejection. Together these prove
//       self-observation cannot re-enter memory through the collector (§8).
test('instrumentation §3c structural isolation: feeding a diagnostics NDJSON to `librarian collect` is hard-rejected', () => {
  const t = makeTempDirs('instr-isolation-');

  // Produce a genuine diagnostics record: run a skip to mint a distill verdict.
  const skipSession = 'opencode-verdict-source';
  collect(t.dataDir, mapSession(OPENCODE, skipSession, [
    { kind: 'read', file: 'README.md' },
    { kind: 'read', file: 'src/index.ts' },
    { kind: 'read', file: 'package.json' },
  ]));
  const skip = distill(t);
  assert.equal(skip.status, 0, `distill should exit 0; stderr: ${skip.stderr}`);

  const verdictDir = path.join(t.diagnosticsDir, 'distill');
  const verdictFile = fs
    .readdirSync(verdictDir)
    .filter((n) => n.endsWith('.ndjson'))
    .map((n) => path.join(verdictDir, n))[0];
  assert.ok(verdictFile, 'a verdict NDJSON file must exist to feed back into collect');
  const verdictNdjson = fs.readFileSync(verdictFile, 'utf8');
  assert.match(verdictNdjson, /"record_class":"diagnostic"/, 'the verdict file must carry a diagnostic record');

  // (a) Feed the REAL diagnostics NDJSON straight into the spawned `librarian
  //     collect`. It is hard-rejected: non-zero exit and nothing appended. (A
  //     verdict is not an event — it has no context.session_id — so the CLI's
  //     structural routing check refuses it before any append. The invariant the
  //     §8/§9 isolation requires is the HARD REJECTION, not a specific reason.)
  const isolationDataDir = path.join(t.root, 'isolation-data');
  const rejectReal = runCli(['collect', '--data-dir', isolationDataDir], verdictNdjson);
  assert.notEqual(rejectReal.status, 0, 'a real diagnostics record must cause a non-zero exit at the collect boundary');
  assert.match(rejectReal.stderr, /librarian:/, 'the CLI must name the failure on stderr');
  assert.equal(
    fs.existsSync(path.join(isolationDataDir, 'events')),
    false,
    'nothing from the rejected diagnostics record may be appended',
  );

  // (b) Poison-pill BY CLASS: a diagnostics record that DOES route (it carries a
  //     valid context.session_id) is still refused — precisely because it is a
  //     diagnostic (record_class present). This proves the diagnostic-class
  //     rejection at the real CLI boundary, not merely a missing-field reject.
  const routableDiagnostic = {
    record_class: 'diagnostic',
    schema_version: 1,
    verdict_id: '01J8X7QK50Z9R4M2N6P0S5T7WY',
    ts: '2026-07-06T09:30:00.000Z',
    session_id: 'poison-session',
    decision: 'skipped',
    reason: 'self-observation must never re-enter memory',
    counts: { events: 0, prompts: 0, write_tools: 0, salience_hints: 0 },
    // A context so the CLI's routing check passes and delegates to the validator,
    // where the record_class poison-pill fires.
    context: { session_id: 'poison-session', cwd: '/repo' },
  };
  const classDataDir = path.join(t.root, 'isolation-class-data');
  const rejectClass = runCli(['collect', '--data-dir', classDataDir], JSON.stringify(routableDiagnostic) + '\n');
  assert.notEqual(rejectClass.status, 0, 'a routable diagnostics record must still be hard-rejected');
  assert.match(rejectClass.stderr, /diagnostic/i, 'the rejection must name the diagnostic record (poison-pill by class)');
  assert.equal(
    fs.existsSync(path.join(classDataDir, 'events')),
    false,
    'nothing from the rejected diagnostic-class record may be appended',
  );
});

// ===========================================================================
// Section 4 — Definition-of-Done guard: the collect step uses the REAL CLI, not
// an in-process call. This test asserts, by reading this very source file, that
// the capstone never imports or calls the collector's in-process append function
// — so the only way an event reaches a log in this suite is through the spawned
// `librarian collect`. (The DoD literally requires asserting "no direct
// in-process calls" to the collector's append for the collect step.)
//
// The forbidden identifier is assembled at runtime (never written as a literal
// token in this file) so this guard cannot false-positive on its own source.
// ===========================================================================

test('instrumentation §4 DoD guard: the collect step uses only the spawned CLI, never an in-process collector append', () => {
  const self = fs.readFileSync(import.meta.filename, 'utf8');

  // The collector's in-process append primitive — the exact thing the DoD forbids
  // the collect step from calling directly. Built by concatenation so the literal
  // identifier never appears in this source and the scan below is honest.
  const forbidden = 'append' + 'Event';

  // (a) no import of it from the collector module.
  const importFromCollector = new RegExp(
    `import[^;]*\\b${forbidden}\\b[^;]*from\\s*['"][^'"]*collector[^'"]*['"]`,
  );
  assert.doesNotMatch(
    self,
    importFromCollector,
    'the capstone must not import the collector append primitive — collect is proven only via the spawned CLI',
  );

  // (b) no call to it anywhere in the file.
  const callSite = new RegExp(`\\b${forbidden}\\s*\\(`);
  assert.doesNotMatch(
    self,
    callSite,
    'the capstone must not call the collector append primitive in-process — collect is proven only via the spawned CLI',
  );

  // Positive assertion: every ingest in this suite goes through the spawned real
  // CLI. The collect helper spawns `node <cli> collect`, and nothing else appends
  // events — this is what makes the guard above meaningful rather than vacuous.
  assert.match(self, /spawnSync\('node', \[CLI, \.\.\.args\]/, 'events must reach the log only via the spawned CLI');
});
