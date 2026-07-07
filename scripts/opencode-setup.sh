#!/usr/bin/env bash
#
# opencode-setup.sh — stand up a local OpenCode smoke test for the librarian plugin.
#
# It:
#   1. builds the CLI (`npm run build` → dist/cli.js, which carries the shebang so a
#      bare `librarian` invocation execs under node),
#   2. `npm link`s the repo so `librarian` is on PATH (the plugin shells out to
#      `librarian collect` / `librarian machine-id` by bare name),
#   3. symlinks this repo's OpenCode adapter (plugin.ts + its map.ts) into the
#      repo-root .opencode/plugins/librarian/ so OpenCode auto-loads it per-project, and
#   4. prints the next steps.
#
# Idempotent: safe to run repeatedly. Undo with scripts/opencode-teardown.sh.
set -euo pipefail

# Resolve the repo root from this script's own location, so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

ADAPTER_DIR="${REPO_ROOT}/adapters/opencode"
PLUGIN_DIR="${REPO_ROOT}/.opencode/plugins/librarian"

echo "==> librarian OpenCode plugin — setup"
echo "    repo root:   ${REPO_ROOT}"
echo "    plugin dir:  ${PLUGIN_DIR}"

# 1. Build the CLI. dist/cli.js is what `librarian` points at; the shebang lets the
#    symlink exec under node when the plugin spawns it by bare name.
echo "==> [1/4] building the CLI (npm run build)"
npm run build

# 2. Put `librarian` on PATH via npm link, then prove it actually runs. A bare
#    `librarian machine-id` failing here means the shebang/link is broken — fail loud
#    now rather than letting the plugin silently fall back to an ephemeral id.
echo "==> [2/4] linking the librarian CLI (npm link)"
npm link
if ! command -v librarian >/dev/null 2>&1; then
  echo "ERROR: 'librarian' is not on PATH after 'npm link'." >&2
  echo "       Ensure your npm global bin dir is on PATH, then re-run." >&2
  exit 1
fi
machine_id="$(librarian machine-id)"
echo "    librarian → $(command -v librarian)"
echo "    machine-id → ${machine_id}"

# 3. Symlink the adapter into the repo-root project plugin dir. Both files must
#    co-locate: plugin.ts imports ./map.ts. `ln -sfn` is idempotent (replaces an
#    existing symlink; -n avoids descending into a dir symlink).
echo "==> [3/4] symlinking the plugin into .opencode/plugins/librarian"
mkdir -p "${PLUGIN_DIR}"

# Create one symlink, refusing to clobber a real (non-symlink) file/dir sitting in the
# way, and verify it resolves to the intended target — a bad link means OpenCode would
# load nothing and the smoke test would silently emit no events.
link_adapter_file() {
  local target="$1" link="$2"
  if [[ -e "${link}" && ! -L "${link}" ]]; then
    echo "ERROR: ${link} exists and is not a symlink; refusing to overwrite it." >&2
    echo "       Remove it by hand and re-run." >&2
    exit 1
  fi
  ln -sfn "${target}" "${link}"
  # Resolve the link and confirm it points at (and reaches) the expected file.
  if [[ ! -f "${link}" ]]; then
    echo "ERROR: ${link} does not resolve to a file after linking (target: ${target})." >&2
    exit 1
  fi
  echo "    ${link} -> ${target}"
}

link_adapter_file "${ADAPTER_DIR}/plugin.ts" "${PLUGIN_DIR}/plugin.ts"
link_adapter_file "${ADAPTER_DIR}/map.ts" "${PLUGIN_DIR}/map.ts"

# 4. Next steps.
echo "==> [4/4] done"
cat <<EOF

Setup complete. To smoke-test:

  1. Run OpenCode from this repo:   opencode
  2. Send a prompt and run a tool (e.g. a bash 'git status').
  3. End/delete the session.
  4. Check the collected events:

       ls ~/.librarian/data/events/
       # per-session NDJSON: ~/.librarian/data/events/<session_id>.ndjson

OpenCode auto-loads .opencode/plugins/** at startup; no config edit is needed.
Tear it all down with:  ./scripts/opencode-teardown.sh
EOF
