#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SETTINGS_DIR="${REPO_ROOT}/.claude"
SETTINGS_PATH="${SETTINGS_DIR}/settings.local.json"
HOOK_PATH="${REPO_ROOT}/adapters/claude-code/hook.ts"
NODE_BIN="$(command -v node || true)"

echo "==> librarian Claude Code hook — teardown"
if [[ ! -f "${SETTINGS_PATH}" ]]; then
  echo "    ${SETTINGS_PATH} not present (nothing to do)"
elif [[ -z "${NODE_BIN}" ]]; then
  echo "ERROR: node is required to verify ownership; leaving ${SETTINGS_PATH} untouched." >&2
  exit 1
else
  expected="$(mktemp)"
  trap 'rm -f "${expected}"' EXIT
  NODE_BIN="${NODE_BIN}" HOOK_PATH="${HOOK_PATH}" "${NODE_BIN}" >"${expected}" <<'NODE'
const hook = { type: 'command', command: process.env.NODE_BIN, args: [process.env.HOOK_PATH], timeout: 10 };
process.stdout.write(JSON.stringify({ hooks: {
  UserPromptSubmit: [{ hooks: [hook] }], PostToolUse: [{ matcher: '*', hooks: [hook] }],
  SessionStart: [{ hooks: [hook] }], Stop: [{ hooks: [hook] }],
} }, null, 2) + '\n');
NODE
  if cmp -s "${expected}" "${SETTINGS_PATH}"; then
    rm "${SETTINGS_PATH}"
    rmdir "${SETTINGS_DIR}" 2>/dev/null || true
    echo "    removed owned settings file"
  else
    echo "ERROR: ${SETTINGS_PATH} no longer matches setup output; leaving it untouched." >&2
    exit 1
  fi
fi
echo "==> done. Collected data under ~/.librarian was left untouched."
