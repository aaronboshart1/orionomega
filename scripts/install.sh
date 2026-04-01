#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  OrionOmega Installer — Download Wrapper
#  Downloads and runs the canonical install.sh from the repository.
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
#
#  Or with a GitHub token for private repos:
#    GITHUB_TOKEN=ghp_xxx curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
#      https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# When piped (curl | bash), stdin is the pipe. Reclaim the real terminal.
if [ ! -t 0 ] && [ -e /dev/tty ]; then
  exec </dev/tty
fi

INSTALLER_URL="https://raw.githubusercontent.com/aaronboshart1/orionomega/main/install.sh"

AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: token $GITHUB_TOKEN"
fi

TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

printf "Downloading OrionOmega installer...\n"

if [ -n "$AUTH_HEADER" ]; then
  curl -fsSL -H "$AUTH_HEADER" "$INSTALLER_URL" -o "$TMPFILE" || {
    printf "Failed to download installer from %s\n" "$INSTALLER_URL" >&2
    exit 1
  }
else
  curl -fsSL "$INSTALLER_URL" -o "$TMPFILE" || {
    printf "Failed to download installer from %s\n" "$INSTALLER_URL" >&2
    exit 1
  }
fi

if [ ! -s "$TMPFILE" ]; then
  printf "Downloaded installer is empty. Check the URL and try again.\n" >&2
  exit 1
fi

GITHUB_TOKEN="${GITHUB_TOKEN:-}" bash "$TMPFILE"
