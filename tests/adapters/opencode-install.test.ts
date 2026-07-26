import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installOpencodePlugin, readPluginBundle } from '../../src/opencode-install.ts';

/**
 * OpenCode plugin — global install (#155).
 *
 * The wizard installs the adapter as ONE self-contained bundle into OpenCode's global
 * plugins dir and records the CLI in ~/.librarian/config.json `bin`. These tests prove
 * the install writes that file, sets `bin`, preserves other config keys, and — the
 * issue's real success signal — that the installed bundle, driven through a tool event,
 * hands an event off to `librarian collect` and lands a per-session NDJSON.
 *
 * node --test, no mocks, plain temp dirs, a real spawned CLI for the e2e leg.
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('install writes the bundled plugin into a global plugins dir and records config bin', () => {
  const home = tempDir('opencode-install-');
  const configPath = path.join(home, '.librarian', 'config.json');
  const pluginFile = path.join(home, '.config', 'opencode', 'plugins', 'librarian.ts');
  const bin = path.join(home, '.librarian', 'bin', 'librarian');

  const result = installOpencodePlugin(configPath, { pluginFile, bin });

  assert.equal(result.pluginFile, pluginFile);
  assert.equal(result.bin, bin);
  assert.ok(fs.existsSync(pluginFile), 'the plugin bundle must be written');
  const source = fs.readFileSync(pluginFile, 'utf8');
  assert.match(source, /LibrarianPlugin/, 'the bundle must export the plugin');
  // Self-contained: only node: builtins imported (no ./map.ts, no bare ulid).
  assert.doesNotMatch(source, /from ['"]\.\/(map|inject)/, 'siblings must be inlined');
  assert.doesNotMatch(source, /from ['"]ulid['"]/, 'ulid must be inlined');

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(cfg.bin, bin, 'config bin must point at the installed binary');
});

test('install preserves unmanaged config keys and never sets runtime for a native bin', () => {
  const home = tempDir('opencode-install-keep-');
  const configPath = path.join(home, '.librarian', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ scoring: { human: 5 }, runtime: '/old/node' }));

  installOpencodePlugin(configPath, {
    pluginFile: path.join(home, '.config', 'opencode', 'plugins', 'librarian.ts'),
    bin: path.join(home, '.librarian', 'bin', 'librarian'),
  });

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(cfg.scoring, { human: 5 }, 'unmanaged keys survive');
  assert.ok(cfg.bin, 'bin is set');
  // A pre-existing runtime is left untouched (we only manage bin), but the installer
  // never authors one — a native binary needs no interpreter.
  assert.equal(cfg.runtime, '/old/node');
});

test('the installed bundle loads as an ESM module and exports LibrarianPlugin', async () => {
  const home = tempDir('opencode-install-load-');
  const pluginFile = path.join(home, 'plugins', 'librarian.mjs');
  installOpencodePlugin(path.join(home, 'config.json'), {
    pluginFile,
    bin: path.join(home, 'bin', 'librarian'),
  });
  const mod = await import(pathToFileURL(pluginFile).href) as { LibrarianPlugin?: unknown };
  assert.equal(typeof mod.LibrarianPlugin, 'function', 'the bundle must export a usable plugin factory');
});

test('readPluginBundle returns the built bundle when run from source', () => {
  const distBundle = path.join(import.meta.dirname, '..', '..', 'dist', 'opencode-plugin.js');
  if (!fs.existsSync(distBundle)) return; // not built; the load test above skips implicitly
  assert.equal(readPluginBundle(), fs.readFileSync(distBundle, 'utf8'));
});

test('success signal: the installed plugin, driven by a tool event, lands a per-session NDJSON', async (t) => {
  const distCli = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js');
  if (!fs.existsSync(distCli)) {
    t.skip('dist/cli.js not built (run `npm run build`)');
    return;
  }
  // A throwaway HOME so BOTH config resolution and the collector's default data dir
  // (~/.librarian/data) land in the temp tree, never the developer's real index.
  const home = tempDir('opencode-install-e2e-');
  const pluginFile = path.join(home, '.config', 'opencode', 'plugins', 'librarian.mjs');
  installOpencodePlugin(path.join(home, '.librarian', 'config.json'), {
    pluginFile,
    bin: path.join(home, '.librarian', 'bin', 'librarian'),
  });

  const prevHome = process.env.HOME;
  const prevBin = process.env.LIBRARIAN_BIN;
  process.env.HOME = home;
  // The installed `bin` is a phantom path (no real install here); point the plugin at
  // the built CLI so handOff actually spawns a working collector. This is the plugin's
  // documented top-priority resolution rung.
  process.env.LIBRARIAN_BIN = distCli;
  try {
    const mod = await import(pathToFileURL(pluginFile).href) as {
      LibrarianPlugin: (ctx: unknown) => Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>>;
    };
    const hooks = await mod.LibrarianPlugin({ directory: home, worktree: home });
    const sessionID = 'opencode-install-e2e-session';
    await hooks['tool.execute.after']({ tool: 'bash', sessionID, args: { command: 'echo hi' } }, {});

    const ndjson = path.join(home, '.librarian', 'data', 'events', `${sessionID}.ndjson`);
    assert.ok(fs.existsSync(ndjson), `a fresh tool run must collect an event → ${ndjson}`);
    const lines = fs.readFileSync(ndjson, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'at least one canonical event must be persisted');
    const event = JSON.parse(lines[0]);
    assert.equal(event.type, 'tool', 'the bash tool run maps to a ToolEvent');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevBin === undefined) delete process.env.LIBRARIAN_BIN; else process.env.LIBRARIAN_BIN = prevBin;
  }
});

