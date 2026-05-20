#!/usr/bin/env bash
# =============================================================================
#  OrionOmega Update Script
#  Updates the OrionOmega installation to the latest version from origin.
#
#  What this script does (in order):
#    1. Verifies prerequisites: git, node, pnpm
#    2. Locates the install directory (the repo containing this script)
#    3. Checks for a clean working tree (dirty trees block git pull)
#    4. Saves the current commit hash so we can roll back on failure
#    5. Fetches + fast-forward pulls the latest code from origin
#    6. Runs `pnpm install` to sync dependencies
#    7. Runs `pnpm build` to compile all packages
#    8. If any step fails, automatically rolls back to the saved commit
#
#  Usage:
#    chmod +x update.sh      # make executable (already done if cloned from repo)
#    ./update.sh             # normal update
#    ./update.sh --clean     # wipe dist/ first (fixes stale-build issues)
#    ./update.sh --skip-restart  # skip service restart after build
#
#  Environment variables (all optional):
#    ORIONOMEGA_BRANCH   Override the branch to pull (default: current branch)
#    SKIP_HEALTH_CHECK   Set to "1" to skip gateway health check after restart
#
#  Requirements:
#    - git (any recent version)
#    - node >= 22
#    - pnpm >= 9 (install via: npm i -g pnpm)
#
#  Note: Run from any location — the script resolves its own directory.
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Colour

# ── Helpers ───────────────────────────────────────────────────────────────────

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
fail() { printf "  ${RED}✗${NC} %s\n" "$*" >&2; }
info() { printf "  ${DIM}%s${NC}\n" "$*"; }
warn() { printf "  ${YELLOW}⚠${NC} %s\n" "$*"; }
step() { printf "  ${DIM}%s...${NC} " "$*"; }

# ── Parse arguments ───────────────────────────────────────────────────────────

CLEAN_BUILD=false
SKIP_RESTART=false

for arg in "$@"; do
  case "$arg" in
    --clean)         CLEAN_BUILD=true ;;
    --skip-restart)  SKIP_RESTART=true ;;
    --help|-h)
      sed -n '2,/^# =/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      printf "Unknown option: %s\n" "$arg" >&2
      printf "Run with --help for usage.\n" >&2
      exit 1
      ;;
  esac
done

# ── Locate install directory ──────────────────────────────────────────────────
# Resolve the directory containing this script, following symlinks.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"

# Validate it looks like an OrionOmega repo.
if [ ! -f "$INSTALL_DIR/package.json" ] || [ ! -d "$INSTALL_DIR/.git" ]; then
  fail "Cannot find OrionOmega git repository at: $INSTALL_DIR"
  fail "Expected package.json and .git to both exist there."
  exit 1
fi

printf "\n${BOLD}Updating OrionOmega${NC}"
if [ "$CLEAN_BUILD" = true ]; then
  printf " ${DIM}(clean rebuild)${NC}"
fi
printf "\n\n"
info "Install directory: $INSTALL_DIR"
printf "\n"

# ── Prerequisite checks ───────────────────────────────────────────────────────

step "Checking prerequisites"

PREREQ_OK=true

if ! command -v git &>/dev/null; then
  printf "\n"
  fail "git is not installed or not in PATH"
  PREREQ_OK=false
fi

if ! command -v node &>/dev/null; then
  printf "\n"
  fail "node is not installed or not in PATH"
  PREREQ_OK=false
fi

if ! command -v pnpm &>/dev/null; then
  printf "\n"
  fail "pnpm is not installed or not in PATH"
  fail "Install via: npm install -g pnpm"
  PREREQ_OK=false
fi

if [ "$PREREQ_OK" = false ]; then
  exit 1
fi

printf "${GREEN}✓${NC}\n"

# ── Capture current state for rollback ───────────────────────────────────────

step "Reading current commit"

OLD_COMMIT="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
CURRENT_BRANCH="$(git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
PULL_BRANCH="${ORIONOMEGA_BRANCH:-${CURRENT_BRANCH:-main}}"
SHORT_OLD="${OLD_COMMIT:0:7}"

