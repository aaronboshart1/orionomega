#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/aaronboshart1/orionomega.git"
INSTALL_DIR="${ORIONOMEGA_DIR:-$HOME/.orionomega/src}"
MIN_NODE=22

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn()    { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
fail()    { printf "${RED}✗${NC} %s\n" "$1"; exit 1; }
step()    { printf "\n${BOLD}%s${NC}\n" "$1"; }

cat <<'BANNER'

  ╔══════════════════════════════════════╗
  ║     OrionOmega — Installer           ║
  ╚══════════════════════════════════════╝

BANNER

# ── 1. Check Node.js ─────────────────────────────────────────────

step "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  fail "Node.js is not installed. Install Node.js $MIN_NODE+ first:
    macOS:   brew install node
    Linux:   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
    Or:      https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt "$MIN_NODE" ]; then
  fail "Node.js $MIN_NODE+ required (found v$(node -v | sed 's/v//')). Please upgrade."
fi
info "Node.js $(node -v)"

# ── 2. Install pnpm ─────────────────────────────────────────────

if ! command -v pnpm &>/dev/null; then
  step "Installing pnpm..."
  npm install -g pnpm
  info "pnpm installed"
else
  info "pnpm $(pnpm -v)"
fi

# ── 3. Clone or update repo ─────────────────────────────────────

step "Getting OrionOmega source..."

if [ -d "$INSTALL_DIR/.git" ]; then
  warn "Existing installation found at $INSTALL_DIR"
  printf "  Pulling latest changes... "
  cd "$INSTALL_DIR"
  git pull --ff-only origin main 2>/dev/null || git pull origin main
  printf "done\n"
else
  printf "  Cloning into %s... " "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO" "$INSTALL_DIR"
  printf "done\n"
  cd "$INSTALL_DIR"
fi

info "Source ready at $INSTALL_DIR"

# ── 4. Install dependencies ─────────────────────────────────────

step "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
info "Dependencies installed"

# ── 5. Approve and install native builds ─────────────────────────

if pnpm approve-builds --help &>/dev/null 2>&1; then
  pnpm approve-builds 2>/dev/null || true
fi

# ── 6. Build ─────────────────────────────────────────────────────

step "Building OrionOmega..."
pnpm build
info "Build complete"

# ── 7. Link CLI globally ─────────────────────────────────────────

step "Linking orionomega command..."

SHELL_RC=""
if [ -n "${ZSH_VERSION:-}" ] || [ "$SHELL" = "/bin/zsh" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -n "${BASH_VERSION:-}" ] || [ "$SHELL" = "/bin/bash" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

BIN_DIR="$HOME/.orionomega/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/orionomega" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/packages/core/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/orionomega"

if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  if [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ]; then
    if ! grep -q 'orionomega/bin' "$SHELL_RC" 2>/dev/null; then
      printf '\n# OrionOmega\nexport PATH="$HOME/.orionomega/bin:$PATH"\n' >> "$SHELL_RC"
      info "Added $BIN_DIR to PATH in $SHELL_RC"
    fi
  fi
  export PATH="$BIN_DIR:$PATH"
fi

info "orionomega command linked"

# ── 8. Verify ────────────────────────────────────────────────────

step "Verifying installation..."

if command -v orionomega &>/dev/null || [ -x "$BIN_DIR/orionomega" ]; then
  info "Installation successful!"
else
  warn "orionomega is installed but may not be in PATH yet."
  warn "Run: export PATH=\"\$HOME/.orionomega/bin:\$PATH\""
fi

# ── Done ──────────────────────────────────────────────────────────

cat <<EOF

${BOLD}Installation complete!${NC}

  ${BOLD}Next steps:${NC}
  1. ${GREEN}orionomega setup${NC}     — run the setup wizard
  2. ${GREEN}orionomega tui${NC}       — launch the terminal UI

  If "orionomega" is not found, open a new terminal or run:
    source ${SHELL_RC:-~/.bashrc}

EOF
