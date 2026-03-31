#!/bin/bash
set -e

if [ -d "$HOME/.orionomega/bin" ]; then
  export PATH="$HOME/.orionomega/bin:$PATH"
fi

if ! command -v pnpm &>/dev/null; then
  printf "post-merge: ERROR: pnpm not found on PATH. Cannot install dependencies or build.\n" >&2
  printf "post-merge: Install pnpm and run 'pnpm install && pnpm build' manually.\n" >&2
  exit 1
fi

if ! pnpm install --frozen-lockfile 2>/dev/null; then
  printf "post-merge: Frozen lockfile install failed, falling back to regular install.\n" >&2
  pnpm install || {
    printf "post-merge: Dependency installation failed.\n" >&2
    exit 1
  }
fi

rm -rf packages/web/.next
pnpm build || {
  printf "post-merge: Build failed. Run 'pnpm build' manually to see errors.\n" >&2
  exit 1
}
