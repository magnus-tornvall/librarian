import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../paths.ts';

/**
 * Native-artifact loading for the packaged single-executable (#149).
 *
 * `better-sqlite3` (a `.node` addon) and `sqlite-vec` (a loadable `.dylib`/`.so`/
 * `.dll`) cannot execute from the in-memory SEA blob — the OS loads them by real
 * path. We embed both as SEA assets and extract them, once, to a per-binary cache
 * dir on first run, so the shipped artifact stays a *single self-contained file*
 * (which keeps the update story a trivial atomic file replace — see the PoC note).
 *
 * Everything here no-ops off the SEA path: a plain `node dist/cli.js` run (dev,
 * tests, `npm i -g`) resolves both deps the normal way and never touches this.
 */

type SeaApi = { isSea(): boolean; getRawAsset(name: string): ArrayBuffer };

// Anchor on the executable path, not import.meta.url: esbuild's CJS shim for
// import.meta.url produces a value createRequire can't resolve inside a SEA blob,
// which silently disables SEA detection. process.execPath is always valid.
const req = createRequire(process.execPath);

// `node:sea` is a builtin; importing it statically drags an experimental-module
// warning into every dev run, so require it lazily and tolerate absence.
const seaApi: SeaApi | undefined = (() => {
  try {
    return req('node:sea') as SeaApi;
  } catch {
    return undefined;
  }
})();

export function isSea(): boolean {
  return seaApi?.isSea() ?? false;
}

// Reject a cache dir another local user could have planted a malicious addon
// into. Owner-only + not group/world-writable means only we can put files here.
function assertPrivateDir(dir: string): void {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`native cache path is not a directory: ${dir}`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`native cache dir is not owned by the current user: ${dir}`);
  if ((st.mode & 0o022) !== 0) throw new Error(`native cache dir is group/world-writable: ${dir}`);
}

// The extracted `.node`/`.dylib` are native code we then execute, so the cache
// MUST live somewhere only this user can write — never a shared temp dir. In a
// world-writable /tmp a local attacker can pre-plant a file at the predictable
// `<size>-<mtime>` path and we'd load their code (extractAsset trusts an existing
// file). ~/.librarian/cache is inside the user's home; other users can't write it.
// ponytail: key by binary size+mtime — cheap, re-extracts on rebuild/update. Hash
// the blob instead only if a collision ever bites.
let cacheDir: string | undefined;
function assetCacheDir(): string {
  if (cacheDir) return cacheDir;
  const stat = fs.statSync(process.execPath);
  const dir = path.join(CACHE_DIR, 'native', `${stat.size}-${Math.round(stat.mtimeMs)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir);
  cacheDir = dir;
  return dir;
}

function extractAsset(name: string): string {
  if (!seaApi) throw new Error('native asset requested outside a SEA binary');
  const dest = path.join(assetCacheDir(), name);
  if (!fs.existsSync(dest)) {
    // Write to a temp sibling then rename, so a second process racing us never
    // sees a half-written addon. The dir is owner-only, so the file is ours.
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(seaApi.getRawAsset(name)), { mode: 0o755 });
    fs.renameSync(tmp, dest);
  }
  return dest;
}

/**
 * The already-loaded `better-sqlite3` addon object for `new Database(file, {
 * nativeBinding })`. Passing the object (not a path) sidesteps SEA's restricted
 * `require`, which cannot resolve an arbitrary `.node` path — `createRequire`
 * anchored at the binary can. Returns undefined off the SEA path (default
 * resolution applies).
 */
export function betterSqliteAddon(): unknown | undefined {
  if (!isSea()) return undefined;
  return req(extractAsset('better_sqlite3.node'));
}

/**
 * Filesystem path to the extracted `sqlite-vec` loadable extension, for
 * `db.loadExtension(...)`. Returns undefined off the SEA path — the caller then
 * uses `sqlite-vec`'s own package resolution.
 */
export function sqliteVecExtensionPath(): string | undefined {
  return isSea() ? extractAsset('vec0.dylib') : undefined;
}
