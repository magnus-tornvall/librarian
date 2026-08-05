/**
 * `librarian install-schedule` — the scheduled net under the boundary-triggered drain (#170).
 *
 * The hook covers the common case; this covers everything it cannot — a hard-killed terminal,
 * a machine that slept mid-run, a provider that was offline at session end. Each firing is a
 * short-lived `librarian drain` that exits, which is why an OS scheduler does not violate the
 * no-daemon ruling: it is the same delegation the spec already makes for sync (§15).
 *
 * Two rules shape everything below:
 *   - **Nothing implicit.** launchd/systemd/cron run with no shell, no PATH, no cwd worth
 *     trusting, so the unit carries an absolute binary path and an explicit `--vault`.
 *   - **Glass-box.** Every file written and every activation command run is printed. The user
 *     can read, edit, or delete the unit without this command's help.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { installedLibrarianBin } from './hook/opencodeInstall.ts';
import { LIBRARIAN_ROOT } from './paths.ts';

const LAUNCHD_LABEL = 'com.librarian.drain';
const SYSTEMD_TIMER = 'librarian-drain.timer';
const SYSTEMD_SERVICE = 'librarian-drain.service';
/** The handle that makes a crontab line ours to remove — cron has no other identity. */
const CRON_MARKER = '# librarian-drain';
const DEFAULT_INTERVAL_MINUTES = 60;
/** A day. Beyond this launchd's StartInterval overflows into float notation and the plist stops parsing. */
const MAX_INTERVAL_MINUTES = 1440;

// Cron and systemd both express "repeat" as a step inside one calendar field, so an interval that
// does not divide its field evenly fires unevenly — `*/45` is a 45-minute gap then a 15-minute one.
// Snapping to a divisor is what makes the cadence we print the cadence that actually runs; we snap
// on launchd too so the number means the same thing on every platform.
const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12, 24];

function snapInterval(minutes: number): number {
  if (minutes < 60) return MINUTE_STEPS.filter((step) => step <= minutes).at(-1)!;
  return 60 * HOUR_STEPS.filter((step) => step <= Math.floor(minutes / 60)).at(-1)!;
}

/** The drain log. Under `~/.librarian/`, never in the vault — the vault is notes only (§8). */
const LOG_PATH = path.join(LIBRARIAN_ROOT, 'logs', 'drain.log');

/**
 * The platform whose mechanism we generate. The env override exists so the tests can exercise
 * the systemd and cron generators on a macOS host (and vice versa) — nothing else sets it.
 */
function platform(): string {
  return process.env.LIBRARIAN_SCHEDULE_PLATFORM ?? process.platform;
}

function launchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdDir(): string {
  const config = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(config, 'systemd', 'user');
}

type Options = { intervalMinutes: number; vault?: string; uninstall: boolean };

