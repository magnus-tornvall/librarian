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
// HOME and XDG_CONFIG_HOME are set explicitly per test because the unit paths derive from
// os.homedir(): tests/setup-home.ts isolates this process, not the child's launchd dir.

const CLI = path.join(import.meta.dirname, '..', '..', 'src', 'cli.ts');

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A bash stub per name that appends `<name> <argv...>` (and any stdin) to one log file. */
function stubBin(root: string, names: string[]): { binDir: string; log: string } {
  const binDir = path.join(root, 'bin');
  const log = path.join(root, 'invocations.log');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of names) {
    const stub = path.join(binDir, name);
    fs.writeFileSync(stub, `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(log)}\ncat >> ${JSON.stringify(log)} 2>/dev/null\nexit 0\n`);
    fs.chmodSync(stub, 0o755);
  }
  return { binDir, log };
}

type Env = { home: string; binDir: string; log: string; platform?: string };

function makeEnv(prefix: string, stubs: string[], platform?: string): Env {
  const root = tempDir(prefix);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { binDir, log } = stubBin(root, stubs);
  return { home, binDir, log, platform };
}

function runSchedule(env: Env, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CLI, 'install-schedule', ...args], {
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

/** The absolute-path assertions every generated unit owes us, whatever the mechanism. */
function assertUnitInvokesDrain(body: string, vault: string): void {
  assert.match(body, /drain/, 'the unit must invoke drain');
  assert.ok(body.includes(`--vault`) && body.includes(vault), `the unit must pass --vault ${vault}; got:\n${body}`);
  assert.ok(
    body.includes(process.execPath) || /["\s]\/[^"\s]*librarian/.test(body),
    `the unit must name an absolute librarian path, never a bare \`librarian\`; got:\n${body}`,
  );
  assert.doesNotMatch(body, /(^|[\s"])librarian(\s|"|$)/m, 'a bare `librarian` would never resolve under a scheduler');
}

test('install-schedule (darwin): writes a launchd plist invoking drain with the vault and interval, and bootstraps it', { skip: process.platform !== 'darwin' ? 'darwin only' : false }, () => {
  const env = makeEnv('cli-schedule-darwin-', ['launchctl']);
  const vault = path.join(env.home, 'vault');

  const result = runSchedule(env, ['--interval', '15', '--vault', vault]);
  assert.equal(result.status, 0, `install-schedule should exit 0; stderr: ${result.stderr}`);

  const plist = launchAgent(env);
  assert.ok(fs.existsSync(plist), `the plist must exist at ${plist}`);
  const body = fs.readFileSync(plist, 'utf8');
  assert.match(body, /<key>Label<\/key>\s*<string>com\.librarian\.drain<\/string>/);
  assert.match(body, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/, '15 minutes must become 900 seconds');
  assertUnitInvokesDrain(body, vault);
  // The log must land under ~/.librarian, never in the vault.
  assert.ok(body.includes(path.join(env.home, '.librarian', 'logs', 'drain.log')));
  assert.equal(body.includes(`<string>${vault}/`), false, 'no log path may point into the vault');

  // Activation really ran, and the glass-box output says so.
  const log = invocations(env);
  assert.match(log, /launchctl bootout gui\/\d+\/com\.librarian\.drain/);
  assert.match(log, new RegExp(`launchctl bootstrap gui/\\d+ ${plist.replace(/[/.]/g, (c) => `\\${c}`)}`));
  assert.match(result.stdout, /wrote /);
  assert.match(result.stdout, /running launchctl bootstrap/);
});

test('install-schedule (darwin): --uninstall removes the plist, boots it out, and is exit 0 with nothing installed', { skip: process.platform !== 'darwin' ? 'darwin only' : false }, () => {
  const env = makeEnv('cli-schedule-darwin-rm-', ['launchctl']);

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
  const env = makeEnv('cli-schedule-systemd-', ['systemctl'], 'linux');
  const vault = path.join(env.home, 'vault');

  const result = runSchedule(env, ['--interval', '30', '--vault', vault]);
  assert.equal(result.status, 0, `install-schedule should exit 0; stderr: ${result.stderr}`);

  const service = fs.readFileSync(systemdUnit(env, 'librarian-drain.service'), 'utf8');
  assert.match(service, /Type=oneshot/);
  assertUnitInvokesDrain(service, vault);
  const timer = fs.readFileSync(systemdUnit(env, 'librarian-drain.timer'), 'utf8');
  assert.match(timer, /OnUnitActiveSec=30min/);
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
  // No `systemctl` stub at all → `systemctl --user --version` fails → cron fallback. The
  // crontab stub logs argv AND the piped stdin, which is the installed line itself.
  const env = makeEnv('cli-schedule-cron-', ['crontab'], 'linux');
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
  assertUnitInvokesDrain(line, vault);

  // Nothing to remove: the stub's `crontab -l` prints nothing, so uninstall is a clean no-op.
  fs.rmSync(env.log, { force: true });
  const removed = runSchedule(env, ['--uninstall']);
  assert.equal(removed.status, 0, `uninstall should exit 0; stderr: ${removed.stderr}`);
  assert.match(removed.stdout, /nothing to remove/);
});

test('install-schedule: an unknown platform fails loud and prints the command to schedule by hand', () => {
  const env = makeEnv('cli-schedule-unknown-', [], 'sunos');
  const result = runSchedule(env, ['--vault', path.join(env.home, 'vault')]);
  assert.equal(result.status, 1, 'an unsupported platform must exit non-zero');
  assert.match(result.stderr, /sunos/, 'the error must name the platform');
  assert.match(result.stderr, /drain/, 'the error must print the drain command to wire by hand');
});

test('install-schedule: a garbage --interval fails loud and writes nothing', () => {
  const env = makeEnv('cli-schedule-bad-interval-', ['launchctl', 'systemctl', 'crontab']);
  for (const bad of ['0', '-5', 'soon', '1.5']) {
    const result = runSchedule(env, ['--interval', bad]);
    assert.equal(result.status, 1, `--interval ${bad} must exit non-zero`);
    assert.match(result.stderr, /invalid --interval/);
  }
  assert.equal(runSchedule(env, ['--interval']).status, 1, 'a missing --interval value must fail too');
  assert.equal(fs.existsSync(launchAgent(env)), false, 'a rejected run must not write a unit');
  assert.equal(invocations(env), '', 'a rejected run must not activate anything');
});
