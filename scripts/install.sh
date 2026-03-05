#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  OrionOmega Installer
#  Usage: curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="/opt/orionomega"
CONFIG_DIR="${ORIONOMEGA_HOME:-$HOME/.orionomega}"
REPO_URL="https://github.com/aaronboshart1/orionomega.git"
NODE_MIN=22
GATEWAY_PORT=18790

# ── Colours ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

info()  { echo -e "  ${BLUE}ℹ${RESET}  $1"; }
ok()    { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
die()   { echo -e "  ${RED}✗${RESET}  $1"; exit 1; }
step()  { echo -e "\n${BOLD}${BLUE}▸ $1${RESET}\n"; }

# ── Header ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║        ${BLUE}OrionOmega${RESET}${BOLD} Installer               ║${RESET}"
echo -e "${BOLD}║        AI Agent Orchestration System       ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════════╝${RESET}"
echo ""

# ═══════════════════════════════════════════════════════════════
#  Phase 1 — Preflight
# ═══════════════════════════════════════════════════════════════
step "Preflight Checks"

# Linux only
[[ "$(uname -s)" == "Linux" ]] || die "OrionOmega requires Linux. Detected: $(uname -s)"
ok "Linux detected"

# Root or sudo
if [[ "$EUID" -ne 0 ]]; then
    command -v sudo &>/dev/null || die "Run as root or install sudo"
    SUDO="sudo"
    warn "Not root — will use sudo for system operations"
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

# Package manager detection
if command -v apt-get &>/dev/null; then
    PKG="apt"
elif command -v dnf &>/dev/null; then
    PKG="dnf"
elif command -v yum &>/dev/null; then
    PKG="yum"
elif command -v pacman &>/dev/null; then
    PKG="pacman"
else
    PKG="unknown"
    warn "Unknown package manager — may need to install dependencies manually"
fi

# Git
if ! command -v git &>/dev/null; then
    info "Installing git..."
    case "$PKG" in
        apt)    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git ;;
        dnf)    $SUDO dnf install -y -q git ;;
        yum)    $SUDO yum install -y -q git ;;
        pacman) $SUDO pacman -S --noconfirm git ;;
        *)      die "Please install git manually" ;;
    esac
fi
ok "git $(git --version | awk '{print $3}')"

# curl (needed for Node install)
if ! command -v curl &>/dev/null; then
    info "Installing curl..."
    case "$PKG" in
        apt)    $SUDO apt-get install -y -qq curl ;;
        dnf)    $SUDO dnf install -y -q curl ;;
        yum)    $SUDO yum install -y -q curl ;;
        pacman) $SUDO pacman -S --noconfirm curl ;;
        *)      die "Please install curl manually" ;;
    esac
fi
ok "curl available"

# ═══════════════════════════════════════════════════════════════
#  Phase 2 — Node.js >= 22
# ═══════════════════════════════════════════════════════════════
step "Node.js"

install_node() {
    info "Installing Node.js 22 via NodeSource..."
    case "$PKG" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - 2>/dev/null
            $SUDO apt-get install -y -qq nodejs
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO -E bash - 2>/dev/null
            $SUDO "$PKG" install -y -q nodejs
            ;;
        *)
            die "Cannot auto-install Node.js on this system. Install Node.js >= 22 manually: https://nodejs.org"
            ;;
    esac
}

if command -v node &>/dev/null; then
    NODE_VER="$(node -v | sed 's/v//')"
    NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
    if [[ "$NODE_MAJOR" -ge "$NODE_MIN" ]]; then
        ok "Node.js v${NODE_VER}"
    else
        warn "Node.js v${NODE_VER} is too old (need >= ${NODE_MIN})"
        install_node
        ok "Node.js $(node -v)"
    fi
else
    install_node
    ok "Node.js $(node -v)"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
    info "Installing pnpm..."
    npm install -g pnpm 2>/dev/null || corepack enable pnpm 2>/dev/null || die "Could not install pnpm"
fi
ok "pnpm $(pnpm --version)"

# ═══════════════════════════════════════════════════════════════
#  Phase 3 — Clone & Build
# ═══════════════════════════════════════════════════════════════
step "OrionOmega"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing installation found — updating..."
    cd "$INSTALL_DIR"
    git pull --ff-only 2>/dev/null || warn "git pull failed — continuing with existing code"
    ok "Repository updated"
else
    if [[ -d "$INSTALL_DIR" ]]; then
        $SUDO mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
        warn "Backed up existing $INSTALL_DIR"
    fi
    info "Cloning repository..."
    $SUDO git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone. Check network and try again."
    ok "Cloned to $INSTALL_DIR"
fi

# Fix ownership
[[ -n "${SUDO:-}" ]] && $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"

cd "$INSTALL_DIR"

info "Installing dependencies..."
pnpm install 2>&1 | tail -3
ok "Dependencies installed"

info "Building packages (this may take a minute)..."
if pnpm -r build 2>&1 | tee /tmp/orionomega-build.log | tail -5; then
    ok "Build complete"
else
    echo ""
    warn "Build failed. Errors:"
    grep -E '(error|Error|TS[0-9])' /tmp/orionomega-build.log | head -20
    die "Build failed — see errors above. Full log: /tmp/orionomega-build.log"
fi

# ═══════════════════════════════════════════════════════════════
#  Phase 4 — Global CLI
# ═══════════════════════════════════════════════════════════════
step "CLI"

cd "$INSTALL_DIR/packages/core"
$SUDO npm link 2>/dev/null || true

if command -v orionomega &>/dev/null; then
    ok "orionomega command available"
