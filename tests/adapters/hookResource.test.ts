import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMachineId } from '../../src/hook/resource.ts';

/**
 * Machine-id resolution (§10.1, §11) — the "could not resolve machine id" regression.
 *
 * These facts are resolved by `src/hook/resource.ts`, shared by `librarian hook claude-code`
 * and `librarian hook opencode` (it used to live in each adapter). The OpenCode plugin once
 * reached the persisted machine id ONLY through the MACHINE_ID_PATH env var; with that unset
 * (OpenCode's normal environment) it fell straight to spawning the CLI — exactly the fragile
 * PATH/spawn seam we avoid. So even with a perfectly good `~/.librarian/machine-id` on disk,
 * a launch that could not locate/run the CLI surfaced a scary "could not resolve machine id".
 * The fix: read the default persisted file directly. These tests pin that by handing the
 * resolver an un-runnable CLI — a correct id proves it came from the file, not a subprocess.
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type ControlledVar = 'HOME' | 'MACHINE_ID_PATH';

/** Run with a controlled env, restoring every touched variable afterward so tests do not
 *  leak into each other or touch the real ~/.librarian. Null deletes; omitted is left as-is. */
function withEnv<T>(env: Partial<Record<ControlledVar, string | null>>, fn: () => T): T {
  const keys: ControlledVar[] = ['HOME', 'MACHINE_ID_PATH'];
  const prev = new Map<ControlledVar, string | undefined>(keys.map((k) => [k, process.env[k]]));
  try {
    for (const key of keys) {
      if (!(key in env)) continue;
      const value = env[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of keys) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Point HOME at a fresh temp dir holding ~/.librarian/machine-id. Mirrors the file the real
 *  `librarian machine-id` persists. */
function homeWithMachineId(id: string): string {
  const home = tempDir('hook-mid-home-');
  fs.mkdirSync(path.join(home, '.librarian'), { recursive: true });
  fs.writeFileSync(path.join(home, '.librarian', 'machine-id'), id + '\n');
  return home;
}

/** A librarian command guaranteed to fail to spawn, so any resolved id must have come from a
 *  file rung, never the CLI. */
const UNRUNNABLE = { command: '/nonexistent/librarian-cli-that-cannot-run', args: [] };

const silent = (): void => {};

test('machine-id: the persisted ~/.librarian/machine-id is read directly, without spawning the CLI', () => {
  const home = homeWithMachineId('01J8X7QK3VZ9R4M2N6P0S5T7WX');
  const id = withEnv({ HOME: home, MACHINE_ID_PATH: null }, () => resolveMachineId(UNRUNNABLE, silent));
  assert.equal(id, '01J8X7QK3VZ9R4M2N6P0S5T7WX', 'the id must come from the persisted file even when the CLI cannot run');
});

test('machine-id: MACHINE_ID_PATH env, when set to a non-empty file, wins over the default path', () => {
  const home = homeWithMachineId('01DEFAULTDEFAULTDEFAULTDEF');
  const overridePath = path.join(tempDir('hook-mid-override-'), 'mid');
  fs.writeFileSync(overridePath, '01OVERRIDEOVERRIDEOVERRIDE\n');
  const id = withEnv({ HOME: home, MACHINE_ID_PATH: overridePath }, () => resolveMachineId(UNRUNNABLE, silent));
  assert.equal(id, '01OVERRIDEOVERRIDEOVERRIDE', 'the env override path must take precedence');
});

test('machine-id: an empty MACHINE_ID_PATH file falls through to the default persisted path', () => {
  const home = homeWithMachineId('01FALLBACKTOTHEDEFAULTFILE');
  const blankPath = path.join(tempDir('hook-mid-blank-'), 'mid');
  fs.writeFileSync(blankPath, '   \n'); // whitespace only — treated as absent
  const id = withEnv({ HOME: home, MACHINE_ID_PATH: blankPath }, () => resolveMachineId(UNRUNNABLE, silent));
  assert.equal(id, '01FALLBACKTOTHEDEFAULTFILE', 'a blank override file must not shadow the default');
});

test('machine-id: no persisted file and an un-runnable CLI yields a non-empty ephemeral id, never a throw', () => {
  // Empty HOME (no machine-id file), env unset, CLI cannot run: the last rung is a UUID, and
  // the operator gets a warning rather than a broken pipeline.
  const home = tempDir('hook-mid-empty-');
  const warnings: string[] = [];
  let id: string | undefined;
  assert.doesNotThrow(() => {
    id = withEnv({ HOME: home, MACHINE_ID_PATH: null }, () =>
      resolveMachineId(UNRUNNABLE, (message) => warnings.push(message)),
    );
  }, 'resolution must never throw — it must degrade to an ephemeral id');
  assert.ok(id && id.length > 0, 'the fallback id must be non-empty so events still carry a machine_id');
  assert.equal(warnings.length, 1, 'the degradation must be logged so an operator can fix the install');
});
