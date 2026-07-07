#!/usr/bin/env bash
#
# opencode-teardown.sh — undo scripts/opencode-setup.sh.
#
# It:
#   1. removes the plugin symlink from .opencode/plugins/ (and the dir if left empty), and
#   2. removes the `bin` key from ~/.librarian/config.json (deleting the file only if it
#      becomes empty), so nothing points at this repo's dist/cli.js afterward.
#
# Throw-away smoke-test tooling; cleanup is best-effort. Idempotent: safe to run even if
# setup was never run or was already torn down. It does NOT delete collected events under
# ~/.librarian (that is your data).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

PLUGIN_DIR="${REPO_ROOT}/.opencode/plugins"
PLUGIN_LINK="${PLUGIN_DIR}/librarian.ts"
CLI_TARGET="${REPO_ROOT}/dist/cli.js"
CONFIG_PATH="${HOME}/.librarian/config.json"

echo "==> librarian OpenCode plugin — teardown"
echo "    repo root:    ${REPO_ROOT}"
echo "    plugin link:  ${PLUGIN_LINK}"
echo "    config:       ${CONFIG_PATH}"

# 1. Remove the flat plugin symlink, plus any stale nested install from older setups.
echo "==> [1/2] removing plugin symlink(s)"
rm -f "${PLUGIN_LINK}"
# Older setup versions used a nested .opencode/plugins/librarian/ dir; clean it too.
rm -f "${PLUGIN_DIR}/librarian/plugin.ts" "${PLUGIN_DIR}/librarian/map.ts"
rmdir "${PLUGIN_DIR}/librarian" 2>/dev/null || true
# Prune now-empty parents (best-effort).
rmdir "${PLUGIN_DIR}" 2>/dev/null || true
rmdir "${REPO_ROOT}/.opencode" 2>/dev/null || true
echo "    removed (if present): ${PLUGIN_LINK} and stale ${PLUGIN_DIR}/librarian/"

# 2. Drop the `bin` key from ~/.librarian/config.json — but only if it points at THIS
#    repo's dist/cli.js (never disturb an install by other means). Delete the file only
#    if removing `bin` leaves it empty. Best-effort; leaves all other keys and all
#    ~/.librarian data untouched. Uses node (a build dep) for safe JSON handling.
echo "==> [2/2] cleaning up ${CONFIG_PATH} (bin)"
if [[ -f "${CONFIG_PATH}" ]]; then
  CONFIG_PATH="${CONFIG_PATH}" CLI_TARGET="${CLI_TARGET}" node <<'NODE'
const fs = require('node:fs');
const p = process.env.CONFIG_PATH;
const ours = process.env.CLI_TARGET;
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
} catch {
  process.stdout.write('    config unreadable/corrupt; leaving it untouched\n');
  process.exit(0);
}
if (!cfg || typeof cfg !== 'object') process.exit(0);
if (cfg.bin !== ours) {
  process.stdout.write(`    config bin is ${JSON.stringify(cfg.bin)}, not this repo; leaving it.\n`);
  process.exit(0);
}
delete cfg.bin;
if (Object.keys(cfg).length === 0) {
  fs.rmSync(p);
  process.stdout.write('    removed now-empty config file\n');
} else {
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  process.stdout.write('    removed bin key (other config keys preserved)\n');
}
NODE
else
  echo "    ${CONFIG_PATH} not present (nothing to do)"
fi

echo "==> done. Collected events under ~/.librarian were left untouched."