else
    # Symlink fallback
    BIN_TARGET="/usr/local/bin/orionomega"
    CLI_JS="$INSTALL_DIR/packages/core/dist/cli.js"
    if [[ -f "$CLI_JS" ]]; then
        $SUDO ln -sf "$CLI_JS" "$BIN_TARGET" 2>/dev/null || true
        $SUDO chmod +x "$BIN_TARGET" 2>/dev/null || true
        if command -v orionomega &>/dev/null; then
            ok "orionomega command available (via symlink)"
        else
            warn "Could not add orionomega to PATH. Run manually: node $CLI_JS"
        fi
    fi
fi

# ═══════════════════════════════════════════════════════════════
#  Phase 5 — Configuration
# ═══════════════════════════════════════════════════════════════
step "Configuration"

mkdir -p "$CONFIG_DIR"/{workspace,workspace/output,workspace/memory,workspace/progress,workspace/orchestration,logs,skills}

if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
    cat > "$CONFIG_DIR/config.yaml" <<YAML
# OrionOmega Configuration
# Run 'orionomega setup' for interactive configuration.

gateway:
  port: ${GATEWAY_PORT}
  bind: '127.0.0.1'
  auth:
    mode: 'none'
    keyHash: ''
  cors:
    origins:
      - 'http://localhost:3000'

hindsight:
  url: 'http://localhost:8888'
  defaultBank: 'default'
  retainOnComplete: true
  retainOnError: true

models:
  provider: 'anthropic'
  apiKey: ''
  default: 'claude-sonnet-4-20250514'
  planner: 'claude-sonnet-4-20250514'
  workers:
    code: 'claude-sonnet-4-20250514'
    research: 'claude-haiku-4-20250514'
    analysis: 'claude-haiku-4-20250514'
    writing: 'claude-sonnet-4-20250514'

orchestration:
  maxSpawnDepth: 2
  workerTimeout: 300
  maxRetries: 2
  planFirst: true
  checkpointInterval: 1
  eventBatching:
    tuiIntervalMs: 10000
    webIntervalMs: 0
    immediateTypes:
      - 'done'
      - 'error'
      - 'finding'

workspace:
  path: '${CONFIG_DIR}/workspace'
  maxOutputSize: '100MB'

logging:
  level: 'verbose'
  file: '${CONFIG_DIR}/logs/orionomega.log'
  maxSize: '50MB'
  maxFiles: 5
  console: true

skills:
  directory: '${CONFIG_DIR}/skills'
  autoLoad: true
YAML
    ok "Config written to $CONFIG_DIR/config.yaml"
else
    ok "Config exists at $CONFIG_DIR/config.yaml"
fi

# Write workspace templates if missing
write_template() {
    local file="$1" content="$2"
    if [[ ! -f "$file" ]]; then
        echo "$content" > "$file"
    fi
}

write_template "$CONFIG_DIR/workspace/SOUL.md" "# SOUL.md — Agent Personality

Define how your OrionOmega agent speaks and behaves.

## Name
<!-- Give your agent a name -->

## Tone
<!-- e.g. dry wit, warm, all business, playful -->

## Rules
<!-- What should the agent always/never do? -->

---
Edit this file to make the agent yours."

write_template "$CONFIG_DIR/workspace/USER.md" "# USER.md — About You

Help your agent understand who you are.

- **Name:**
- **Timezone:**
- **Preferences:**

## Context
<!-- What are you working on? What matters? -->"

write_template "$CONFIG_DIR/workspace/TOOLS.md" "# TOOLS.md — Environment Notes

Your cheat sheet for environment-specific details.

## SSH Hosts
## API Keys
## Notes"

ok "Workspace initialized"

# ═══════════════════════════════════════════════════════════════
#  Phase 6 — Hindsight Check (non-interactive)
# ═══════════════════════════════════════════════════════════════
step "Hindsight (Memory System)"

if curl -sf http://localhost:8888/v1/default/banks &>/dev/null 2>&1; then
    ok "Hindsight running on localhost:8888"
else
    info "Hindsight not detected on localhost:8888"
    info "OrionOmega works without Hindsight, but memory features won't be available."
    info "To install Hindsight: https://github.com/aaronboshart1/hindsight"
    info "Or point to an existing instance in $CONFIG_DIR/config.yaml"
fi

# ═══════════════════════════════════════════════════════════════
#  Phase 7 — Gateway Service (optional systemd)
# ═══════════════════════════════════════════════════════════════
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
Environment=CONFIG_PATH=$CONFIG_DIR/config.yaml

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable orionomega 2>/dev/null || true
    ok "Systemd service installed (orionomega.service)"
else
    info "No systemd — use 'orionomega gateway start' to run in dev mode"
fi

# ═══════════════════════════════════════════════════════════════
#  Done
# ═══════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${GREEN}╔════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║   ✓ OrionOmega installed successfully!     ║${RESET}"
echo -e "${BOLD}${GREEN}╚════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "    1. Configure:    ${BLUE}orionomega setup${RESET}"
echo -e "    2. Start:        ${BLUE}orionomega gateway start${RESET}"
echo -e "    3. Verify:       ${BLUE}orionomega doctor${RESET}"
echo -e "    4. Launch TUI:   ${BLUE}orionomega${RESET}"
echo -e "    5. Launch Web:   ${BLUE}orionomega ui${RESET}"
echo ""
echo -e "  ${DIM}Install:   $INSTALL_DIR${RESET}"
echo -e "  ${DIM}Config:    $CONFIG_DIR/config.yaml${RESET}"
echo -e "  ${DIM}Workspace: $CONFIG_DIR/workspace/${RESET}"
echo ""
