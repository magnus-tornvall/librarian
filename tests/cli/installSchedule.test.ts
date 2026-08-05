import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Integration tests for `librarian install-schedule`: spawn the real CLI, let it write a real
// unit file into a throwaway HOME, and let it really invoke the activation command — except
// `launchctl`/`systemctl`/`crontab` are bash stubs on a prepended PATH that log their argv.
// That keeps the whole thing observable without registering a timer on the dev machine.
//
// All three stubs exist in every test, always, and a test that wants a mechanism *absent* gives
// its stub exit 1. Deciding a branch by what the host happens not to have installed is how you
// get a suite that reconfigures the developer's real systemd and rewrites their real crontab.
//
// HOME and XDG_CONFIG_HOME are set explicitly per test because the unit paths derive from
// os.homedir(): tests/setup-home.ts isolates this process, not the child's launchd dir.

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const SCHEDULER_BINS = ['launchctl', 'systemctl', 'crontab'];

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A bash stub per scheduler binary that appends `<name> <argv...>` (and any stdin) to one log. */
function stubBin(root: string, failing: string[]): { binDir: string; log: string } {
  const binDir = path.join(root, 'bin');
  const log = path.join(root, 'invocations.log');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of SCHEDULER_BINS) {
    const stub = path.join(binDir, name);
    const status = failing.includes(name) ? 1 : 0;
    fs.writeFileSync(stub, `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(log)}\ncat >> ${JSON.stringify(log)} 2>/dev/null\nexit ${status}\n`);
    fs.chmodSync(stub, 0o755);
  }
  return { binDir, log };
}

type Env = { home: string; binDir: string; log: string; platform?: string };

function makeEnv(prefix: string, platform?: string, failing: string[] = []): Env {
  const root = tempDir(prefix);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { binDir, log } = stubBin(root, failing);
  return { home, binDir, log, platform };
}

function runSchedule(env: Env, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, 'install-schedule', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: env.home,
      XDG_CONFIG_HOME: path.join(env.home, '.config'),
      PATH: `${env.binDir}:${process.env.PATH ?? ''}`,
      ...(env.platform === undefined ? {} : { LIBRARIAN_SCHEDULE_PLATFORM: env.platform }),
    },
  });
}

function invocations(env: Env): string {
  return fs.existsSync(env.log) ? fs.readFileSync(env.log, 'utf8') : '';
}

function launchAgent(env: Env): string {
  return path.join(env.home, 'Library', 'LaunchAgents', 'com.librarian.drain.plist');
}

function systemdUnit(env: Env, name: string): string {
  return path.join(env.home, '.config', 'systemd', 'user', name);
}

function firstMatch(body: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(body);
  assert.ok(match, `could not find ${what} in:\n${body}`);
  return match[1]!;
}

/** The thing the mechanism actually execs — the first argument, before any of ours. */
const plistProgram = (body: string): string => firstMatch(body, /<array>\s*<string>([^<]*)<\/string>/, 'ProgramArguments[0]');
const systemdProgram = (body: string): string => firstMatch(body, /^ExecStart="((?:[^"\\]|\\.)*)"/m, 'the ExecStart program');
const cronProgram = (line: string): string => firstMatch(line, / PATH='.*?' '([^']*)'/, 'the cron command');

/**
 * The assertions every generated unit owes us, whatever the mechanism: it execs a real absolute
 * path (a bare `librarian` would never resolve — no scheduler has our PATH), it drains the vault,
 * and it carries a PATH — the distill providers spawn a bare `claude`/`opencode`, so a unit
 * without one fires into a spawn error forever.
 */
function assertUnitInvokesDrain(env: Env, body: string, program: string, vault: string): void {
  assert.ok(path.isAbsolute(program), `the unit must exec an absolute path, not \`${program}\``);
  assert.ok(fs.existsSync(program), `the unit's program must exist on disk, got \`${program}\``);
  assert.match(body, /drain/, 'the unit must invoke drain');
  assert.ok(body.includes('--vault') && body.includes(vault), `the unit must pass --vault ${vault}; got:\n${body}`);
  // env.binDir heads the installing shell's PATH, so finding it proves the whole PATH came across.
  assert.ok(body.includes(env.binDir), `the unit must carry the installing shell's PATH; got:\n${body}`);
}