/** `parseFlags` requires `--key value` pairs, and `--uninstall` is bare — so parse by hand. */
function parseArgs(argv: string[]): Options {
  const options: Options = { intervalMinutes: DEFAULT_INTERVAL_MINUTES, vault: undefined, uninstall: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--uninstall') {
      options.uninstall = true;
    } else if (arg === '--interval') {
      const value = argv[index += 1];
      if (value === undefined || !/^[0-9]+$/.test(value) || Number(value) === 0 || Number(value) > MAX_INTERVAL_MINUTES) {
        throw new Error(
          `invalid --interval: expected a whole number of minutes from 1 to ${MAX_INTERVAL_MINUTES}, got ${value ?? '(nothing)'}`,
        );
      }
      options.intervalMinutes = Number(value);
    } else if (arg === '--vault') {
      const value = argv[index += 1];
      if (value === undefined) throw new Error('--vault requires a directory');
      options.vault = path.resolve(value);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

/**
 * The absolute command the unit invokes. The installed binary when there is one; otherwise
 * this process's runtime plus the CLI it is running, so a dev checkout still produces a unit
 * that works. A bare `librarian` would be a broken unit — no scheduler has our PATH.
 */
function drainArgv(vault: string | undefined): string[] {
  const bin = installedLibrarianBin();
  const entry = process.argv[1];
  if (bin === undefined && entry === undefined) {
    throw new Error('cannot resolve an absolute librarian path for the timer; install the binary first');
  }
  const argv = bin !== undefined ? [bin] : [process.execPath, path.resolve(entry!)];
  argv.push('drain');
  if (vault !== undefined) argv.push('--vault', vault);
  return argv;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The installing shell's PATH, carried into the unit. A scheduler gives a job almost nothing
 * (launchd: `/usr/bin:/bin:/usr/sbin:/sbin`; cron and a systemd user unit are similarly bare),
 * but the distill providers spawn a bare `claude` / `opencode`, which live in `~/.local/bin`,
 * `~/.claude/local`, nvm and homebrew dirs. Without this the timer fires and fails every time —
 * the exact silent nothing-happened this command exists to prevent.
 */
function unitPath(): string {
  const value = process.env.PATH;
  return value === undefined || value === '' ? '/usr/bin:/bin:/usr/sbin:/sbin' : value;
}

function plistBody(argv: string[], intervalMinutes: number): string {
  const args = argv.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(unitPath())}</string>
    </dict>
    <key>StartInterval</key>
    <integer>${intervalMinutes * 60}</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(LOG_PATH)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(LOG_PATH)}</string>
  </dict>
</plist>
`;
}

/**
 * systemd splits ExecStart on whitespace unless the arguments are quoted — and then eats four
 * characters inside those quotes: `%` starts a specifier (an unknown one fails the unit load),
 * `$` starts a variable expansion, and `\`/`"` are the escape and the quote themselves.
 * A vault path is user-supplied, so all four must survive verbatim.
 */
function systemdQuote(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
}

function serviceBody(argv: string[]): string {
  return `[Unit]
Description=Librarian drain

[Service]
Type=oneshot
Environment=${systemdQuote(`PATH=${unitPath()}`)}
ExecStart=${argv.map(systemdQuote).join(' ')}
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}
`;
}

/**
 * A wall-clock calendar, not `OnUnitActiveSec=`. Monotonic timers run on CLOCK_MONOTONIC, which
 * does not advance while the machine is suspended, and `Persistent=` applies only to `OnCalendar=`
 * (systemd.timer(5)) — so the "slept through a firing, catch up on wake" case this command exists
 * for is only delivered by a calendar timer plus Persistent=true.
 */
function systemdCalendar(intervalMinutes: number): string {
  if (intervalMinutes < 60) return `*:0/${intervalMinutes}`;
  const hours = intervalMinutes / 60;
  return hours === 24 ? '00:00' : `0/${hours}:00`;
}

function timerBody(intervalMinutes: number): string {
  return `[Unit]
Description=Librarian drain on an interval

[Timer]
OnCalendar=${systemdCalendar(intervalMinutes)}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function cronSchedule(intervalMinutes: number): string {
  if (intervalMinutes < 60) return `*/${intervalMinutes} * * * *`;
  const hours = intervalMinutes / 60;
  return hours === 24 ? '0 0 * * *' : `0 */${hours} * * *`;
}

/**
 * Cron hands the line to `/bin/sh`, so every argument is single-quoted — unconditionally, because
 * the "does it need quoting" test is the bug: an embedded apostrophe closes the quote it opened.
 * Then cron itself, before the shell ever sees it, turns an unescaped `%` into a newline and
 * truncates the command there — hence `\%`, which cron consumes back down to a literal `%`.
 */
function cronLine(argv: string[], intervalMinutes: number): string {
  const quote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;
  // A `PATH=` line in the crontab would leak into the user's other jobs, so the assignment is a
  // shell env prefix on our command only — cron hands the line to /bin/sh, which honours it.
  const command = `PATH=${quote(unitPath())} ${argv.map(quote).join(' ')} >> ${quote(LOG_PATH)} 2>&1`;
  return `${cronSchedule(intervalMinutes)} ${command.replace(/%/g, '\\%')} ${CRON_MARKER}`;
}

type Printer = (text: string) => void;

/** Run an activation command, printing it first — the user must see what we did on their box. */
function activate(out: Printer, command: string, args: string[], optional = false): void {
  out(`  running ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (optional || result.status === 0) return;
  const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${String(result.status)}`;
  throw new Error(`activation failed: ${[command, ...args].join(' ')}: ${detail}`);
}

/**
 * Does `systemctl --user` actually reach a user manager here? `--version` does not: it ignores
 * `--user` and succeeds wherever the binary exists, so containers, plain SSH sessions and WSL
 * were taking the systemd branch and failing instead of falling back to cron. `show-environment`
 * is a real round-trip to the user bus.
 */
function hasSystemdUser(): boolean {
  return spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).status === 0;
}

/**
 * The current crontab, or empty when the user genuinely has none. `crontab -l` exits non-zero for
 * both "no crontab for user" and a real failure (no permission, spool unavailable, binary
 * missing) — and reading a real failure as "empty" means the write that follows drops every job
 * the user had. So only silence counts as empty; anything else fails loud before we write.
 */
function readCrontab(): string {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.status === 0) return result.stdout;
  const stderr = (result.stderr ?? '').trim();
  if (result.error === undefined && (result.stdout ?? '') === '' && (stderr === '' || /no crontab/i.test(stderr))) {
    return '';
  }
  throw new Error(`crontab -l failed: ${result.error?.message ?? stderr} — refusing to rewrite a crontab we cannot read`);
}

function writeCrontab(lines: string[]): void {
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  const result = spawnSync('crontab', ['-'], { input: text, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`crontab - failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${String(result.status)}`}`);
  }
}

