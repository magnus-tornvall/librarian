import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './paths.ts';
import { VERSION } from './version.ts';
import { isSea } from './index/nativeAssets.ts';

const DEFAULT_TAGS_URL = 'https://api.github.com/repos/magnus-tornvall/librarian/tags';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

type Tag = { name?: unknown };
type Version = { text: string; parts: [number, number, number] };
type Check = { installed?: Version; latest?: Version };

function tagsUrl(): string {
  return process.env.LIBRARIAN_TAGS_URL ?? DEFAULT_TAGS_URL;
}

function version(value: string): Version | undefined {
  const match = VERSION_TAG.exec(value);
  if (!match) return undefined;
  return { text: value, parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

function compare(left: Version, right: Version): number {
  for (let i = 0; i < left.parts.length; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  }
  return 0;
}

export async function latestVersion(): Promise<Version | undefined> {
  const response = await fetch(tagsUrl(), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`tag check failed: ${response.status} ${response.statusText}`);
  const tags = await response.json();
  if (!Array.isArray(tags)) throw new Error('tag check returned invalid JSON');
  return (tags as Tag[])
    .flatMap((tag) => typeof tag.name === 'string' ? [version(tag.name)] : [])
    .filter((tag): tag is Version => tag !== undefined)
    .reduce<Version | undefined>((highest, tag) => !highest || compare(tag, highest) > 0 ? tag : highest, undefined);
}

export async function checkForUpdate(): Promise<Check> {
  const installed = version(VERSION);
  return installed ? { installed, latest: await latestVersion() } : {};
}

function checkText(check: Check): string {
  if (!check.installed) return `Development build (${VERSION}); updates are only available for released vX.Y.Z builds.`;
  if (!check.latest || compare(check.latest, check.installed) <= 0) return `Librarian ${check.installed.text} is up to date.`;
  return `Librarian ${check.latest.text} is available (installed: ${check.installed.text}). Run \`librarian update\` to apply it.`;
}

function throttlePath(): string {
  return path.join(CACHE_DIR, 'update-check');
}

function recentlyChecked(): boolean {
  try {
    return Date.now() - Number(fs.readFileSync(throttlePath(), 'utf8')) < CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

function markChecked(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(throttlePath(), String(Date.now()));
}

/** A best-effort human hint. It never affects command success or protocol stdout. */
export async function passiveUpdateCheck(): Promise<void> {
  if (!process.stderr.isTTY || process.env.CI || recentlyChecked() || !version(VERSION)) return;
  try {
    const check = await checkForUpdate();
    markChecked();
    if (check.installed && check.latest && compare(check.latest, check.installed) > 0) {
      process.stderr.write(`\n${checkText(check)}\n`);
    }
  } catch {
    // Network availability must never make normal librarian use fail.
  }
}

async function stageCandidate(target: string): Promise<string> {
  const staged = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.update`);
  try {
    if (process.env.LIBRARIAN_BINARY) {
      fs.copyFileSync(process.env.LIBRARIAN_BINARY, staged);
    } else if (process.env.LIBRARIAN_URL) {
      const response = await fetch(process.env.LIBRARIAN_URL);
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      fs.writeFileSync(staged, Buffer.from(await response.arrayBuffer()));
    } else {
      throw new Error('no update source. Set LIBRARIAN_BINARY or LIBRARIAN_URL; update remains check-only.');
    }
    fs.chmodSync(staged, 0o755);
    return staged;
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

function verify(target: string, candidate: string): string | undefined {
  const result = spawnSync(target, ['doctor', '--json'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return result.error?.message ?? `doctor exited ${result.status}`;
  try {
    const report = JSON.parse(result.stdout) as { version?: unknown; native?: { ok?: unknown } };
    if (report.version !== candidate) return `candidate reported ${String(report.version)}, expected ${candidate}`;
    if (report.native?.ok !== true) return 'candidate native stack check failed';
  } catch {
    return 'candidate doctor returned invalid JSON';
  }
  return undefined;
}

function refreshOpenCodePlugin(): void {
  const result = spawnSync(process.execPath, ['update', '--refresh-opencode-plugin'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'could not refresh OpenCode plugin');
}

export async function updateCommand(argv: string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === '--refresh-opencode-plugin') {
    const { installOpenCodePlugin, openCodePluginPath } = await import('./hook/opencodeInstall.ts');
    if (fs.existsSync(openCodePluginPath())) installOpenCodePlugin();
    return;
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) throw new Error('update accepts only --check');
  const check = await checkForUpdate();
  if (argv[0] === '--check') {
    process.stdout.write(checkText(check) + '\n');
    return;
  }
  if (!isSea()) throw new Error('update requires an installed Librarian binary; run-from-source will not modify the Node executable');
  if (!check.installed) throw new Error(`development build (${VERSION}) cannot self-update`);
  if (!check.latest || compare(check.latest, check.installed) <= 0) {
    process.stdout.write(checkText(check) + '\n');
    return;
  }

  const target = process.execPath;
  const staged = await stageCandidate(target);
  const rollback = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.rollback`);
  fs.copyFileSync(target, rollback);
  try {
    fs.renameSync(staged, target);
    const failure = verify(target, check.latest.text);
    if (failure) throw new Error(`update verification failed: ${failure}`);
    refreshOpenCodePlugin();
    fs.rmSync(rollback, { force: true });
    process.stdout.write(`Updated Librarian to ${check.latest.text}.\n`);
  } catch (error) {
    fs.renameSync(rollback, target);
    throw error;
  } finally {
    fs.rmSync(staged, { force: true });
    fs.rmSync(rollback, { force: true });
  }
}
