#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  OrionOmega — One-Liner Install Script
#  Usage: curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

INSTALL_DIR="/opt/orionomega"
CONFIG_DIR="$HOME/.orionomega"
REPO_URL="https://github.com/aaronboshart1/orionomega.git"
HINDSIGHT_REPO="https://github.com/aaronboshart1/hindsight.git"
HINDSIGHT_DIR="/opt/hindsight"

# ── Helpers ──────────────────────────────────────────────────

info()    { echo -e "  ${BLUE}ℹ${RESET} $1"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()    { echo -e "  ${RED}✗${RESET} $1"; }
step()    { echo -e "\n${BOLD}${BLUE}▸ $1${RESET}\n"; }
die()     { fail "$1"; exit 1; }

# ── Header ───────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║                                            ║${RESET}"
echo -e "${BOLD}║        ${BLUE}OrionOmega${RESET}${BOLD} — Installer              ║${RESET}"
echo -e "${BOLD}║        AI Agent Orchestration System       ║${RESET}"
echo -e "${BOLD}║                                            ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════════╝${RESET}"
echo ""

# ── Preflight Checks ────────────────────────────────────────

step "Preflight Checks"

# Linux only
if [[ "$(uname -s)" != "Linux" ]]; then
    die "OrionOmega requires Linux. Detected: $(uname -s)"
fi
ok "Linux detected"

# Root or sudo
if [[ "$EUID" -ne 0 ]]; then
    if ! command -v sudo &>/dev/null; then
        die "This script must be run as root or with sudo available"
    fi
    SUDO="sudo"
    warn "Not running as root — using sudo"
else
    SUDO=""
fi
ok "Permissions OK"

# Architecture
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|aarch64|arm64) ok "Architecture: $ARCH" ;;
    *) die "Unsupported architecture: $ARCH" ;;
esac

# Git
if ! command -v git &>/dev/null; then
    info "Installing git..."
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git || \
    $SUDO yum install -y -q git || \
    die "Could not install git. Please install it manually."
fi
ok "git $(git --version | awk '{print $3}')"

# ── Node.js ≥ 22 ────────────────────────────────────────────

step "Node.js"

install_node() {
    info "Installing Node.js 22 via NodeSource..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - 2>/dev/null
        $SUDO apt-get install -y -qq nodejs
    elif command -v yum &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO -E bash - 2>/dev/null
        $SUDO yum install -y -q nodejs
    else
        die "Cannot auto-install Node.js. Please install Node.js >= 22 manually."
    fi
}

if command -v node &>/dev/null; then
    NODE_VER="$(node -v | sed 's/v//')"
    NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
    if [[ "$NODE_MAJOR" -ge 22 ]]; then
        ok "Node.js v${NODE_VER}"
    else
        warn "Node.js v${NODE_VER} found — need >= 22"
        install_node
        ok "Node.js $(node -v)"
    fi
else
    warn "Node.js not found"
    install_node
    ok "Node.js $(node -v)"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
    info "Installing pnpm..."
    npm install -g pnpm@latest 2>/dev/null || corepack enable pnpm 2>/dev/null || die "Could not install pnpm"
fi
ok "pnpm $(pnpm --version)"

# ── Clone / Update Repository ───────────────────────────────

step "OrionOmega Repository"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing installation found — pulling latest..."
    cd "$INSTALL_DIR"
    git pull --ff-only || warn "git pull failed — continuing with existing code"
    ok "Repository updated"
else
    if [[ -d "$INSTALL_DIR" ]]; then
        warn "Directory $INSTALL_DIR exists but is not a git repo — backing up"
        $SUDO mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
    fi
    info "Cloning OrionOmega..."
    $SUDO git clone "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone repository"
    ok "Cloned to $INSTALL_DIR"
fi

# Fix ownership if we used sudo to clone
if [[ -n "${SUDO:-}" ]]; then
    $SUDO chown -R "$(whoami):$(id -gn)" "$INSTALL_DIR"
fi

# ── Build ────────────────────────────────────────────────────

step "Building OrionOmega"

cd "$INSTALL_DIR"

info "Installing dependencies..."
pnpm install 2>&1 | tail -3
ok "Dependencies installed"

info "Building all packages..."
pnpm build 2>&1 | tail -5
ok "Build complete"

# ── Global CLI Link ──────────────────────────────────────────

step "CLI Setup"

cd "$INSTALL_DIR/packages/core"
$SUDO npm link 2>/dev/null || warn "npm link failed — you may need to add the bin to PATH manually"

if command -v orionomega &>/dev/null; then
    ok "orionomega command available globally"
else
    # Try adding to PATH
    LINK_PATH="$(npm root -g)/../bin"
    if [[ -f "$LINK_PATH/orionomega" ]]; then
        warn "orionomega installed but not in PATH. Add to your shell profile:"
        echo -e "    ${DIM}export PATH=\"$LINK_PATH:\$PATH\"${RESET}"
    else
        warn "Global link may not have worked. Try: cd $INSTALL_DIR/packages/core && npm link"
    fi
fi

# ── Hindsight ────────────────────────────────────────────────

