import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALLED_BIN } from './paths.ts';

/**
 * Global install of the OpenCode instrumentation plugin (#155).
 *
 * The plugin ships as ONE self-contained ESM bundle (scripts/build-opencode-plugin.sh
 * → dist/opencode-plugin.js, embedded in the SEA binary as an asset). Installing is
 * therefore a single file write into OpenCode's global plugin dir plus recording the
 * CLI path in ~/.librarian/config.json so the plugin can spawn `librarian collect`
 * without depending on PATH. No sibling files, no package.json, no `bun install`.
 *
 * Why a bundle and not a copy of the three adapter sources: OpenCode loads plugin
 * files placed *directly* in the plugins dir (no subdir recursion) and treats every
 * flat file there as its own plugin — so map.ts/inject.ts can't sit beside plugin.ts,
 * and the `ulid` dep wouldn't resolve either. Bundling collapses all of that into one
 * import-free file.
 */

export const OPENCODE_PLUGINS_DIR = path.join(os.homedir(), '.config', 'opencode', 'plugins');
export const OPENCODE_PLUGIN_FILE = path.join(OPENCODE_PLUGINS_DIR, 'librarian.ts');

type SeaApi = { isSea(): boolean; getRawAsset(name: string): ArrayBuffer };

const seaApi: SeaApi | undefined = (() => {
  try {
    // Anchor on execPath (not import.meta.url): esbuild's CJS shim breaks SEA
    // resolution — same reasoning as src/index/nativeAssets.ts.
    return createRequire(process.execPath)('node:sea') as SeaApi;
  } catch {
    return undefined;
  }
})();

/** The bundled plugin source: from the SEA asset when packaged, else the on-disk
 *  dist/ artifact for a run-from-source (dev/test) invocation. */
export function readPluginBundle(): string {
  if (seaApi?.isSea()) {
    return Buffer.from(seaApi.getRawAsset('opencode-plugin.js')).toString('utf8');
  }
  // Run-from-source: src/ → repo root → dist/opencode-plugin.js.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return fs.readFileSync(path.join(repoRoot, 'dist', 'opencode-plugin.js'), 'utf8');
}

/** Set (only) the `bin` key in ~/.librarian/config.json, preserving every other key.
 *  The installed binary is native — no `runtime` is needed (that's only for a .js CLI). */
function recordBin(configPath: string, bin: string): void {
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch {
    // absent/corrupt — start fresh
  }
  cfg.bin = bin;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

export type InstallResult = { pluginFile: string; bin: string };

/**
 * Write the bundled plugin into OpenCode's global plugins dir and point config `bin`
 * at the installed binary. `bin` defaults to ~/.librarian/bin/librarian (scripts/
 * install.sh's target) but is injectable so tests and non-default installs can steer it.
 */
export function installOpencodePlugin(configPath: string, opts: { bin?: string; pluginFile?: string } = {}): InstallResult {
  const pluginFile = opts.pluginFile ?? OPENCODE_PLUGIN_FILE;
  const bin = opts.bin ?? INSTALLED_BIN;
  fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
  fs.writeFileSync(pluginFile, readPluginBundle());
  recordBin(configPath, bin);
  return { pluginFile, bin };
}
