/**
 * `librarian uninstall` — undo the wiring, keep the memory (spec §14 amendment, #157).
 *
 * The asymmetry is the whole point: the *tool* is disposable, the *notes are not*. So this
 * removes only what an install put there — the binary, the PATH line, the OpenCode plugin
 * file, the config keys that point at the bin — and leaves `~/.librarian` data alone unless
 * `--purge` says otherwise, loudly and with a confirmation.
 *
 * Host-owned wiring (the Claude Code plugin registry, `claude mcp add` entries) lives in the
 * host's own config, which this repo never writes; we print the commands instead of guessing
 * at another tool's state.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE_DIR, CONFIG_PATH, LIBRARIAN_ROOT } from './paths.ts';
import { isSea } from './index/nativeAssets.ts';
import { stdioPrompter } from './prompt.ts';

/** The guard comment `scripts/install.sh` appends its PATH line with — the only handle we get. */
const PATH_MARKER = '# added by librarian installer';

/** Every profile the installer might have picked; the login shell may have changed since. */
const PROFILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile'];

type Options = { purge: boolean; dryRun: boolean; assumeYes: boolean };

function parseArgs(argv: string[]): Options {
  const options: Options = { purge: false, dryRun: false, assumeYes: false };
  for (const arg of argv) {
    if (arg === '--purge') options.purge = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.assumeYes = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return options;
}

/**
 * Where the installed binary lives — same resolution order as `installedLibrarianBin()`.
 *
 * Under SEA `process.execPath` IS the binary being uninstalled, so its directory is
 * authoritative and already reflects an installer run with a non-default
 * `LIBRARIAN_BIN_DIR`. Checking the env var *first* would let a stale export point the sweep
 * at a directory this binary was never installed into. Off-SEA there is nothing to derive
 * from, so the env var (then the installer's default) is all we have.
 */
function binDir(): string {
  if (isSea()) return path.dirname(process.execPath);
  return process.env.LIBRARIAN_BIN_DIR ?? path.join(LIBRARIAN_ROOT, 'bin');
}

/** Strip every marker-tagged line from one profile. Returns true if the file changed. */
function stripPathLine(profile: string, dryRun: boolean): boolean {
  let text: string;
  try {
    text = fs.readFileSync(profile, 'utf8');
  } catch {
    return false; // absent, or not ours to read
  }
  if (!text.includes(PATH_MARKER)) return false;
  if (!dryRun) {
    const kept = text.split('\n').filter((line) => !line.includes(PATH_MARKER));
    fs.writeFileSync(profile, kept.join('\n'));
  }
  return true;
}

/**
 * Drop the wiring keys (`bin`, and the dev-loop `runtime` recorded alongside it) from the
 * config, deleting the file only if that leaves it empty. Everything else — provider,
 * embedding, vault, scoring — is the user's settings, not wiring: it survives.
 */
function cleanConfig(dryRun: boolean): string | undefined {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return undefined; // absent or malformed: nothing safe to edit
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const record = config as Record<string, unknown>;
  if (!('bin' in record) && !('runtime' in record)) return undefined;
  delete record.bin;
  delete record.runtime;
  const emptied = Object.keys(record).length === 0;
  if (!dryRun) {
    if (emptied) fs.rmSync(CONFIG_PATH, { force: true });
    else fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(record, null, 2)}\n`);
  }
  // Report what actually happened: a wiring-only config is deleted, not edited.
  return emptied ? `${CONFIG_PATH} (wiring-only config)` : `bin/runtime keys from ${CONFIG_PATH}`;
}

export async function uninstallCommand(argv: string[]): Promise<void> {
  const { purge, dryRun, assumeYes } = parseArgs(argv);
  const out = (text: string): void => { process.stdout.write(`${text}\n`); };
  const removed = (what: string): void => { out(`  ${dryRun ? 'would remove' : 'removed'} ${what}`); };

  if (purge && !dryRun && !assumeYes) {
    const prompter = stdioPrompter();
    try {
      out(`⚠ --purge deletes ${LIBRARIAN_ROOT} — every collected event, note, and index. This cannot be undone.`);
      if (!(await prompter.confirm('Delete your Librarian data?', false))) throw new Error('uninstall aborted; nothing was removed');
    } finally {
      prompter.close();
    }
  }

  out(dryRun ? 'librarian uninstall (dry run — nothing will be changed)' : 'librarian uninstall');

  // 1. The OpenCode plugin file — the one host that needs a file on disk.
  const { openCodePluginDir, openCodePluginPath } = await import('./hook/opencodeInstall.ts');
  const plugin = openCodePluginPath();
  if (fs.existsSync(plugin)) {
    if (!dryRun) {
      fs.rmSync(plugin, { force: true });
      try { fs.rmdirSync(openCodePluginDir()); } catch { /* not empty, or not ours: leave it */ }
    }
    removed(plugin);
  }

  // 2. The OS drain timer, BEFORE the binary: a schedule left pointing at a deleted bin
  //    keeps firing and keeps failing.
  const { removeSchedule } = await import('./schedule.ts');
  for (const what of removeSchedule(dryRun)) removed(what);

  // 3. The binary, plus any staged/rollback siblings a killed self-update stranded. Files
  //    only, never the directory itself — `LIBRARIAN_BIN_DIR` may be a shared bin dir.
  const bin = binDir();
  for (const entry of fs.existsSync(bin) ? fs.readdirSync(bin) : []) {
    if (entry !== 'librarian' && !/^\.librarian\.\d+\.(update|rollback)$/.test(entry)) continue;
    if (!dryRun) fs.rmSync(path.join(bin, entry), { force: true });
    removed(path.join(bin, entry));
  }
  if (!dryRun) { try { fs.rmdirSync(bin); } catch { /* shared or non-empty: leave it */ } }

  // 4. The installer's PATH line, from whichever profile got it.
  for (const name of PROFILES) {
    const profile = path.join(os.homedir(), name);
    if (stripPathLine(profile, dryRun)) removed(`PATH line from ${profile}`);
  }

  // 5. Config wiring keys — settings stay.
  const config = cleanConfig(dryRun);
  if (config) removed(config);

  // 6. Data: preserved by default. That is policy, not an oversight, so say which.
  if (purge) {
    if (!dryRun) fs.rmSync(LIBRARIAN_ROOT, { recursive: true, force: true });
    removed(`${LIBRARIAN_ROOT} (--purge: notes, events, index, diagnostics)`);
  } else {
    // The cache is the *binary's* scratch space, not the user's memory: extracted native
    // artifacts keyed on the bin's own size+mtime, plus the update-check stamp. Both are
    // dead the moment the bin is gone, and a reinstall re-extracts under a new key anyway.
    if (fs.existsSync(CACHE_DIR)) {
      if (!dryRun) fs.rmSync(CACHE_DIR, { recursive: true, force: true });
      removed(`${CACHE_DIR} (extracted native artifacts + update-check stamp)`);
    }
    out(`  kept ${LIBRARIAN_ROOT} — your notes and index. Pass --purge to delete them too.`);
  }

  // 7. Host-owned wiring we cannot remove for you.
  out('');
  out('Finish in the hosts that registered librarian:');
  out('  Claude Code: /plugin uninstall librarian   then   /plugin marketplace remove magnus-tornvall/librarian');
  out('  MCP (if registered by hand): claude mcp remove librarian');
  out('  OpenCode: restart it — plugins load only at startup.');
}
