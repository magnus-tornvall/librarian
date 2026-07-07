#!/usr/bin/env bash
#
# opencode-teardown.sh — undo scripts/opencode-setup.sh.
#
# It:
#   1. removes the plugin symlinks from .opencode/plugins/librarian/ (and the dir if
#      it is left empty), and
#   2. removes the ~/.local/bin/librarian symlink created by setup (only if it points at
#      this repo's dist/cli.js), and also best-effort `npm unlink -g librarian` to clean
#      up any stale link left by an older setup that used `npm link`.
#
# Idempotent: safe to run even if setup was never run or was already torn down.
# It does NOT delete collected events under ~/.librarian (that is your data).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

PLUGIN_DIR="${REPO_ROOT}/.opencode/plugins"
PLUGIN_LINK="${PLUGIN_DIR}/librarian.ts"
CLI_LINK="${HOME}/.local/bin/librarian"
CLI_TARGET="${REPO_ROOT}/dist/cli.js"

echo "==> librarian OpenCode plugin — teardown"
echo "    repo root:    ${REPO_ROOT}"
echo "    plugin link:  ${PLUGIN_LINK}"
echo "    cli symlink:  ${CLI_LINK}"

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

# 2. Remove the ~/.local/bin/librarian symlink, but only if it is a symlink that points
#    at THIS repo's dist/cli.js — never touch a real file or someone else's install.
echo "==> [2/2] removing the librarian CLI symlink"
if [[ -L "${CLI_LINK}" ]]; then
  # Resolve the link's immediate target and compare against our dist/cli.js.
  link_target="$(readlink "${CLI_LINK}")"
  case "${link_target}" in
    /*) resolved_target="${link_target}" ;;               # absolute
    *)  resolved_target="$(cd "$(dirname "${CLI_LINK}")" && cd "$(dirname "${link_target}")" && pwd)/$(basename "${link_target}")" ;;
  esac
  if [[ "${resolved_target}" == "${CLI_TARGET}" ]]; then
    rm -f "${CLI_LINK}"
    echo "    removed ${CLI_LINK} -> ${CLI_TARGET}"
  else
    echo "    note: ${CLI_LINK} points at ${link_target}, not this repo; leaving it."
  fi
elif [[ -e "${CLI_LINK}" ]]; then
  echo "    note: ${CLI_LINK} exists but is not a symlink; leaving it untouched."
else
  echo "    ${CLI_LINK} not present (nothing to do)"
fi

# Also best-effort clean up a stale global link from an older setup that used `npm link`.
# `npm unlink -g` exits non-zero when nothing is linked; that is a fine end-state.
unlink_out=""
unlink_rc=0
unlink_out="$(npm unlink -g librarian 2>&1)" || unlink_rc=$?
if [[ ${unlink_rc} -eq 0 ]]; then
  echo "    also unlinked a global 'librarian' (stale 'npm link' cleanup)"
fi

if command -v librarian >/dev/null 2>&1; then
  echo "    note: 'librarian' still resolves at $(command -v librarian) (installed by other means)"
fi

echo "==> done. Collected events under ~/.librarian were left untouched."