test('install-schedule (darwin): writes a launchd plist invoking drain with the vault and interval, and bootstraps it', { skip: process.platform !== 'darwin' ? 'darwin only' : false }, () => {
  const env = makeEnv('cli-schedule-darwin-');
  const vault = path.join(env.home, 'vault');

  const result = runSchedule(env, ['--interval', '15', '--vault', vault]);
  assert.equal(result.status, 0, `install-schedule should exit 0; stderr: ${result.stderr}`);

  const plist = launchAgent(env);
  assert.ok(fs.existsSync(plist), `the plist must exist at ${plist}`);
  const body = fs.readFileSync(plist, 'utf8');
  assert.match(body, /<key>Label<\/key>\s*<string>com\.librarian\.drain<\/string>/);
  assert.match(body, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/, '15 minutes must become 900 seconds');
  assertUnitInvokesDrain(env, body, plistProgram(body), vault);
  assert.match(
    body,
    new RegExp(`<key>EnvironmentVariables</key>\\s*<dict>\\s*<key>PATH</key>\\s*<string>${env.binDir}:`),
    'launchd gives a job PATH=/usr/bin:/bin:/usr/sbin:/sbin, so the plist must set one',
  );
  // The log must land under ~/.librarian, never in the vault.
  assert.ok(body.includes(path.join(env.home, '.librarian', 'logs', 'drain.log')));
  assert.equal(body.includes(`<string>${vault}/`), false, 'no log path may point into the vault');

  // Activation really ran, and the glass-box output says so. Nothing was installed before, so
  // there is nothing to boot out — the replacement step is silent on a first install.
  const log = invocations(env);
  assert.match(log, new RegExp(`launchctl bootstrap gui/\\d+ ${plist.replace(/[/.]/g, (c) => `\\${c}`)}`));
  assert.match(result.stdout, /wrote /);
  assert.match(result.stdout, /running launchctl bootstrap/);
  assert.match(result.stdout, /PATH for the timer: /, 'glass-box: the PATH the timer gets must be printed');
  assert.doesNotMatch(result.stdout, /replaced /);

  // A re-run replaces rather than stacks: the old agent is booted out before the new one loads.
  fs.rmSync(env.log, { force: true });
  const again = runSchedule(env, ['--interval', '15', '--vault', vault]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /replaced .*launchd agent/);
  assert.match(invocations(env), /launchctl bootout gui\/\d+\/com\.librarian\.drain/);
});

test('install-schedule (darwin): --uninstall removes the plist, boots it out, and is exit 0 with nothing installed', { skip: process.platform !== 'darwin' ? 'darwin only' : false }, () => {
  const env = makeEnv('cli-schedule-darwin-rm-');

  const empty = runSchedule(env, ['--uninstall']);
  assert.equal(empty.status, 0, 'uninstall with nothing installed must exit 0');
  assert.match(empty.stdout, /nothing to remove/);

  assert.equal(runSchedule(env, ['--vault', path.join(env.home, 'vault')]).status, 0);
  assert.ok(fs.existsSync(launchAgent(env)));
  fs.rmSync(env.log, { force: true });

  const removed = runSchedule(env, ['--uninstall']);
  assert.equal(removed.status, 0, `uninstall should exit 0; stderr: ${removed.stderr}`);
  assert.equal(fs.existsSync(launchAgent(env)), false, 'the plist must be gone');
  assert.match(invocations(env), /launchctl bootout gui\/\d+\/com\.librarian\.drain/);
  assert.match(removed.stdout, /removed /);
});

