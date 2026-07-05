import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderEventsForDistill } from '../../src/render/distillPrompt.ts';

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
