#!/usr/bin/env bash
# Build the librarian single-executable PoC (#149). Single-platform (this OS/arch);
# cross-compile is deferred (spec §15). macOS-only signing dance below.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=build/sea
FUSE=NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

rm -rf "$OUT"
mkdir -p "$OUT"

# 1. Typecheck (the real gate) then bundle the ESM CLI → one CJS file. SEA takes a
#    single CommonJS entry; sea-entry.ts calls main() directly (import.meta.main
#    doesn't survive the CJS bundle).
npm run build
node_modules/.bin/esbuild src/sea-entry.ts \
  --bundle --platform=node --format=cjs --target=node24 \
  --outfile="$OUT/librarian.cjs"

# 2. SEA blob from the bundle + the two native artifacts embedded as assets.
node --experimental-sea-config sea-config.json

# 3. Copy the running node as the binary base.
NODE_BIN="$(node -e 'process.stdout.write(process.execPath)')"
cp "$NODE_BIN" "$OUT/librarian"

# 4. macOS: strip the signature before injecting, inject the blob, re-sign ad-hoc
#    (Gatekeeper kills a modified-but-still-signed Mach-O).
if [[ "$OSTYPE" == darwin* ]]; then
  codesign --remove-signature "$OUT/librarian"
fi
node_modules/.bin/postject "$OUT/librarian" NODE_SEA_BLOB "$OUT/sea-prep.blob" \
  --sentinel-fuse "$FUSE" \
  $([[ "$OSTYPE" == darwin* ]] && echo "--macho-segment-name NODE_SEA")
if [[ "$OSTYPE" == darwin* ]]; then
  codesign --sign - "$OUT/librarian"
fi

chmod +x "$OUT/librarian"
echo "built $OUT/librarian"
