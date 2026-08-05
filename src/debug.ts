import { loadConfig } from './config.ts';

/**
 * Add the stack of a failure to stderr when `debug: true` is set in the config.
 *
 * Deliberately not a logger: no levels, no log file, no second output channel.
 * The pipeline's diagnosis already lives in files it writes — distill verdicts,
 * a cursor's `failed_attempts.last_error` — and this adds only the one thing an
 * error *message* structurally cannot carry, the stack. Off by default because a
 * stack is noise to an operator; the CLI's own messages are written to be read.
 *
 * Called on failure paths only, so re-reading the config here costs one small
 * file read on a run that is already ending badly — cheaper than threading a
 * flag through every stage for a branch that almost never fires.
 */
export function writeDebugStack(err: unknown, configPath?: string): void {
  let debug: boolean;
  try {
    debug = loadConfig(configPath).debug;
  } catch {
    // A config that cannot be read cannot ask for a stack — and the failure being
    // reported is very likely that config itself. Never throw from a failure path.
    return;
  }
  if (!debug) return;
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
}
