/**
 * Installing the OpenCode plugin — the wizard's host-wiring step for OpenCode (spec §14
 * amendment: the wizard owns host wiring).
 *
 * Claude Code needs no install step at all: its manifest is declarative and the host loads
 * `.claude-plugin/plugin.json` from the marketplace. Codex and every other MCP host needs a
 * config entry pointing at `librarian mcp`. OpenCode is the one host that loads *executable
 * JS in-process*, so exactly one file has to land on disk — and writing it is the same act
 * as writing a host config entry, which is why it belongs to the wizard rather than to a
 * package, a release ref, or a second repo.
 *
 * The file's source of truth is `adapters/opencode/plugin.ts`. Two regimes reach it:
 *   - the installed binary embeds it as a SEA asset (`sea-config.json`), and
 *   - a dev/dogfood run reads it out of the checkout, relative to this module (which
 *     resolves the same from `src/hook/` and from the compiled `dist/hook/`).
 * That deliberately avoids a `src/ → adapters/` *import*, which `tsc` (rootDir=src) and
 * esbuild (SEA bundle) resolve differently.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea, seaTextAsset } from '../index/nativeAssets.ts';

const SEA_ASSET_NAME = 'opencode-plugin.ts';

/** OpenCode's global plugin directory. Plugin files must sit DIRECTLY here — OpenCode does
 *  not recurse into subdirectories (observed in scripts/opencode-setup.sh), which is the
 *  other half of why the plugin has to be a single self-contained file. */
export function openCodePluginDir(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'plugins');
}

export function openCodePluginPath(): string {
  return path.join(openCodePluginDir(), 'librarian.ts');
}

/** The plugin source: the SEA asset in the installed binary, else the checkout's own file. */
export function openCodePluginSource(): string {
  const embedded = seaTextAsset(SEA_ASSET_NAME);
  if (embedded !== undefined) {
    return embedded;
  }
  return fs.readFileSync(fileURLToPath(new URL('../../adapters/opencode/plugin.ts', import.meta.url)), 'utf8');
}

/**
 * The installed librarian binary the plugin should spawn, or undefined when there isn't one.
 *
 * Running as the SEA binary, `process.execPath` IS the installed binary — authoritative, and
 * it honors an installer that used a non-default `LIBRARIAN_BIN_DIR`. Otherwise fall back to
 * the path `scripts/install.sh` writes, but only if it actually exists: a dev running `init`
 * from a checkout must not have config `bin` pointed at a binary that was never installed
 * (that would silently break the plugin, and it would clobber the dev `bin` → `dist/cli.js`
 * that `scripts/opencode-setup.sh` records).
 */
export function installedLibrarianBin(): string | undefined {
  if (isSea()) {
    return process.execPath;
  }
  const canonical = path.join(os.homedir(), '.librarian', 'bin', 'librarian');
  return fs.existsSync(canonical) ? canonical : undefined;
}

/**
 * Write the plugin into OpenCode's global plugin dir. Idempotent — a re-run overwrites, which
 * is how an update lands. Returns the path written.
 */
export function installOpenCodePlugin(target: string = openCodePluginPath()): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, openCodePluginSource());
  return target;
}
