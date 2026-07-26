#!/usr/bin/env sh
# librarian installer — places the single-executable at ~/.librarian/bin/librarian
# and puts that dir on PATH. User-writable by design (spec §14 amendment): no sudo,
# no elevation, and it sets up sudo-free self-update later.
#
#   curl -fsSL <url>/install.sh | sh
#
# Single-platform now (this OS/arch); Windows .ps1 and cross-platform are deferred
# (spec §15). Idempotent: re-running upgrades the binary in place and never
# duplicates the PATH line.
#
# Source of the binary, in order:
#   1. LIBRARIAN_BINARY=/path/to/librarian   — a locally built binary (dev/CI verify)
#   2. LIBRARIAN_URL=<url>                    — download from this URL
#   3. (no release feed exists yet — set one of the above)
set -eu

BIN_DIR="${LIBRARIAN_BIN_DIR:-$HOME/.librarian/bin}"
TARGET="$BIN_DIR/librarian"

mkdir -p "$BIN_DIR"

tmp="$(mktemp "${TMPDIR:-/tmp}/librarian.XXXXXX")"
trap 'rm -f "$tmp"' EXIT INT TERM

if [ -n "${LIBRARIAN_BINARY:-}" ]; then
  cp "$LIBRARIAN_BINARY" "$tmp"
elif [ -n "${LIBRARIAN_URL:-}" ]; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$LIBRARIAN_URL" -o "$tmp"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$LIBRARIAN_URL"
  else
    echo "librarian: need curl or wget to download the binary" >&2
    exit 1
  fi
else
  echo "librarian: no binary source. Set LIBRARIAN_BINARY (local build) or LIBRARIAN_URL (download)." >&2
  exit 1
fi

chmod +x "$tmp"
# Atomic swap so a re-run (self-update) never leaves a half-written binary.
mv "$tmp" "$TARGET"
trap - EXIT INT TERM

echo "librarian: installed $TARGET"

# --- PATH wiring -------------------------------------------------------------
# If BIN_DIR is already on PATH, nothing to do. Otherwise append one line to the
# user's shell profile, guarded by a marker so re-running never duplicates it.
case ":$PATH:" in
  *":$BIN_DIR:"*)
    exit 0
    ;;
esac

MARKER="# added by librarian installer"
LINE="export PATH=\"$BIN_DIR:\$PATH\" $MARKER"

# Pick the profile for the user's login shell.
case "${SHELL:-}" in
  */zsh) PROFILE="$HOME/.zshrc" ;;
  */bash)
    if [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc"; else PROFILE="$HOME/.bash_profile"; fi
    ;;
  *) PROFILE="$HOME/.profile" ;;
esac

if [ -f "$PROFILE" ] && grep -qF "$MARKER" "$PROFILE"; then
  : # already wired — idempotent
else
  printf '\n%s\n' "$LINE" >> "$PROFILE"
  echo "librarian: added $BIN_DIR to PATH in $PROFILE"
fi

echo "librarian: open a new shell, or run:  export PATH=\"$BIN_DIR:\$PATH\""
