import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderEventsForDistill, OUTCOME_EXCERPT_CHARS } from '../../src/render/distillPrompt.ts';

const FIXTURE = path.join(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'events',
  'session-001.ndjson',
);

function loadFixtureEvents(): Array<Record<string, unknown>> {
  return readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const COMMIT_MESSAGE = 'git commit -m "fix: expire check before redirect"';
const SALIENT_MARKER = '← salient:';

test('renders the 4 fixture events as a 4-line indexed compact string', () => {
  const lines = renderEventsForDistill(loadFixtureEvents()).split('\n');
  assert.equal(lines.length, 4);
});

test('line 1 carries the prompt text and its ordinal', () => {
  const [line1] = renderEventsForDistill(loadFixtureEvents()).split('\n');
  assert.ok(line1.startsWith('[1] '));
  assert.ok(line1.includes('fix the login redirect bug, it loops on expired tokens'));
});

test('the commit line carries the commit message', () => {
  const events = loadFixtureEvents();
  const commitIndex = events.findIndex(
    (e) => (e.tool as Record<string, unknown> | undefined)?.category === 'vcs_commit',
  );
  const line = renderEventsForDistill(events).split('\n')[commitIndex];
  // The command text is the tail of the summary; the only thing that may follow
  // it is the salient marker. Strip the marker, then the line ends with it.
  const beforeMarker = line.split(SALIENT_MARKER)[0].trimEnd();
  assert.ok(beforeMarker.endsWith(COMMIT_MESSAGE));
});

test('the salient marker appears exactly where hints.possibly_salient is set', () => {
  const events = loadFixtureEvents();
  const lines = renderEventsForDistill(events).split('\n');
  events.forEach((event, index) => {
    const hints = event.hints as Record<string, unknown> | undefined;
    const expected = hints?.possibly_salient === true;
    assert.equal(
      lines[index].includes(SALIENT_MARKER),
      expected,
      `line ${index + 1} salient-marker presence should be ${expected}`,
    );
  });
});

test('the salient commit line names its reason', () => {
  const events = loadFixtureEvents();
  const lines = renderEventsForDistill(events).split('\n');
  const commitIndex = events.findIndex(
    (e) => (e.tool as Record<string, unknown> | undefined)?.category === 'vcs_commit',
  );
  assert.ok(lines[commitIndex].endsWith('← salient:vcs_commit'));
});

// --- tool outcomes (#179) -------------------------------------------------
// The log records intent; without these the distiller cannot tell a command that failed
// from one that passed, and the failure→remedy→success chain is unrecoverable.

function commandEvent(
  command: string,
  outcome?: Record<string, unknown>,
  hints?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'tool',
    ts: '2026-07-31T12:07:00.000Z',
    tool: { native_name: 'Bash', canonical_name: 'bash', category: 'command' },
    command,
    ...(outcome ? { outcome } : {}),
    ...(hints ? { hints } : {}),
  };
}

test('a plain command renders its command line, not an empty write', () => {
  const line = renderEventsForDistill([commandEvent('npm test')]);
  assert.equal(line, '[1] 12:07 bash: npm test');
});

test('a failed command renders an excerpt of its output', () => {
  const stderr = 'Error: NODE_MODULE_VERSION 115. This version of Node.js requires 127.\n';
  const line = renderEventsForDistill([
    commandEvent('npm test', { stdout: '> librarian@ test\n', stderr }),
  ]);
  assert.ok(line.includes('bash: npm test →'), `outcome is rendered on the line: ${line}`);
  assert.ok(line.includes('NODE_MODULE_VERSION 115'), 'the failure text reaches the prompt');
});

test('BOTH streams reach the prompt, stdout first', () => {
  // Preferring either stream loses the lesson: measured over real transcripts, a failing
  // suite prints its failure to stdout while stderr carries harness noise.
  const line = renderEventsForDistill([
    commandEvent('npm test 2>&1 | tail -25', {
      stdout: '✖ failing tests: ✖ a matching note is returned',
      stderr: '\nShell cwd was reset to /repo',
    }),
  ]);
  assert.ok(line.includes('✖ failing tests'), 'the real failure text is not dropped');
  assert.ok(line.includes('stderr: Shell cwd was reset to /repo'), 'stderr is labelled, not silent');
  assert.ok(
    line.indexOf('✖ failing') < line.indexOf('stderr:'),
    'stdout comes first — it is where failures actually land',
  );
});

test('the salience marker still renders when an adapter sets one', () => {
  const line = renderEventsForDistill([
    commandEvent('npm test', { stdout: 'partial', interrupted: true }, {
      possibly_salient: true,
      reason: 'command_failed',
    }),
  ]);
  assert.ok(line.includes('→ interrupted | partial'));
  assert.ok(line.endsWith('← salient:command_failed'));
});

test('an interrupted command says so even with no output', () => {
  const line = renderEventsForDistill([commandEvent('npm test', { interrupted: true })]);
  assert.equal(line, '[1] 12:07 bash: npm test → interrupted');
});

test('a 1 MB output renders to a single line under the documented cap', () => {
  const huge = 'x'.repeat(1024 * 1024);
  const line = renderEventsForDistill([commandEvent('cat big.log', { stdout: huge })]);
  assert.equal(line.split('\n').length, 1, 'the excerpt never breaks the one-line-per-event rule');
  assert.ok(
    line.length < 100 + OUTCOME_EXCERPT_CHARS,
    `line is bounded by the excerpt cap, got ${line.length} chars`,
  );
  assert.ok(line.endsWith('…'), 'a truncated excerpt is marked as truncated');
});

test('two 1 MB streams are each capped, and the line stays bounded', () => {
  const huge = 'x'.repeat(1024 * 1024);
  const line = renderEventsForDistill([
    commandEvent('cat big.log', { stdout: huge, stderr: 'y'.repeat(1024 * 1024) }),
  ]);
  assert.equal(line.split('\n').length, 1);
  assert.ok(
    line.length < 100 + 2 * OUTCOME_EXCERPT_CHARS,
    `the cap is per stream, so a line is bounded by twice it, got ${line.length} chars`,
  );
  assert.ok(line.includes('x…'), 'stdout is present and truncated');
  assert.ok(line.includes('stderr: y'), 'stderr is present too');
});

test('a whitespace-heavy giant output is excerpted without copying it whole', () => {
  // Guards the bounded pre-slice: the renderer must not allocate a collapsed copy of a
  // multi-megabyte stream to produce 400 characters.
  const spaced = 'a' + ' '.repeat(4 * 1024 * 1024) + 'b';
  const line = renderEventsForDistill([commandEvent('cat spaced.log', { stdout: spaced })]);
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.length < 100 + OUTCOME_EXCERPT_CHARS);
  assert.ok(line.endsWith('…'), 'content beyond the raw headroom is marked as dropped');
});

test('a multi-line output collapses to one line', () => {
  const line = renderEventsForDistill([commandEvent('ls', { stdout: 'a\nb\nc\n' })]);
  assert.equal(line, '[1] 12:07 bash: ls → a b c');
});

test('a stderr-only outcome is labelled so the model knows which stream it read', () => {
  const line = renderEventsForDistill([commandEvent('gcc x.c', { stderr: 'x.c:1: error' })]);
  assert.equal(line, '[1] 12:07 bash: gcc x.c → stderr: x.c:1: error');
});

test('an event with no outcome renders exactly as before', () => {
  const line = renderEventsForDistill([commandEvent('npm test', {})]);
  assert.equal(line, '[1] 12:07 bash: npm test');
});
