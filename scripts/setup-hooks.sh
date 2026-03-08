#!/usr/bin/env bash
# Installs git hooks for this repository.
# Run once after cloning: bash scripts/setup-hooks.sh
#
# Hooks installed:
#   pre-commit — scans staged files for accidentally committed secrets

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/scripts/hooks"
GIT_HOOKS="$REPO_ROOT/.git/hooks"

echo "Installing git hooks..."

if [[ ! -d "$GIT_HOOKS" ]]; then
  echo "Error: .git/hooks directory not found. Are you in the repo root?"
  exit 1
fi

# Copy each hook from scripts/hooks/ into .git/hooks/
for hook in "$HOOKS_SRC"/*; do
  name="$(basename "$hook")"
  dest="$GIT_HOOKS/$name"
  cp "$hook" "$dest"
  chmod +x "$dest"
  echo "  ✓ Installed $name"
done

echo ""
echo "Done. Hooks are active for this clone."
echo ""
echo "Optional: install detect-secrets for enhanced scanning:"
echo "  pip install detect-secrets"
echo "  detect-secrets scan > .secrets.baseline"
