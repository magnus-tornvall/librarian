import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { appendEvent } from './collector/append.ts';
import { makeFixtureProvider } from './distill/provider.ts';
import { makeClaudeProvider } from './distill/claudeProvider.ts';
import { runDistill } from './distill/distillRun.ts';
import { DATA_DIR, DIAGNOSTICS_DIR, MACHINE_ID_PATH } from './paths.ts';

/**
 * `librarian` CLI — a thin shell over the collector library (spec §4: collector
 * is "library + CLI, no daemon"). It processes stdin and exits; it adds no
 * second validation or redaction layer — redact → validate → append all live in
 * `appendEvent`.
 */

const USAGE = `usage:
  librarian collect [--data-dir <dir>]     read canonical-event NDJSON on stdin
  librarian distill [--data-dir <dir>] [--diagnostics-dir <dir>] [--provider-fixture <file>]
                                           distill pending event deltas into notes
  librarian machine-id [--path <file>]     print the persisted machine id
`;

/** Minimal `--flag value` parser — no CLI framework dependency (§14). */
function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`flag ${arg} requires a value`);
    }
    flags.set(arg.slice(2), value);
    i += 1;
  }
  return flags;
}

/**
 * Read stdin canonical-event NDJSON; append each record via `appendEvent` into
 * `<dataDir>/events/{session_id}.ndjson`, routed by the record's own
 * `context.session_id`. Fail loud (§9): a malformed JSON line, a validation
 * failure, or a `record_class: diagnostic` record aborts with a non-zero exit
 * and an error naming the reason; nothing from the failed line is appended.
 */
function collect(flags: Map<string, string>): void {
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const input = fs.readFileSync(0, 'utf8');
  const lines = input.split('\n');

  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`malformed JSON on line ${index + 1}: ${reason}`);
    }

    const context = record.context;
    const sessionId =
      typeof context === 'object' && context !== null
        ? (context as Record<string, unknown>).session_id
        : undefined;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`missing context.session_id on line ${index + 1}`);
    }

    const logFilePath = path.join(dataDir, 'events', `${sessionId}.ndjson`);
    try {
      appendEvent(logFilePath, record);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`rejected record on line ${index + 1}: ${reason}`);
    }
  });
}

/**
 * Cursor-driven distill trigger (§4 "Owns distill triggering", §8 "Distill
 * verdicts"). Scans `<dataDir>/events/*.ndjson`, applies the skip heuristic,
 * runs the distiller on eligible session deltas, appends notes, writes distill
 * verdicts to the diagnostics dir, and advances cursors after success. The
 * heavy lifting lives in `runDistill` so this stays a thin shell.
 *
 * `--provider-fixture <file>` swaps in `makeFixtureProvider` so tests and
 * offline runs never call a live model (§2); absent, the real `claude -p`
 * provider is used. Fail loud (§9): a provider/parse failure propagates and
 * aborts with a non-zero exit; the failed session's cursor is not advanced.
 */
async function distillCommand(flags: Map<string, string>): Promise<void> {
  const dataDir = flags.get('data-dir') ?? DATA_DIR;
  const diagnosticsDir = flags.get('diagnostics-dir') ?? DIAGNOSTICS_DIR;
  const fixture = flags.get('provider-fixture');
  const provider =
    fixture !== undefined
      ? makeFixtureProvider(fs.readFileSync(fixture, 'utf8'))
      : makeClaudeProvider();

  await runDistill({ dataDir, diagnosticsDir, provider });
}

/**
 * Print the persisted machine id, generating and persisting a ULID on first
 * call (§11: a generated persisted id, never the hostname).
 */
function machineId(flags: Map<string, string>): void {
  const machineIdPath = flags.get('path') ?? MACHINE_ID_PATH;
  let id: string;
  if (fs.existsSync(machineIdPath)) {
    id = fs.readFileSync(machineIdPath, 'utf8').trim();
  } else {
    id = ulid();
    fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
    fs.writeFileSync(machineIdPath, id + '\n');
  }
  process.stdout.write(id + '\n');
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'collect':
      collect(parseFlags(rest));
      break;
    case 'distill':
      await distillCommand(parseFlags(rest));
      break;
    case 'machine-id':
      machineId(parseFlags(rest));
      break;
    default:
      process.stderr.write(USAGE);
      process.exit(command === undefined ? 1 : 2);
  }
}

main(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`librarian: ${message}\n`);
  process.exit(1);
});
