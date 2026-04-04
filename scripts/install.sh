#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  OrionOmega Installer — Download Wrapper
#  Downloads and runs the canonical install.sh from the repository.
#  Supports both curl and wget for maximum compatibility.
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
#
#  Or with wget:
#    wget -qO- https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
#
#  With a GitHub token for private repos:
#    GITHUB_TOKEN=ghp_xxx bash -c 'curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
#      https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash'
#
#  All environment variables are forwarded to the main installer. See install.sh
#  for the full list (GITHUB_TOKEN, ANTHROPIC_API_KEY, ORIONOMEGA_DIR, etc.).
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALLER_URL="https://raw.githubusercontent.com/aaronboshart1/orionomega/main/install.sh"

AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: token $GITHUB_TOKEN"
fi

TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT INT TERM

printf "Downloading OrionOmega installer...\n"

# Try curl first, then wget as fallback (M7 fix)
downloaded=false

if command -v curl &>/dev/null; then
  if [ -n "$AUTH_HEADER" ]; then
    curl -fsSL -H "$AUTH_HEADER" "$INSTALLER_URL" -o "$TMPFILE" && downloaded=true
  else
    curl -fsSL "$INSTALLER_URL" -o "$TMPFILE" && downloaded=true
  fi
fi

if [ "$downloaded" = false ] && command -v wget &>/dev/null; then
  if [ -n "$AUTH_HEADER" ]; then
    wget -q --header="$AUTH_HEADER" "$INSTALLER_URL" -O "$TMPFILE" && downloaded=true
  else
    wget -q "$INSTALLER_URL" -O "$TMPFILE" && downloaded=true
  fi
fi

if [ "$downloaded" = false ]; then
  printf "Failed to download installer from %s\n" "$INSTALLER_URL" >&2
  printf "Ensure curl or wget is installed and you have network access.\n" >&2
  exit 1
fi

if [ ! -s "$TMPFILE" ]; then
  printf "Downloaded installer is empty. Check the URL and try again.\n" >&2
  exit 1
fi

# Pass all env vars through and restore tty for interactive prompts.
# Test that /dev/tty is actually openable (it exists but ENXIO in non-TTY SSH
# sessions), then fall back to inherited stdin if it isn't.
if [ -e /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
  bash "$TMPFILE" </dev/tty
else
  bash "$TMPFILE"
fi
