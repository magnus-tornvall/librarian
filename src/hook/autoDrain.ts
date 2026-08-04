/**
 * The automatic drain trigger — a detached `librarian drain` fired from a hook shell when a
 * mapped event carries a boundary (#170, the payload of the automatic-notes epic).
 *
 * It lives here rather than in either adapter so both `librarian hook claude-code` and
 * `librarian hook opencode` inherit it from behind the bin (§14 amendment) instead of
 * duplicating a spawn each.
 *
 * Three properties are load-bearing:
 *
 *  - **Detached.** The child is `detached` + `stdio:'ignore'` + `unref()`'d, so the hook
 *    process exits immediately and the drain outlives it. A hook that waited on a distill
 *    (a provider call per session) would stall the host agent for seconds.
 *  - **Silent and unthrowing.** Hook-safety (§14): a spawn failure is one stderr line, never
 *    a throw, and nothing is ever written to stdout — Claude Code reads hook stdout as
 *    decision control.
 *  - **Liberal, but debounced.** #168 makes live sessions ineligible, so firing on a
 *    mid-session semantic boundary is a near-no-op for the active session while
 *    opportunistically draining any *other* session that has settled. The stamp file below
 *    keeps a burst of boundaries from storming; the distiller's own lock is the backstop
 *    (a second drain sees a live lock, reports on stderr, exits 0).
 *
 * This only *invokes* `drain` — locking, retry, quarantine and idempotency are already drain's
 * own (`docs/hardening.md`), and a repeat drain over one backlog is a byte-identical no-op, so
 * overlap with the scheduled drain needs no coordination.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../paths.ts';
import type { LibrarianCommand } from './librarianBin.ts';

/** Long enough that a tool-heavy turn hitting several boundaries spawns once. */
const DEBOUNCE_MS = 60_000;

/** Sits beside the update-check stamp: cache is the binary's scratch space, wiped on uninstall. */
function stampPath(): string {
  return path.join(CACHE_DIR, 'last-drain');
}

function recentlyDrained(now: number): boolean {
  try {
    return now - Number(fs.readFileSync(stampPath(), 'utf8')) < DEBOUNCE_MS;
  } catch {
    return false; // absent or unreadable: treat as never drained
  }
}

function markDrained(now: number): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(stampPath(), String(now));
  } catch {
    // A stamp we cannot write costs us the debounce, not the drain. The lock still holds.
  }
}

/** The boundary shape both mappers produce (#169); typed structurally to avoid importing either. */
type Boundaried = { boundary?: { kind: string } };

/**
 * Fire a detached drain if any of these events is a boundary.
 *
 * A terminal boundary (session end) BYPASSES the debounce: it is the one firing that must
 * produce the session's note, and a semantic boundary seconds earlier — a commit right
 * before quitting is the common case — would otherwise swallow it and leave the note waiting
 * on the scheduled net.
 */
export function maybeSpawnDrain(
  events: Boundaried[],
  librarian: LibrarianCommand,
  logError: (message: string) => void,
  now: number = Date.now(),
): void {
  const boundaries = events.flatMap((event) => event.boundary !== undefined ? [event.boundary] : []);
  if (boundaries.length === 0) return;
  const terminal = boundaries.some((boundary) => boundary.kind === 'terminal');
  if (!terminal && recentlyDrained(now)) return;

  // Stamped BEFORE the spawn, so a failed spawn still throttles: a `librarian` that cannot
  // be spawned will not start working because we retried it on the next tool call.
  markDrained(now);
  try {
    const child = spawn(librarian.command, [...librarian.args, 'drain'], { detached: true, stdio: 'ignore' });
    // spawn() reports failure asynchronously; without a listener that becomes an uncaught
    // 'error' event. It fires only if we are still alive to hear it, which is the point.
    child.on('error', (err) => { logError(`librarian drain failed to spawn: ${err.message}`); });
    child.unref();
  } catch (err) {
    logError(`librarian drain failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
  }
}
