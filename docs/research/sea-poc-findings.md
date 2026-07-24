# SEA single-executable PoC — findings

**Spike:** #149. **Date:** 2026-07-24. **Platform proven:** darwin/arm64 (dev
OS/arch only; cross-compile deferred, spec §15).

Settles the open questions the spec §14 amendment (2026-07-23) parked on this PoC.

## Outcome: it works, as a single self-contained file

A `librarian` binary built with **Node SEA** runs on a machine with **no Node on
`PATH`**, from an isolated directory with no `node_modules`, and loads **both**
native deps with no `ERR_DLOPEN_FAILED`:

```
$ env -i PATH=/usr/bin:/bin HOME=/tmp/h /tmp/isolated/librarian doctor
Native stack: ok
Embedding: unconfigured
Index: recall index is missing at ...; run librarian drain to rebuild it
Coverage: 0/0
Indexed through: (none)
```

`Native stack: ok` means an in-memory `better-sqlite3` DB opened, `sqlite-vec`
loaded, and a `vec0` virtual table round-tripped a KNN query (`doctor`'s new
native probe, `probeNativeStack`). The single artifact is ~123 MB.

## The four settled questions

### 1. Compiler: Node SEA (Bun not needed)

Node SEA carried the native deps without a fight. `bun build --compile` was the
documented fallback if SEA proved too painful — it wasn't, so the fallback stays
unused. (Bun-as-*runtime* remains rejected; this was only ever a build-time
compiler question.)

### 2. Single-file vs sidecar: **single file** (embed-as-asset + extract-on-first-run)

The two native artifacts ship **embedded as SEA assets**, not as sidecars:

```jsonc
// sea-config.json
"assets": {
  "better_sqlite3.node": "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "vec0.dylib":          "node_modules/sqlite-vec-darwin-arm64/vec0.dylib"
}
```

At runtime the binary extracts each asset **once** to a per-binary cache dir
(`$TMPDIR/librarian-native-<size>-<mtime>/`) and loads it from there. The OS
loader needs a real file path — it cannot map a `.node`/`.dylib` out of the
in-memory blob — but extraction is invisible and idempotent. Sidecars would have
worked too, but they forfeit the single-file property below.

### 3. ESM→CJS: esbuild-bundle a dedicated CJS entry

SEA takes one CommonJS entry; the code is ESM (`"type": "module"`). `esbuild
--bundle --format=cjs` collapses `dist/` (and better-sqlite3 / sqlite-vec JS)
into one file. One gotcha: `import.meta.main` (the CLI's auto-run guard) evaluates
to `undefined` in a CJS bundle, so `main()` never fires. Fix: a dedicated
`src/sea-entry.ts` that imports and calls `main()` directly — the bundle enters
through it; the `import.meta.main` guard stays for the dev/`node dist/cli.js` path.

### 4. Native-load approach

- **better-sqlite3** — pass the *preloaded addon object* as
  `new Database(file, { nativeBinding })` (WiseLibs/better-sqlite3#972). The
  string-path form of `nativeBinding` routes through SEA's restricted `require`,
  which only resolves builtins; the object form sidesteps it entirely. We load
  the addon with `createRequire(process.execPath)(<extracted .node>)`.
- **sqlite-vec** — call `db.loadExtension(<extracted vec0.dylib>)` directly.
  sqlite-vec's own `getLoadablePath()` uses `import.meta.resolve` of its platform
  package, which can't see inside the blob; we bypass it.
- **SEA detection** — `require('node:sea').isSea()`. Off the SEA path everything
  no-ops and both deps resolve the normal way, so dev/tests/`npm i -g` are
  untouched.

**Sharpest gotcha:** anchor `createRequire` on `process.execPath`, **not**
`import.meta.url`. esbuild's CJS shim for `import.meta.url` yields a value
`createRequire` can't resolve inside a SEA blob; the `require('node:sea')` then
throws, `isSea()` silently returns false, and the binary falls back to the
dev-time native resolution — which fails with a misleading "No such built-in
module: .../better_sqlite3.node". `process.execPath` is always valid.

### macOS signing dance (build-time)

Gatekeeper kills a modified-but-still-signed Mach-O, so `scripts/build-sea.sh`:
`codesign --remove-signature` → `postject` (with `--macho-segment-name NODE_SEA`)
→ `codesign --sign -`. Linux/Windows skip this; cross-platform build is deferred.

## Implication for update / uninstall (#UPDATE / #UNINSTALL)

Single self-contained file → **update is an atomic file replace.** No
versioned-dir + symlink/junction swap is required (that was the fallback the spec
flagged *if* sidecars had been unavoidable). Uninstall is deleting the one binary
(plus wiring); `~/.librarian` data is preserved per the §14 policy. The stale
extraction caches in `$TMPDIR` are self-invalidating (keyed by binary size+mtime)
and disposable — an uninstall may sweep them but need not.

## How to reproduce

```bash
npm install            # brings in esbuild + postject (devDeps)
bash scripts/build-sea.sh
env -i PATH=/usr/bin:/bin HOME=/tmp/h build/sea/librarian doctor
```

## Deliberately deferred

- **Cross-compile / other platforms** (spec §15). The `vec0.dylib` asset path is
  hardcoded to `sqlite-vec-darwin-arm64`; a cross-platform build resolves the
  right platform package per target.
- **Cache key** is binary size+mtime — cheap, re-extracts on every rebuild. Hash
  the blob only if a collision ever bites.
- The build script is bash (darwin-focused); a node build script would generalize
  across platforms.
