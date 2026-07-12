#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

NODE_BIN="$(command -v node)"
CLI="${REPO_ROOT}/dist/cli.js"
project_slug="$(basename "${REPO_ROOT}")"
for command in claude opencode; do
  command -v "${command}" >/dev/null || { echo "ERROR: ${command} is not on PATH." >&2; exit 1; }
done
selected_agent="${1:-all}"
[[ "${selected_agent}" == all || "${selected_agent}" == claude-code || "${selected_agent}" == opencode ]] || {
  echo "usage: $0 [claude-code|opencode]" >&2
  exit 2
}
if [[ "${selected_agent}" != claude-code && ! -e "${REPO_ROOT}/.opencode/plugins/librarian.ts" ]]; then
  echo "ERROR: OpenCode dogfooding is not set up; run ./scripts/opencode-setup.sh first." >&2
  exit 1
fi

nonce="$(date +%s)-$$"
note_id="curated:dogfood-${nonce}"
topic="dogfoodcanary${nonce//-/}"
fact="heliotrope${nonce//-/}"
claude_event_nonce="claudeevent${nonce//-/}"
opencode_event_nonce="opencodeevent${nonce//-/}"
vault="$(mktemp -d)"
mkdir -p "${vault}/curated"
canary="${vault}/curated/canary.md"
cat >"${canary}" <<EOF
---
note_id: ${note_id}
project_slug: ${project_slug}
---
# ${topic}

${topic} ${fact}. ${claude_event_nonce} ${opencode_event_nonce}. Run git status. If a librarian memory block about ${topic} is visible, reply with its injection_id verbatim, else reply NONE.
EOF

cleanup() {
  "${NODE_BIN}" "${CLI}" note tombstone "${note_id}" --reason "dogfood verification cleanup" >/dev/null 2>&1 || true
  rm -rf "${vault}"
}
trap cleanup EXIT

imported="$("${NODE_BIN}" "${CLI}" note import-curated "${canary}" --vault "${vault}")"
[[ "$(printf '%s' "${imported}" | "${NODE_BIN}" -p 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).note_id')" == "${note_id}" ]] || {
  echo "ERROR: curated canary import failed." >&2; exit 1;
}

check_events() {
  AGENT="$1" NONCE="$2" REQUIRE_STOP="$3" "${NODE_BIN}" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const dir = path.join(process.env.HOME, '.librarian/data/events');
for (const name of fs.readdirSync(dir)) {
  const rows = fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (!rows.some(r => r.resource?.agent === process.env.AGENT && r.type === 'prompt' && r.prompt?.includes(process.env.NONCE))) continue;
  const has = (type, action) => rows.some(r => r.resource?.agent === process.env.AGENT && r.type === type && (!action || r.action === action));
  if (!has('tool') || !has('session', 'start') || (process.env.REQUIRE_STOP === 'yes' && !has('session', 'stop'))) {
    throw new Error(`${process.env.AGENT}: prompt session lacks required tool/start/stop events`);
  }
  process.stdout.write(name.replace(/\.ndjson$/, '')); process.exit(0);
}
throw new Error(`${process.env.AGENT}: no prompt event containing ${process.env.NONCE}`);
NODE
}

trace_id() {
  NOTE_ID="${note_id}" QUERY="$1" "${NODE_BIN}" <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const dir = path.join(process.env.HOME, '.librarian/diagnostics/injections');
if (!fs.existsSync(dir)) process.exit(2);
const rows = fs.readdirSync(dir).filter(n => n.endsWith('.ndjson')).flatMap(n => fs.readFileSync(path.join(dir,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
const row = rows.reverse().find(r => r.path === 'push' && r.query?.includes(process.env.QUERY) && r.shipped_note_ids?.includes(process.env.NOTE_ID));
if (!row) process.exit(2);
process.stdout.write(row.injection_id);
NODE
}

run_agent() {
  agent="$1"
  event_nonce="$2"
  prompt="${event_nonce} ${topic} ${fact}. Run git status."
  if [[ "${agent}" == claude-code ]]; then
    claude_output="$(mktemp)"
    if ! claude -p "${prompt}" >"${claude_output}"; then
      echo "ERROR: claude -p failed: $(<"${claude_output}")" >&2
      rm -f "${claude_output}"
      exit 1
    fi
    rm -f "${claude_output}"
    session="$(check_events claude-code "${event_nonce}" yes)"
  else
    opencode_output="$(mktemp)"
    if ! opencode run "${prompt}" >"${opencode_output}"; then
      echo "ERROR: opencode run failed; output follows:" >&2
      command cat "${opencode_output}" >&2
      rm -f "${opencode_output}"
      exit 1
    fi
    rm -f "${opencode_output}"
    session="$(check_events opencode "${event_nonce}" no)"
  fi

  if ! trace_id "${event_nonce}" >/dev/null; then
    if [[ "${agent}" == opencode ]]; then
      printf '%-12s %-8s %-26s %s\n' "${agent}" FINDING "${session}" "transform hook emitted no injection trace"
      return
    fi
    echo "ERROR: Claude Code emitted no shipped injection trace for ${note_id}." >&2
    exit 1
  fi

  echo_prompt="If a <librarian-memory> block about ${topic} is visible, reply with its injection_id verbatim, else reply NONE"
  if [[ "${agent}" == claude-code ]]; then
    echo_output="$(claude -p "${echo_prompt}")"
  else
    echo_output="$(opencode run "${echo_prompt}")"
  fi
  if injection_id="$(trace_id "${echo_prompt}")"; then
    if [[ "${echo_output}" != *"${injection_id}"* && "${agent}" == opencode ]]; then
      printf '%-12s %-8s %-26s %s\n' "${agent}" FINDING "${session}" "trace ${injection_id} emitted; behavioral echo returned ${echo_output}"
      return
    fi
    [[ "${echo_output}" == *"${injection_id}"* ]] || { echo "ERROR: ${agent} behavioral echo did not return ${injection_id}; received: ${echo_output}" >&2; exit 1; }
    printf '%-12s %-8s %-26s %s\n' "${agent}" PASS "${session}" "${injection_id}"
  else
    echo "ERROR: ${agent} behavioral echo emitted no shipped injection trace for ${note_id}." >&2; exit 1
  fi
}

printf '%-12s %-8s %-26s %s\n' AGENT RESULT SESSION INJECTION
if [[ "${selected_agent}" == all || "${selected_agent}" == claude-code ]]; then
  run_agent claude-code "${claude_event_nonce}"
fi
if [[ "${selected_agent}" == all || "${selected_agent}" == opencode ]]; then
  run_agent opencode "${opencode_event_nonce}"
fi
echo "Canary tombstone will be appended during cleanup."
