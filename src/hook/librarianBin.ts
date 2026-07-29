/**
 * Locating the `librarian` CLI from inside a hook shell — shared by every
 * `librarian hook <agent>` entry (§14 amendment: thin plugins routed through the bin).
 *
 * Both shells run as the librarian binary already, so `process.execPath` is a real JS
 * runtime and no runtime-resolution dance is needed here (that lives in the OpenCode
 * plugin, which runs inside a host whose `process.execPath` is the host binary).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export type LibrarianCommand = { command: string; args: string[] };

/**
 * Turn a resolved CLI location into a spawnable command. A real executable (the installed
 * binary) is spawned directly; a `.js` needs an interpreter in front of it — `LIBRARIAN_RUNTIME`
 * when set, else this process's own runtime, which inside a hook shell is node (or the SEA
 * binary, which never resolves to a `.js` in the first place). Without this, a `LIBRARIAN_BIN`
 * pointing at `dist/cli.js` — a documented option — fails with EACCES unless the file happens
 * to carry an exec bit and a shebang.
 */
function commandFor(bin: string): LibrarianCommand {
  if (!bin.endsWith('.js')) {
    return { command: bin, args: [] };
  }
  const runtime = process.env.LIBRARIAN_RUNTIME;
  return { command: runtime && runtime.trim().length > 0 ? runtime : process.execPath, args: [bin] };
}

/**
 * Prefer this checkout's built CLI, but preserve the PATH fallback on any resolution failure.
 *
 * `cliUrl` is resolved lazily INSIDE the try, not as a default-parameter value: in the SEA
 * binary the shell runs from an esbuild bundle where `import.meta.url` is not a valid URL
 * base, so `new URL('../../dist/cli.js', import.meta.url)` throws. A default-param throw
 * would escape this function's try/catch (defaults evaluate before the body) and break the
 * exit-0 hook-safety contract — so it must be caught here and fall back to `librarian` on
 * PATH (the correct answer for the installed binary anyway).
 */
export function resolveLibrarianCommand(
  exists: (file: string) => boolean = fs.existsSync,
  cliUrl?: URL,
  override: string | undefined = process.env.LIBRARIAN_BIN,
  base: string = import.meta.url,
): LibrarianCommand {
  try {
    if (override) {
      return commandFor(override);
    }
    const cliPath = fileURLToPath(cliUrl ?? new URL('../../dist/cli.js', base));
    return exists(cliPath) ? commandFor(cliPath) : { command: 'librarian', args: [] };
  } catch {
    return { command: 'librarian', args: [] };
  }
}

/** Run a librarian subcommand through a resolved command. */
export function runLibrarian(
  librarian: LibrarianCommand,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(librarian.command, [...librarian.args, ...args], options);
}
