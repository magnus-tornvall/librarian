#!/usr/bin/env bash
#
# opencode-setup.sh — stand up a local OpenCode smoke test for the librarian plugin.
#
# It:
#   1. builds the CLI (`npm run build` → dist/cli.js),
#   2. writes ~/.librarian/config.json with an absolute `bin` pointing at dist/cli.js, so
#      the plugin can locate the CLI without depending on $PATH. OpenCode is a native
#      binary whose plugin child inherits whatever PATH it was launched with (terminal,
#      desktop app, login service, package manager) — which need not contain any dir a
#      bare `librarian` was linked into. A config file read from disk at runtime sidesteps
#      that entirely. The plugin's resolution order is LIBRARIAN_BIN → config `bin` →
#      the built dist/cli.js relative to the plugin → bare `librarian` (see the adapter).
#   3. symlinks this repo's OpenCode adapter (plugin.ts) into the repo-root
#      .opencode/plugins/ so OpenCode auto-loads it per-project, and
#   4. prints the next steps.
#
# This is throw-away smoke-test tooling, not a production installer (packaging is
# deferred — see the design spec). Idempotent: safe to run repeatedly. Undo with
# scripts/opencode-teardown.sh.
set -euo pipefail

# Resolve the repo root from this script's own location, so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

ADAPTER_DIR="${REPO_ROOT}/adapters/opencode"
# OpenCode discovers plugin files placed DIRECTLY in .opencode/plugins/ — it does not
# recurse into subdirectories. So the plugin is symlinked as a single flat file here
# (named librarian.ts). map.ts is deliberately NOT symlinked alongside it: plugin.ts
# imports it via a relative './map.ts' that resolves through the symlink's real location
# (adapters/opencode/), and a flat map.ts would be wrongly loaded as its own plugin.
PLUGIN_DIR="${REPO_ROOT}/.opencode/plugins"
PLUGIN_LINK="${PLUGIN_DIR}/librarian.ts"
# The CLI the plugin will spawn, and the config file that records its absolute path.
CLI_TARGET="${REPO_ROOT}/dist/cli.js"
CONFIG_PATH="${HOME}/.librarian/config.json"

echo "==> librarian OpenCode plugin — setup"
echo "    repo root:    ${REPO_ROOT}"
echo "    plugin link:  ${PLUGIN_LINK}"
echo "    config:       ${CONFIG_PATH}  (bin → ${CLI_TARGET})"

# 1. Build the CLI. dist/cli.js is what the plugin spawns (via the current runtime, so no
#    shebang/PATH `node` lookup is needed).
echo "==> [1/4] building the CLI (npm run build)"
npm run build

if [[ ! -f "${CLI_TARGET}" ]]; then
  echo "ERROR: ${CLI_TARGET} does not exist; did 'npm run build' succeed?" >&2
  exit 1
fi

# 2. Record the absolute CLI path in ~/.librarian/config.json. Merge (set/replace only the
#    `bin` key) so any other config keys are preserved; use node (already a build dep) to
#    do the JSON safely rather than hand-rolling it in bash.
echo "==> [2/4] writing ${CONFIG_PATH} (bin → ${CLI_TARGET})"
mkdir -p "$(dirname "${CONFIG_PATH}")"
CONFIG_PATH="${CONFIG_PATH}" CLI_TARGET="${CLI_TARGET}" node <<'NODE'
const fs = require('node:fs');
const p = process.env.CONFIG_PATH;
const bin = process.env.CLI_TARGET;
let cfg = {};
try {
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object') cfg = parsed;
} catch {
  // absent or unreadable/corrupt — start fresh
}
cfg.bin = bin;
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
NODE

# Prove the recorded CLI actually runs, the same way the plugin will invoke it (current
# runtime + dist/cli.js). A failure here means the build or config is broken — fail loud
# now rather than letting the plugin silently fall back to an ephemeral id.
machine_id="$(node "${CLI_TARGET}" machine-id)"
echo "    cli → ${CLI_TARGET}  (runtime: $(command -v node || echo '???'))"
echo "    machine-id → ${machine_id}"

# 3. Symlink the plugin as a single flat file directly in .opencode/plugins/. OpenCode
#    loads files placed directly in that dir (not nested subdirs), and loads EVERY file
#    there as a plugin — so we link only plugin.ts (as librarian.ts) and NOT map.ts,
#    which plugin.ts pulls in via a relative import resolved through the symlink target.
#    `ln -sfn` is idempotent (replaces an existing symlink; -n avoids descending a dir).
echo "==> [3/4] symlinking the plugin → ${PLUGIN_LINK}"
mkdir -p "${PLUGIN_DIR}"

# Clean up a stale nested install from older setup versions (.opencode/plugins/librarian/),
# which OpenCode never discovered. Best-effort; leave real files alone.
if [[ -d "${PLUGIN_DIR}/librarian" ]]; then
  rm -f "${PLUGIN_DIR}/librarian/plugin.ts" "${PLUGIN_DIR}/librarian/map.ts"
  rmdir "${PLUGIN_DIR}/librarian" 2>/dev/null || true
  echo "    removed stale nested install ${PLUGIN_DIR}/librarian/"
fi

# Create the symlink, refusing to clobber a real (non-symlink) file in the way, and
# verify it resolves — a bad link means OpenCode loads nothing and the smoke test
# silently emits no events.
if [[ -e "${PLUGIN_LINK}" && ! -L "${PLUGIN_LINK}" ]]; then
  echo "ERROR: ${PLUGIN_LINK} exists and is not a symlink; refusing to overwrite it." >&2
  echo "       Remove it by hand and re-run." >&2
  exit 1
fi
ln -sfn "${ADAPTER_DIR}/plugin.ts" "${PLUGIN_LINK}"
if [[ ! -f "${PLUGIN_LINK}" ]]; then
  echo "ERROR: ${PLUGIN_LINK} does not resolve to a file after linking." >&2
  exit 1
fi
echo "    ${PLUGIN_LINK} -> ${ADAPTER_DIR}/plugin.ts"

# 4. Next steps.
echo "==> [4/4] done"
cat <<EOF

Setup complete. The plugin locates the CLI via ${CONFIG_PATH} (bin → dist/cli.js),
so it works regardless of how OpenCode is launched — no PATH setup required.

To smoke-test:

  1. Run OpenCode from this repo:   opencode
  2. Send a prompt and run a tool (e.g. a bash 'git status').
  3. End/delete the session.
  4. Check the collected events:

       ls ~/.librarian/data/events/
       # per-session NDJSON: ~/.librarian/data/events/<session_id>.ndjson

OpenCode auto-loads plugin files placed directly in .opencode/plugins/ at startup
(the librarian.ts symlink above); no config edit is needed. Plugins load only at
startup, so fully quit and relaunch OpenCode after running this.
Tear it all down with:  ./scripts/opencode-teardown.sh
EOF
