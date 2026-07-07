#!/usr/bin/env bash
#
# opencode-setup.sh — stand up a local OpenCode smoke test for the librarian plugin.
#
# It:
#   1. builds the CLI (`npm run build` → dist/cli.js, which carries the shebang so a
#      bare `librarian` invocation execs under node),
#   2. symlinks dist/cli.js to ~/.local/bin/librarian so `librarian` is on PATH (the
#      plugin shells out to `librarian collect` / `librarian machine-id` by bare name).
#      We deliberately do NOT use `npm link`: it installs into the *active* nvm node's
#      per-version global bin dir, which is not on PATH when a different node is active —
#      and OpenCode is a native binary with no nvm node of its own, so its plugin child
#      inherits a PATH that need not contain any nvm bin dir. A ~/.local/bin symlink is
#      node-independent (the shebang still picks whatever node is active) and survives
#      `nvm use`. See docs/research if this ever needs the GUI-launch (minimal-PATH) case.
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
# OpenCode discovers plugin files placed DIRECTLY in .opencode/plugins/ — it does not
# recurse into subdirectories. So the plugin is symlinked as a single flat file here
# (named librarian.ts). map.ts is deliberately NOT symlinked alongside it: plugin.ts
# imports it via a relative './map.ts' that resolves through the symlink's real location
# (adapters/opencode/), and a flat map.ts would be wrongly loaded as its own plugin.
PLUGIN_DIR="${REPO_ROOT}/.opencode/plugins"
PLUGIN_LINK="${PLUGIN_DIR}/librarian.ts"
# Node-independent bin dir for the `librarian` symlink (must be on the PATH that
# OpenCode's plugin child inherits). ~/.local/bin is the conventional per-user choice.
BIN_DIR="${HOME}/.local/bin"
CLI_LINK="${BIN_DIR}/librarian"
CLI_TARGET="${REPO_ROOT}/dist/cli.js"

echo "==> librarian OpenCode plugin — setup"
echo "    repo root:    ${REPO_ROOT}"
echo "    plugin link:  ${PLUGIN_LINK}"
echo "    cli symlink:  ${CLI_LINK}"

# 1. Build the CLI. dist/cli.js is what `librarian` points at; the shebang lets the
#    symlink exec under node when the plugin spawns it by bare name.
echo "==> [1/4] building the CLI (npm run build)"
npm run build

# 2. Put `librarian` on PATH via a node-independent symlink, then prove it actually
#    runs. A bare `librarian machine-id` failing here means the symlink/shebang is broken
#    or ~/.local/bin is not on PATH — fail loud now rather than letting the plugin
#    silently fall back to an ephemeral id (or emit nothing at all).
echo "==> [2/4] linking dist/cli.js → ${CLI_LINK}"
if [[ ! -f "${CLI_TARGET}" ]]; then
  echo "ERROR: ${CLI_TARGET} does not exist; did 'npm run build' succeed?" >&2
  exit 1
fi
mkdir -p "${BIN_DIR}"
# Refuse to clobber a real (non-symlink) file sitting where our link should go.
if [[ -e "${CLI_LINK}" && ! -L "${CLI_LINK}" ]]; then
  echo "ERROR: ${CLI_LINK} exists and is not a symlink; refusing to overwrite it." >&2
  echo "       Remove it by hand and re-run." >&2
  exit 1
fi
ln -sfn "${CLI_TARGET}" "${CLI_LINK}"

# The smoke test must be node-honest: verify the bare name resolves to OUR link (not
# some other `librarian` earlier on PATH, e.g. a stale `npm link` under another node),
# then that it actually runs. `command -v` reflects the real PATH lookup the plugin does.
if ! command -v librarian >/dev/null 2>&1; then
  echo "ERROR: 'librarian' is not on PATH after linking." >&2
  echo "       Ensure ${BIN_DIR} is on your PATH, then re-run." >&2
  exit 1
fi
resolved="$(command -v librarian)"
if [[ "$(cd "$(dirname "${resolved}")" && pwd)/$(basename "${resolved}")" != "${CLI_LINK}" ]]; then
  echo "WARNING: 'librarian' resolves to ${resolved}, not ${CLI_LINK}." >&2
  echo "         Another 'librarian' is earlier on PATH (e.g. a stale 'npm link')." >&2
  echo "         The plugin will use ${resolved}; remove it if that is not intended." >&2
fi
machine_id="$(librarian machine-id)"
echo "    librarian → ${resolved}  (node: $(command -v node || echo '???'))"
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

Setup complete. \`librarian\` is installed at ${CLI_LINK} (symlink → dist/cli.js).

To smoke-test:

  1. Run OpenCode from this repo:   opencode
     (launch from a terminal so ${BIN_DIR} is on the PATH the plugin inherits)
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
