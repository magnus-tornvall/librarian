import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent } from '../../src/collector/append.ts';
import { readAll } from '../../src/log/ndjson.ts';
import { distill } from '../../src/distill/llmDistiller.ts';
import type { InferenceProvider } from '../../src/distill/provider.ts';
import { renderEventsForDistill } from '../../src/render/distillPrompt.ts';

/**
 * End-to-end proof for #179: a session where `npm test` fails with a native-module ABI
 * mismatch, the operator discovers the wrong node version, and `nvm use && npm test`
 * passes — the failure → remedy → success chain that is the single highest-value memory
 * the pipeline exists to produce.
 *
 * The events go through the REAL append boundary (redaction + validation) and the REAL
 * renderer, so what this asserts is what the model actually receives. The model half —
 * that a real provider turns that prompt into a note naming the mismatch — is the
 * `fixtures/provider-qualification/failed-command-remedy` fixture, which runs offline
 * against a canned response and live under `QUALIFY_PROVIDER`.
 */

const FIXTURE = path.join(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'provider-qualification',
  'failed-command-remedy',
);

const ABI_ERROR = 'NODE_MODULE_VERSION 115';
const REMEDY = 'nvm use && npm test';

/** Pipe the fixture session through the collector's append boundary and read it back —
 *  the events the distiller sees are the redacted, validated, durable ones. */
async function collectFixtureSession(): Promise<Array<Record<string, unknown>>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-outcome-'));
  const logFilePath = path.join(dir, 'events.ndjson');
  const raw = fs
    .readFileSync(path.join(FIXTURE, 'events.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const event of raw) {
    await appendEvent(logFilePath, event);
  }
  return readAll(logFilePath) as Array<Record<string, unknown>>;
}

/** An InferenceProvider that records the prompt it was handed and answers with the same
 *  canned judgment the qualification fixture uses offline. */
function capturingProvider(prompts: string[]): InferenceProvider {
  const [judgment] = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'response.json'), 'utf8')) as string[];
  return {
    model: 'fixture/tool-outcome',
    complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      return Promise.resolve(judgment);
    },
  };
}

test('the failure text and its remedy survive the append boundary into the distill prompt', async () => {
  const events = await collectFixtureSession();
  const prompts: string[] = [];
  await distill(events, 'qualify-failed-command-remedy', capturingProvider(prompts), 'opencode');

  assert.equal(prompts.length, 1, 'the distiller makes exactly one model call');
  const [prompt] = prompts;
  assert.ok(prompt.includes(ABI_ERROR), 'the ABI mismatch reaches the model');
  assert.ok(prompt.includes('ERR_DLOPEN_FAILED'), 'so does the error code');
  assert.ok(prompt.includes(REMEDY), 'and so does the remedy that made it pass');
  // No salience hint is asserted here, deliberately. Neither adapter's payload exposes an
  // exit code, `is_error`, or a stderr channel that means failure (see claudeCodeMap's
  // commandFailed for the measurement), so nothing can flag this run as failed. What makes
  // the lesson recoverable is that the model can now READ the output — that is the feature.
});

test('without outcomes the two npm test runs are indistinguishable — the blind spot #179 closes', async () => {
  // The counterfactual the issue is built on: strip the captured output and the failure
  // and the fix render as the same intent line, with nothing to learn from.
  const events = (await collectFixtureSession()).map(({ outcome: _outcome, hints: _hints, ...rest }) => rest);
  const npmTestLines = renderEventsForDistill(events)
    .split('\n')
    .filter((line) => line.includes('npm test'));

  assert.equal(npmTestLines.length, 2, 'the session runs the suite twice');
  assert.ok(!npmTestLines.some((line) => line.includes(ABI_ERROR)), 'nothing says the first one failed');

  // With the outcomes kept, the same two lines differ — and the difference is the memory.
  const withOutcomes = renderEventsForDistill(await collectFixtureSession())
    .split('\n')
    .filter((line) => line.includes('npm test'));
  assert.ok(withOutcomes[0].includes(ABI_ERROR), 'the first run names why it failed');
  assert.ok(!withOutcomes[1].includes(ABI_ERROR), 'the second run does not');
});

test('a read event contributes no outcome to the prompt, even mid-session', async () => {
  const events = await collectFixtureSession();
  const read = events.find(
    (event) => (event.tool as Record<string, unknown> | undefined)?.category === 'file_read',
  );
  assert.ok(read, 'the fixture session reads a file');
  assert.equal(read.outcome, undefined, 'a file_read carries no captured output');
});

test('the distilled note names the mismatch and the remedy', async () => {
  const events = await collectFixtureSession();
  const note = await distill(events, 'qualify-failed-command-remedy', capturingProvider([]), 'opencode');

  assert.notEqual(note.kind, 'declined', 'the session is worth remembering');
  const revision = note as Exclude<typeof note, { kind: 'declined' }>;
  assert.equal(revision.note_type, 'fact');
  assert.ok(revision.body.summary.includes(ABI_ERROR), 'the note names the ABI mismatch');
  assert.ok(revision.body.summary.includes('nvm use'), 'the note names the remedy');
});