step "Hindsight (Memory System)"

if curl -sf http://localhost:8888/v1/health &>/dev/null; then
    ok "Hindsight already running on localhost:8888"
elif [[ -d "$HINDSIGHT_DIR/.git" ]]; then
    ok "Hindsight installed at $HINDSIGHT_DIR (not currently running)"
    info "Start it with: cd $HINDSIGHT_DIR && cargo run --release"
else
    read -rp "  Install Hindsight? (Y/n) " INSTALL_HS
    INSTALL_HS="${INSTALL_HS:-Y}"
    if [[ "$INSTALL_HS" =~ ^[Yy] ]]; then
        # Check for Rust
        if ! command -v cargo &>/dev/null; then
            info "Installing Rust toolchain..."
            curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y 2>/dev/null
            source "$HOME/.cargo/env" 2>/dev/null || true
        fi

        info "Cloning Hindsight..."
        $SUDO git clone "$HINDSIGHT_REPO" "$HINDSIGHT_DIR" 2>/dev/null || die "Failed to clone Hindsight"
        if [[ -n "${SUDO:-}" ]]; then
            $SUDO chown -R "$(whoami):$(id -gn)" "$HINDSIGHT_DIR"
        fi

        info "Building Hindsight (this may take a few minutes)..."
        cd "$HINDSIGHT_DIR"
        cargo build --release 2>&1 | tail -3
        ok "Hindsight built"

        # Create systemd service
        if command -v systemctl &>/dev/null; then
            $SUDO tee /etc/systemd/system/hindsight.service >/dev/null <<EOF
[Unit]
Description=Hindsight Memory Server
After=network.target

[Service]
Type=simple
ExecStart=$HINDSIGHT_DIR/target/release/hindsight
WorkingDirectory=$HINDSIGHT_DIR
Restart=on-failure
RestartSec=5
Environment=HINDSIGHT_PORT=8888

[Install]
WantedBy=multi-user.target
EOF
            $SUDO systemctl daemon-reload
            $SUDO systemctl enable hindsight
            $SUDO systemctl start hindsight
            ok "Hindsight systemd service installed and started"
        else
            warn "No systemd — start Hindsight manually: cd $HINDSIGHT_DIR && ./target/release/hindsight"
        fi
    else
        info "Skipping Hindsight — you can install it later"
    fi
fi

# ── Config Directory ─────────────────────────────────────────

step "Configuration"

mkdir -p "$CONFIG_DIR"/{workspace,logs,skills}

if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
    # Generate default config via the CLI
    if command -v orionomega &>/dev/null; then
        cd "$INSTALL_DIR"
        node packages/core/dist/cli.js config set models.apiKey "" 2>/dev/null || true
    fi

    # Fallback: write minimal config
    if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
        cat > "$CONFIG_DIR/config.yaml" <<'YAML'
# OrionOmega Configuration
# Run 'orionomega setup' for interactive configuration.

gateway:
  port: 7800
  bind: '127.0.0.1'
  auth:
    mode: none
  cors:
    origins:
      - 'http://localhost:*'

hindsight:
  url: 'http://localhost:8888'
  defaultBank: default
  retainOnComplete: true
  retainOnError: true

models:
  provider: anthropic
  apiKey: ''
  default: claude-sonnet-4-20250514
  planner: claude-sonnet-4-20250514

orchestration:
  maxSpawnDepth: 3
  workerTimeout: 300
  maxRetries: 2
  planFirst: true

logging:
  level: info
  console: true
YAML
    fi
    ok "Default config created at $CONFIG_DIR/config.yaml"
else
    ok "Config already exists at $CONFIG_DIR/config.yaml"
fi

# ── Gateway Systemd Service ─────────────────────────────────

step "Gateway Service"

if command -v systemctl &>/dev/null; then
    $SUDO tee /etc/systemd/system/orionomega.service >/dev/null <<EOF
[Unit]
Description=OrionOmega Gateway
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $INSTALL_DIR/packages/gateway/dist/server.js
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=7800

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable orionomega
    ok "Gateway systemd service installed"
    info "Start it with: systemctl start orionomega"
else
    warn "No systemd — use 'orionomega gateway start' for dev mode"
fi

# ── Done ─────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║                                            ║${RESET}"
echo -e "${BOLD}║   ${GREEN}✓ OrionOmega installed successfully!${RESET}${BOLD}     ║${RESET}"
echo -e "${BOLD}║                                            ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "  1. Run the setup wizard:  ${BLUE}orionomega setup${RESET}"
echo -e "  2. Start the gateway:     ${BLUE}orionomega gateway start${RESET}"
echo -e "  3. Check system health:   ${BLUE}orionomega doctor${RESET}"
echo -e "  4. Launch the TUI:        ${BLUE}orionomega${RESET}"
echo ""
echo -e "  ${DIM}Config:    $CONFIG_DIR/config.yaml${RESET}"
echo -e "  ${DIM}Install:   $INSTALL_DIR${RESET}"
echo -e "  ${DIM}Logs:      $CONFIG_DIR/logs/${RESET}"
echo ""