printf "${GREEN}✓${NC} ${DIM}${CURRENT_BRANCH}@${SHORT_OLD}${NC}\n"

# ── Clean working tree check ──────────────────────────────────────────────────

step "Checking working tree"

DIRTY="$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null || true)"
if [ -n "$DIRTY" ]; then
  printf "${RED}✗${NC}\n"
  fail "Working tree is dirty — commit or stash your changes first:"
  git -C "$INSTALL_DIR" status --short | while read -r line; do
    printf "      %s\n" "$line"
  done
  exit 1
fi

printf "${GREEN}✓${NC}\n"

# ── Rollback helper ───────────────────────────────────────────────────────────
# Called on any build failure after git pull has already advanced HEAD.

rollback() {
  local reason="$1"
  printf "\n"
  warn "Build failed: $reason"
  if [ -z "$OLD_COMMIT" ]; then
    fail "Cannot roll back — no previous commit hash was saved."
    return
  fi
  printf "  ${YELLOW}⟳${NC} ${DIM}Rolling back to ${SHORT_OLD}...${NC} "
  if git -C "$INSTALL_DIR" reset --hard "$OLD_COMMIT" 2>/dev/null; then
    printf "${GREEN}✓${NC}\n"
    info "Rolled back. Run 'pnpm install && pnpm build' to restore a working build."
  else
    printf "${RED}✗${NC}\n"
    fail "git reset --hard failed. Manual recovery required:"
    fail "  cd $INSTALL_DIR && git reset --hard $OLD_COMMIT"
  fi
}

# ── Check network / fetch ─────────────────────────────────────────────────────

step "Fetching from origin"

if ! git -C "$INSTALL_DIR" fetch origin 2>/dev/null; then
  printf "${RED}✗${NC}\n"
  fail "Cannot reach git remote 'origin' — check network connectivity."
  exit 1
fi

printf "${GREEN}✓${NC}\n"

# ── Check how many new commits are available ──────────────────────────────────

NEW_COMMIT_COUNT="$(git -C "$INSTALL_DIR" rev-list "HEAD..origin/${PULL_BRANCH}" --count 2>/dev/null || echo "0")"

if [ "$NEW_COMMIT_COUNT" = "0" ] && [ "$CLEAN_BUILD" = false ]; then
  ok "Already up to date at ${SHORT_OLD}."
  printf "\n${GREEN}✓${NC} ${BOLD}Nothing to update.${NC}\n\n"
  exit 0
fi

# ── Pull latest code ──────────────────────────────────────────────────────────

step "Pulling latest changes"

PULL_START="$SECONDS"

if ! git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null; then
  # Fast-forward failed — reset to origin (handles diverged local commits)
  if ! git -C "$INSTALL_DIR" reset --hard "origin/${PULL_BRANCH}" 2>/dev/null; then
    printf "${RED}✗${NC}\n"
    fail "Pull failed. You may have local commits that conflict with origin."
    fail "Resolve manually: cd $INSTALL_DIR && git pull"
    exit 1
  fi
fi

NEW_COMMIT="$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || true)"
PULL_ELAPSED=$(( SECONDS - PULL_START ))

if [ "$NEW_COMMIT_COUNT" = "0" ]; then
  printf "${GREEN}✓${NC} ${DIM}no new commits, continuing with clean rebuild (${PULL_ELAPSED}s)${NC}\n"
else
  printf "${GREEN}✓${NC} ${DIM}${NEW_COMMIT_COUNT} commit(s) → ${NEW_COMMIT} (${PULL_ELAPSED}s)${NC}\n"
  # Show a brief summary of what landed
  git -C "$INSTALL_DIR" log --oneline "${SHORT_OLD}..HEAD" 2>/dev/null | head -8 | while read -r line; do
    printf "      ${DIM}%s${NC}\n" "$line"
  done
fi

# ── Optional: wipe dist/ for a clean rebuild ─────────────────────────────────

