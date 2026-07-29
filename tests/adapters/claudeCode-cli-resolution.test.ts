import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveLibrarianCommand } from '../../src/hook/librarianBin.ts';

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

// Regression: when the shell runs inside the SEA binary (an esbuild CJS bundle), the base
// used to build the `dist/cli.js` URL is not a valid URL base, so `new URL(..., base)`
// throws. That construction MUST be caught (it lives inside the try, not in a default
// parameter that would evaluate before the try) and fall back to `librarian` on PATH —
// otherwise the throw escapes and the hook exits non-zero, breaking the exit-0 hook-safety
// contract on the installed-binary path. Drive the default-URL branch (no cliUrl) with an
// invalid base to prove it is contained.
test('Claude hook contains an invalid built-CLI URL base (SEA bundle) and falls back to PATH', () => {
  assert.doesNotThrow(() =>
    assert.deepEqual(resolveLibrarianCommand(() => true, undefined, '', 'not-a-valid-url-base'), {
      command: 'librarian',
      args: [],
    }),
  );
});
