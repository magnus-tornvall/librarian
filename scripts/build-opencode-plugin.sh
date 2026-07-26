#!/usr/bin/env bash
# Bundle the OpenCode adapter into a single self-contained plugin file.
#
# OpenCode loads plugin files placed *directly* in a plugins dir (it does not
# recurse into subdirs, and it loads every flat file there as its own plugin).
# The adapter is three source files (plugin.ts imports map.ts + inject.ts) plus a
# node_modules dep (ulid) — none of which survive a bare file copy into the user's
# global ~/.config/opencode/plugins/. So we esbuild-bundle the whole thing into ONE
# ESM file with zero external imports: copy that single file and it just works, no
# package.json, no `bun install`, no sibling files masquerading as plugins.
#
# Output: dist/opencode-plugin.js — embedded into the SEA binary (build-sea.sh) and
# read at install time by src/opencode-install.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=dist/opencode-plugin.js
mkdir -p dist

# --platform=node keeps node: builtins external (OpenCode runs on Bun/Node, both
# provide them); everything else (map.ts, inject.ts, ulid) is inlined.
node_modules/.bin/esbuild adapters/opencode/plugin.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile="$OUT"

echo "built $OUT"
