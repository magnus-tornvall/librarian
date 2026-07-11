import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveLibrarianCommand } from '../../adapters/claude-code/hook.ts';

const candidate = new URL('../../dist/cli.js', import.meta.url);

test('Claude hook resolves the built CLI with the current Node runtime', () => {
  assert.deepEqual(resolveLibrarianCommand(() => true, candidate, ''), {
    command: process.execPath,
    args: [fileURLToPath(candidate)],
  });
});

test('Claude hook falls back to librarian on PATH when the built CLI is absent', () => {
  assert.deepEqual(resolveLibrarianCommand(() => false, candidate, ''), { command: 'librarian', args: [] });
});

test('Claude hook contains CLI resolution errors', () => {
  assert.deepEqual(resolveLibrarianCommand(() => { throw new Error('boom'); }, candidate, ''), {
    command: 'librarian', args: [],
  });
});

test('Claude hook honors an explicit CLI override', () => {
  assert.deepEqual(resolveLibrarianCommand(() => true, candidate, '/tmp/librarian'), {
    command: '/tmp/librarian', args: [],
  });
});