test('install-schedule (linux, systemd): writes service+timer, reloads, and enables the timer', () => {
  const env = makeEnv('cli-schedule-systemd-', 'linux');
  const vault = path.join(env.home, 'vault');

  const result = runSchedule(env, ['--interval', '30', '--vault', vault]);
  assert.equal(result.status, 0, `install-schedule should exit 0; stderr: ${result.stderr}`);

  const service = fs.readFileSync(systemdUnit(env, 'librarian-drain.service'), 'utf8');
  assert.match(service, /Type=oneshot/);
  assertUnitInvokesDrain(env, service, systemdProgram(service), vault);
  assert.ok(service.includes(`Environment="PATH=${env.binDir}:`), `the service must set PATH; got:\n${service}`);
  // The branch must be chosen by a probe that actually reaches the user bus — `--version` ignores
  // `--user` and succeeds wherever the binary exists.
  assert.match(invocations(env), /systemctl --user show-environment/, 'the systemd probe must touch the user bus');
  const timer = fs.readFileSync(systemdUnit(env, 'librarian-drain.timer'), 'utf8');
  // A calendar timer, not OnUnitActiveSec: monotonic time does not advance across suspend, and
  // Persistent= (the catch-up we promise) only applies to OnCalendar=.
  assert.match(timer, /^OnCalendar=\*:0\/30$/m, '30 minutes must become a wall-clock half-hour calendar');
  assert.doesNotMatch(timer, /OnUnitActiveSec|OnBootSec/, 'a monotonic trigger cannot catch up a missed firing');
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /WantedBy=timers\.target/);

  const log = invocations(env);
  assert.match(log, /systemctl --user daemon-reload/);
  assert.match(log, /systemctl --user enable --now librarian-drain\.timer/);

  // --uninstall disables and deletes both units.
  fs.rmSync(env.log, { force: true });
  const removed = runSchedule(env, ['--uninstall']);
  assert.equal(removed.status, 0, `uninstall should exit 0; stderr: ${removed.stderr}`);
  assert.equal(fs.existsSync(systemdUnit(env, 'librarian-drain.timer')), false);
  assert.equal(fs.existsSync(systemdUnit(env, 'librarian-drain.service')), false);
  assert.match(invocations(env), /systemctl --user disable --now librarian-drain\.timer/);
});

test('install-schedule (linux, no systemd): falls back to a marker-tagged crontab line, and --uninstall strips it', () => {
  // `systemctl` is present but exits 1 — the stub, not the host, decides the branch. The crontab
  // stub logs argv AND the piped stdin, which is the installed line itself.
  const env = makeEnv('cli-schedule-cron-', 'linux', ['systemctl']);
  const vault = path.join(env.home, 'vault');

  const result = runSchedule(env, ['--interval', '20', '--vault', vault]);
  assert.equal(result.status, 0, `install-schedule should exit 0; stderr: ${result.stderr}`);
  assert.match(result.stdout, /falling back to cron/);

  const log = invocations(env);
  assert.match(log, /crontab -l/);
  assert.match(log, /crontab -\n/, 'the new crontab must be piped in through `crontab -`');
  const line = log.split('\n').find((l) => l.includes('# librarian-drain'));
  assert.ok(line !== undefined, `a marker-tagged line must be installed; log:\n${log}`);
  assert.match(line, /^\*\/20 \* \* \* \* /, '20 minutes must become a */20 minute field');
  assertUnitInvokesDrain(env, line, cronProgram(line), vault);
  // A shell env prefix, not a crontab-wide `PATH=` line, which would leak into the user's own jobs.
  assert.ok(line.includes(`PATH='${env.binDir}:`), `the cron command must set PATH; got:\n${line}`);
  assert.match(invocations(env), /systemctl --user show-environment/, 'the cron branch must be the probe failing');

  // Nothing to remove: the stub's `crontab -l` prints nothing, so uninstall is a clean no-op.
  fs.rmSync(env.log, { force: true });
  const removed = runSchedule(env, ['--uninstall']);
  assert.equal(removed.status, 0, `uninstall should exit 0; stderr: ${removed.stderr}`);
  assert.match(removed.stdout, /nothing to remove/);
});

