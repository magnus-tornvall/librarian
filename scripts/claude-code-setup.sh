#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

SETTINGS_DIR="${REPO_ROOT}/.claude"
SETTINGS_PATH="${SETTINGS_DIR}/settings.local.json"
HOOK_PATH="${REPO_ROOT}/adapters/claude-code/hook.ts"

echo "==> librarian Claude Code hook — setup"
echo "==> [1/4] building the CLI (npm run build)"
npm run build

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "ERROR: could not locate node on PATH." >&2
  exit 1
fi

expected="$(mktemp)"
trap 'rm -f "${expected}"' EXIT
NODE_BIN="${NODE_BIN}" HOOK_PATH="${HOOK_PATH}" "${NODE_BIN}" >"${expected}" <<'NODE'
const hook = { type: 'command', command: process.env.NODE_BIN, args: [process.env.HOOK_PATH], timeout: 10 };
const settings = { hooks: {
  UserPromptSubmit: [{ hooks: [hook] }],
  PostToolUse: [{ matcher: '*', hooks: [hook] }],
  SessionStart: [{ hooks: [hook] }],
  Stop: [{ hooks: [hook] }],
} };
process.stdout.write(JSON.stringify(settings, null, 2) + '\n');
NODE

echo "==> [2/4] writing ${SETTINGS_PATH}"
if [[ -f "${SETTINGS_PATH}" ]] && ! cmp -s "${expected}" "${SETTINGS_PATH}"; then
  echo "ERROR: ${SETTINGS_PATH} exists and is not the file this setup generates." >&2
  echo "       Merge the four hooks manually or move the file, then re-run." >&2
  exit 1
fi
mkdir -p "${SETTINGS_DIR}"
cp "${expected}" "${SETTINGS_PATH}"

echo "==> [3/4] smoke-checking SessionStart collection"
session_id="librarian-claude-setup-$(date +%s)-$$"
event_file="${HOME}/.librarian/data/events/${session_id}.ndjson"
printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart","source":"startup"}\n' \
  "${session_id}" "${REPO_ROOT}" | "${NODE_BIN}" "${HOOK_PATH}" >/dev/null
SESSION_ID="${session_id}" EVENT_FILE="${event_file}" "${NODE_BIN}" <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync(process.env.EVENT_FILE, 'utf8').trim().split('\n').map(JSON.parse);
if (!rows.some(r => r.type === 'session' && r.action === 'start' && r.resource?.agent === 'claude-code' && r.context?.session_id === process.env.SESSION_ID)) {
  throw new Error('smoke event was not collected');
}
NODE

echo "==> [4/4] done"
echo "    Four project-local hooks are installed in ${SETTINGS_PATH}."
echo "    Fully restart any running Claude Code session, then run ./scripts/dogfood-verify.sh."
echo "    Tear down with ./scripts/claude-code-teardown.sh (collected data is preserved)."
