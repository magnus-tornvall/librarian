#!/usr/bin/env bash
#
# opencode-teardown.sh — undo scripts/opencode-setup.sh.
#
# It:
#   1. removes the plugin symlinks from .opencode/plugins/librarian/ (and the dir if
#      it is left empty), and
#   2. unlinks the global `librarian` created by `npm link`.
#
# Idempotent: safe to run even if setup was never run or was already torn down.
# It does NOT delete collected events under ~/.librarian (that is your data).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

PLUGIN_DIR="${REPO_ROOT}/.opencode/plugins/librarian"

echo "==> librarian OpenCode plugin — teardown"
echo "    repo root:   ${REPO_ROOT}"
echo "    plugin dir:  ${PLUGIN_DIR}"

# 1. Remove the plugin symlinks. rm -f is a no-op if they are already gone.
echo "==> [1/2] removing plugin symlinks"
rm -f "${PLUGIN_DIR}/plugin.ts" "${PLUGIN_DIR}/map.ts"
# Prune the now-empty librarian dir (and empty parents up to .opencode), best-effort.
rmdir "${PLUGIN_DIR}" 2>/dev/null || true
rmdir "${REPO_ROOT}/.opencode/plugins" 2>/dev/null || true
rmdir "${REPO_ROOT}/.opencode" 2>/dev/null || true
echo "    removed (if present): ${PLUGIN_DIR}/{plugin.ts,map.ts}"

# 2. Unlink the global `librarian`. `npm unlink -g` can exit non-zero when nothing is
#    linked; that is a fine end-state, so don't let it abort the script. Capture output
#    so a genuine npm error is still surfaced rather than silently swallowed.
echo "==> [2/2] unlinking the librarian CLI (npm unlink -g librarian)"
unlink_out=""
unlink_rc=0
unlink_out="$(npm unlink -g librarian 2>&1)" || unlink_rc=$?
if [[ ${unlink_rc} -eq 0 ]]; then
  echo "    global 'librarian' unlinked"
elif ! command -v librarian >/dev/null 2>&1; then
  # Non-zero, but librarian is not on PATH anyway → nothing was linked. Fine.
  echo "    global 'librarian' was not linked (nothing to do)"
else
  # Non-zero AND librarian still resolves → a real failure worth showing.
  echo "    warning: 'npm unlink -g librarian' failed:" >&2
  echo "${unlink_out}" >&2
fi

if command -v librarian >/dev/null 2>&1; then
  echo "    note: 'librarian' still resolves at $(command -v librarian) (installed by other means)"
fi

echo "==> done. Collected events under ~/.librarian were left untouched."