test('install-schedule: the vault comes from the config when --vault is absent', () => {
  const env = makeEnv('cli-schedule-config-vault-', 'linux');
  const vault = path.join(env.home, 'configured vault');
  fs.mkdirSync(path.join(env.home, '.librarian'), { recursive: true });
  fs.writeFileSync(
    path.join(env.home, '.librarian', 'config.json'),
    `${JSON.stringify({ inference: { provider: 'opencode' }, vault }, null, 2)}\n`,
  );

  const result = runSchedule(env, []);
  assert.equal(result.status, 0, `install-schedule should exit 0; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stdout, /no vault configured/);

  const service = fs.readFileSync(systemdUnit(env, 'librarian-drain.service'), 'utf8');
  assertUnitInvokesDrain(env, service, systemdProgram(service), vault);
});

// A vault path is user input, and cron and systemd each translate characters before anything runs:
// cron turns a bare `%` into a newline (truncating the command) and hands the rest to /bin/sh, and
// systemd reads `%` as a specifier and `$` as a variable inside the quotes it needs for whitespace.
const HOSTILE_DIR = `Bob's "weird" 100%$vault dir`;

test('install-schedule (systemd): a hostile vault path survives ExecStart quoting', () => {
  const env = makeEnv('cli-schedule-systemd-hostile-', 'linux');
  const vault = path.join(env.home, HOSTILE_DIR);

  assert.equal(runSchedule(env, ['--vault', vault]).status, 0);
  const service = fs.readFileSync(systemdUnit(env, 'librarian-drain.service'), 'utf8');
  const escaped = `${env.home}/Bob's \\"weird\\" 100%%$$vault dir`;
  assert.ok(
    service.includes(`"--vault" "${escaped}"`),
    `ExecStart must escape \\ " $ and %; expected "${escaped}", got:\n${service}`,
  );
  // The exact failures: a raw `"` ends the argument, `%$` is an unknown specifier (unit fails to
  // load), and `$vault` would be expanded away.
  assert.equal(service.includes(`100%$vault`), false, 'an unescaped %/$ would break the unit load');
  assert.equal(service.includes(`"weird"`), false, 'an unescaped quote would end the argument early');
});

test('install-schedule (cron): a hostile vault path survives shell quoting and cron % translation', () => {
  const env = makeEnv('cli-schedule-cron-hostile-', 'linux', ['systemctl']);
  const vault = path.join(env.home, HOSTILE_DIR);

  assert.equal(runSchedule(env, ['--vault', vault]).status, 0);
  const line = invocations(env).split('\n').find((l) => l.includes('# librarian-drain'));
  assert.ok(line !== undefined);
  // '\'' closes, escapes, reopens — the only way an apostrophe survives single quotes. And every
  // % is backslashed, or cron replaces it with a newline and the command ends there.
  const quoted = `'${env.home}/Bob'\\''s "weird" 100\\%$vault dir'`;
  assert.ok(line.includes(`'--vault' ${quoted}`), `expected ${quoted} in:\n${line}`);
  assert.equal(/[^\\]%/.test(line), false, `every % must be backslash-escaped; got:\n${line}`);
});

/** Replace one stub — for the failure modes and the statefulness the logging stub cannot express. */
function overrideStub(env: Env, name: string, body: string): void {
  const stub = path.join(env.binDir, name);
  fs.writeFileSync(stub, body);
  fs.chmodSync(stub, 0o755);
}

/** A `crontab` backed by a real file, so a second install sees what the first one installed. */
function spoolCrontab(env: Env): string {
  const spool = path.join(path.dirname(env.binDir), 'spool');
  overrideStub(env, 'crontab', `#!/bin/bash
echo "crontab $*" >> ${JSON.stringify(env.log)}
if [ "$1" = "-l" ]; then
  if [ -s ${JSON.stringify(spool)} ]; then cat ${JSON.stringify(spool)}; exit 0; fi
  echo "no crontab for tester" >&2
  exit 1
fi
cat > ${JSON.stringify(spool)}
exit 0
`);
  return spool;
}

test('install-schedule: a crontab we cannot read is never rewritten', () => {
  // `crontab -l` exits non-zero for "no crontab" AND for a real failure. Reading the second as
  // "empty" and writing our line on top silently destroys every job the user had.
  const env = makeEnv('cli-schedule-cron-unreadable-', 'linux', ['systemctl']);
  overrideStub(env, 'crontab', `#!/bin/bash
echo "crontab $*" >> ${JSON.stringify(env.log)}
if [ "$1" = "-l" ]; then
  echo "0 3 * * * /usr/local/bin/backup.sh"
  echo "crontab: cannot open /var/at/tabs: permission denied" >&2
  exit 1
fi
exit 0
`);

  const result = runSchedule(env, ['--vault', path.join(env.home, 'vault')]);
  assert.equal(result.status, 1, 'an unreadable crontab must fail loud, not install');
  assert.match(result.stderr, /permission denied/, 'the underlying failure must be reported');
  assert.doesNotMatch(invocations(env), /crontab -\n/, 'nothing may be written to a crontab we could not read');
  assert.doesNotMatch(result.stdout, /installed crontab line/);

  // Same rule on the way out: uninstall must not "clean up" a crontab it could not read either.
  fs.rmSync(env.log, { force: true });
  assert.equal(runSchedule(env, ['--uninstall']).status, 1);
  assert.doesNotMatch(invocations(env), /crontab -\n/);
});

test('install-schedule: switching mechanism replaces the old one instead of stacking two drains', () => {
  const env = makeEnv('cli-schedule-switch-', 'linux', ['systemctl']);
  const spool = spoolCrontab(env);
  fs.writeFileSync(spool, '0 3 * * * /usr/local/bin/backup.sh\n');
  const vault = path.join(env.home, 'vault');

  // No systemd yet → the cron fallback.
  assert.equal(runSchedule(env, ['--vault', vault]).status, 0);
  assert.match(fs.readFileSync(spool, 'utf8'), /# librarian-drain/);

  // The box gains a user bus. Installing again must take the cron line back out, or the user gets
  // two periodic drains — the cron one still pointing at whatever the first install believed.
  overrideStub(env, 'systemctl', `#!/bin/bash\necho "systemctl $*" >> ${JSON.stringify(env.log)}\nexit 0\n`);
  const second = runSchedule(env, ['--vault', vault]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /replaced the # librarian-drain crontab line/);
  assert.ok(fs.existsSync(systemdUnit(env, 'librarian-drain.timer')), 'the systemd timer must be installed');

  const crontab = fs.readFileSync(spool, 'utf8');
  assert.doesNotMatch(crontab, /# librarian-drain/, 'the superseded cron line must be gone');
  assert.match(crontab, /backup\.sh/, "the user's own jobs must survive the replacement");
});

test('install-schedule: an unknown platform fails loud and prints the command to schedule by hand', () => {
  const env = makeEnv('cli-schedule-unknown-', 'sunos');
  const result = runSchedule(env, ['--vault', path.join(env.home, 'vault')]);
  assert.equal(result.status, 1, 'an unsupported platform must exit non-zero');
  assert.match(result.stderr, /sunos/, 'the error must name the platform');
  assert.match(result.stderr, /drain/, 'the error must print the drain command to wire by hand');
});

test('install-schedule: a garbage --interval fails loud and writes nothing', () => {
  const env = makeEnv('cli-schedule-bad-interval-');
  // 1441+ is rejected rather than clamped: launchd renders a huge StartInterval in float
  // notation, which is a plist launchd cannot parse — and it would already be on disk.
  for (const bad of ['0', '-5', 'soon', '1.5', '1441', '99999999999999999999']) {
    const result = runSchedule(env, ['--interval', bad]);
    assert.equal(result.status, 1, `--interval ${bad} must exit non-zero`);
    assert.match(result.stderr, /invalid --interval/);
  }
  assert.equal(runSchedule(env, ['--interval']).status, 1, 'a missing --interval value must fail too');
  assert.equal(fs.existsSync(launchAgent(env)), false, 'a rejected run must not write a unit');
  assert.equal(invocations(env), '', 'a rejected run must not activate anything');
});

test('install-schedule: an interval the calendar cannot express evenly is snapped, and the snap is what gets printed', () => {
  const env = makeEnv('cli-schedule-snap-', 'linux');

  // */45 fires at :00 and :45 — a 45-minute gap then a 15-minute one. 30 is the honest cadence.
  const uneven = runSchedule(env, ['--interval', '45', '--vault', path.join(env.home, 'vault')]);
  assert.equal(uneven.status, 0, uneven.stderr);
  assert.match(uneven.stdout, /using 30 min/, 'the snap must be reported, not silent');
  assert.match(uneven.stdout, /drains every 30 min/, 'the printed cadence must be the installed one');
  assert.match(fs.readFileSync(systemdUnit(env, 'librarian-drain.timer'), 'utf8'), /^OnCalendar=\*:0\/30$/m);

  // A whole day is the ceiling, and it is a daily calendar rather than a bogus 24-hour step.
  const daily = runSchedule(env, ['--interval', '1440', '--vault', path.join(env.home, 'vault')]);
  assert.equal(daily.status, 0, daily.stderr);
  assert.match(daily.stdout, /drains every 1440 min/);
  assert.match(fs.readFileSync(systemdUnit(env, 'librarian-drain.timer'), 'utf8'), /^OnCalendar=00:00$/m);
});
