import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtureProvider } from '../../src/distill/provider.ts';

test('makeFixtureProvider resolves to its canned response, ignoring the prompt', async () => {
  const provider = makeFixtureProvider('{"foo":"bar"}');
  assert.equal(await provider.complete('anything'), '{"foo":"bar"}');
});

test('makeFixtureProvider ignores the prompt argument entirely', async () => {
  const provider = makeFixtureProvider('canned');
  assert.equal(await provider.complete('prompt A'), 'canned');
  assert.equal(await provider.complete('a completely different prompt'), 'canned');
});