if [ "$CLEAN_BUILD" = true ]; then
  step "Cleaning dist/ directories"
  CLEAN_START="$SECONDS"
  # Suppress "no match" errors when dist/ doesn't exist yet (never been built).
  rm -rf "$INSTALL_DIR"/packages/*/dist \
         "$INSTALL_DIR"/packages/*/tsconfig.tsbuildinfo 2>/dev/null || true
  CLEAN_ELAPSED=$(( SECONDS - CLEAN_START ))
  printf "${GREEN}✓${NC} ${DIM}(${CLEAN_ELAPSED}s)${NC}\n"
fi

# ── Install dependencies ──────────────────────────────────────────────────────

step "Installing dependencies"

DEP_START="$SECONDS"

# Try frozen-lockfile first (faster, reproducible). Fall back to a regular
# install if the lockfile is out of sync with package.json (can happen when
# switching between branches).
if ! ( cd "$INSTALL_DIR" && pnpm install --frozen-lockfile 2>&1 ) \
   && ! ( cd "$INSTALL_DIR" && pnpm install 2>&1 ); then
  printf "${RED}✗${NC}\n"
  rollback "pnpm install failed"
  exit 1
fi

DEP_ELAPSED=$(( SECONDS - DEP_START ))
printf "${GREEN}✓${NC} ${DIM}(${DEP_ELAPSED}s)${NC}\n"

# ── Build all packages ────────────────────────────────────────────────────────

step "Building all packages"

BUILD_START="$SECONDS"

if ! ( cd "$INSTALL_DIR" && pnpm build 2>&1 ); then
  printf "${RED}✗${NC}\n"
  rollback "pnpm build failed"
  exit 1
fi

BUILD_ELAPSED=$(( SECONDS - BUILD_START ))
printf "${GREEN}✓${NC} ${DIM}(${BUILD_ELAPSED}s)${NC}\n"

# ── Relink CLI binary ─────────────────────────────────────────────────────────
# Keeps the `orionomega` symlink in ~/.orionomega/bin pointing at the freshly
# built binary. Failure here is non-fatal.

BIN_SCRIPT="$INSTALL_DIR/packages/core/bin/orionomega"
BIN_TARGET="${HOME}/.orionomega/bin/orionomega"

if [ -f "$BIN_SCRIPT" ]; then
  mkdir -p "$(dirname "$BIN_TARGET")"
  ln -sf "$BIN_SCRIPT" "$BIN_TARGET" 2>/dev/null && chmod +x "$BIN_SCRIPT" 2>/dev/null || true
fi

# ── Restart gateway (optional) ────────────────────────────────────────────────

if [ "$SKIP_RESTART" = false ]; then
  PID_FILE="${HOME}/.orionomega/gateway.pid"

  # Stop existing gateway process if one is tracked.
  if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      step "Stopping gateway (PID $OLD_PID)"
      kill -TERM "$OLD_PID" 2>/dev/null || true
      # Wait up to 5s for graceful shutdown.
      for _ in 1 2 3 4 5; do
        sleep 1
        kill -0 "$OLD_PID" 2>/dev/null || break
      done
      # Force-kill if still running.
      kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
      printf "${GREEN}✓${NC}\n"
    fi
  fi

  # Start the freshly built gateway.
  GATEWAY_ENTRY="$INSTALL_DIR/packages/gateway/dist/server.js"
  if [ -f "$GATEWAY_ENTRY" ]; then
    step "Starting gateway"
    nohup node "$GATEWAY_ENTRY" >/dev/null 2>&1 &
    NEW_GW_PID=$!
    echo "$NEW_GW_PID" > "$PID_FILE"
    printf "${GREEN}✓${NC} ${DIM}(PID $NEW_GW_PID)${NC}\n"
  else
    warn "Gateway entry point not found: $GATEWAY_ENTRY"
    warn "Run manually: node $GATEWAY_ENTRY"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

TOTAL_ELAPSED="$SECONDS"
SHORT_NEW="${NEW_COMMIT:-unknown}"

printf "\n${GREEN}✓${NC} ${BOLD}Update complete!${NC} ${DIM}${SHORT_OLD} → ${SHORT_NEW}${NC}\n\n"