function write(target: string, body: string, out: Printer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  out(`  wrote ${target}`);
}

/**
 * Remove whatever schedule this platform installed. Returns one description per thing removed,
 * empty when there was nothing — shared with `librarian uninstall`, which must not strand a
 * timer pointing at a binary it just deleted.
 */
export function removeSchedule(dryRun: boolean): string[] {
  const removed: string[] = [];
  const uid = String(os.userInfo().uid);

  if (platform() === 'darwin') {
    const plist = launchAgentPath();
    if (fs.existsSync(plist)) {
      if (!dryRun) {
        spawnSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], { encoding: 'utf8' });
        fs.rmSync(plist, { force: true });
      }
      removed.push(`${plist} (launchd agent ${LAUNCHD_LABEL}, booted out)`);
    }
    return removed;
  }

  if (platform() === 'linux') {
    const units = [path.join(systemdDir(), SYSTEMD_TIMER), path.join(systemdDir(), SYSTEMD_SERVICE)];
    if (units.some((unit) => fs.existsSync(unit))) {
      if (!dryRun) {
        spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_TIMER], { encoding: 'utf8' });
        for (const unit of units) fs.rmSync(unit, { force: true });
        spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
      }
      removed.push(`${units.join(', ')} (systemd user timer, disabled)`);
    }
    // Independent of systemd: an older install may have left the cron fallback behind.
    const lines = readCrontab().split('\n');
    const kept = lines.filter((line) => !line.includes(CRON_MARKER));
    if (kept.length !== lines.length) {
      if (!dryRun) writeCrontab(kept.filter((line) => line.trim().length > 0));
      removed.push(`the ${CRON_MARKER} crontab line`);
    }
  }

  return removed;
}

export function installScheduleCommand(argv: string[]): void {
  const options = parseArgs(argv);
  const out: Printer = (text) => { process.stdout.write(`${text}\n`); };

  if (options.uninstall) {
    out('librarian install-schedule --uninstall');
    const removed = removeSchedule(false);
    if (removed.length === 0) {
      out('  nothing to remove — no librarian schedule is installed');
      return;
    }
    for (const what of removed) out(`  removed ${what}`);
    return;
  }

  const vault = options.vault ?? loadConfig().vault;
  const drain = drainArgv(vault);
  const uid = String(os.userInfo().uid);
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  const interval = snapInterval(options.intervalMinutes);
  out(`librarian install-schedule (every ${interval} min)`);
  if (interval !== options.intervalMinutes) {
    out(`  ${options.intervalMinutes} min does not divide the clock evenly — using ${interval} min so the gaps stay equal`);
  }
  out(`  drain command: ${drain.join(' ')}`);
  if (vault === undefined) {
    out('  no vault configured — the timer will distill but export nothing. Set one with `librarian config`.');
  }
  out(`  log: ${LOG_PATH}`);
  out(`  PATH for the timer: ${unitPath()}`);

  // Always replace, never add. A box gains or loses systemd between installs, and re-running
  // would otherwise leave the cron line firing alongside the new timer (or vice versa) — two
  // drains an hour, one of them pointing at whatever the last install thought was true. This
  // also covers the same-mechanism re-run, so no separate launchd bootout is needed below.
  for (const what of removeSchedule(false)) out(`  replaced ${what}`);

  switch (platform()) {
    case 'darwin': {
      const plist = launchAgentPath();
      write(plist, plistBody(drain, interval), out);
      activate(out, 'launchctl', ['bootstrap', `gui/${uid}`, plist]);
      break;
    }
    case 'linux': {
      if (hasSystemdUser()) {
        write(path.join(systemdDir(), SYSTEMD_SERVICE), serviceBody(drain), out);
        write(path.join(systemdDir(), SYSTEMD_TIMER), timerBody(interval), out);
        activate(out, 'systemctl', ['--user', 'daemon-reload']);
        activate(out, 'systemctl', ['--user', 'enable', '--now', SYSTEMD_TIMER]);
        break;
      }
      out('  systemctl --user does not resolve here — falling back to cron');
      const line = cronLine(drain, interval);
      // removeSchedule above already stripped any marker line, so this is just "keep their jobs".
      const kept = readCrontab().split('\n').filter((existing) => existing.trim().length > 0);
      writeCrontab([...kept, line]);
      out(`  installed crontab line: ${line}`);
      break;
    }
    default:
      throw new Error(
        `librarian install-schedule does not know ${platform()}. Add your own timer running: ${drain.join(' ')}`,
      );
  }

  out(`  drains every ${interval} min from now on. Remove it with \`librarian install-schedule --uninstall\`.`);
}
