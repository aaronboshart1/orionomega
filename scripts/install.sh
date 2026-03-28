#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  OrionOmega Installer
#  Usage: GITHUB_TOKEN=ghp_xxx curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
#    https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="${ORIONOMEGA_DIR:-$HOME/.orionomega/src}"
CONFIG_DIR="${ORIONOMEGA_HOME:-$HOME/.orionomega}"
# Support GITHUB_TOKEN for private repos
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  REPO_URL="https://${GITHUB_TOKEN}@github.com/aaronboshart1/orionomega.git"
else
  REPO_URL="https://github.com/aaronboshart1/orionomega.git"
fi
NODE_MIN=22
GATEWAY_PORT=7800

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

OS="$(uname -s)"
case "$OS" in
    Linux)  ok "Linux detected" ;;
    Darwin) ok "macOS detected" ;;
    *)      die "Unsupported OS: $OS. OrionOmega supports Linux and macOS." ;;
esac

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
if command -v brew &>/dev/null; then
    PKG="brew"
elif command -v apt-get &>/dev/null; then
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
        brew)   brew install git ;;
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
        brew)   brew install curl ;;
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
    info "Installing Node.js 22..."
    case "$PKG" in
        brew)
            brew install node@22
            brew link --overwrite node@22 2>/dev/null || true
            ;;
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
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "Failed to clone. Check network and try again."
    ok "Cloned to $INSTALL_DIR"
fi

# Fix ownership and git safe.directory (only needed on Linux with sudo)
[[ -n "${SUDO:-}" && "$OS" == "Linux" ]] && $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true

# Set git identity if not configured (needed for merge/pull operations)
if ! git config --global user.email &>/dev/null; then
    git config --global user.email "orionomega@localhost"
    git config --global user.name "OrionOmega"
fi

cd "$INSTALL_DIR"

info "Installing dependencies..."
CI=true pnpm install --no-frozen-lockfile 2>&1 | tail -3
pnpm approve-builds --all 2>/dev/null || true
ok "Dependencies installed"

info "Building packages (this may take a minute)..."
if CI=true pnpm -r build 2>&1 | tee /tmp/orionomega-build.log | tail -5; then
    ok "Build complete"
else
    echo ""
    warn "Build failed. Errors:"
    grep -E '(error|Error|TS[0-9])' /tmp/orionomega-build.log | head -20
    die "Build failed — see errors above. Full log: /tmp/orionomega-build.log"
fi

# Clear GITHUB_TOKEN so it doesn't interfere with gh CLI auth during setup
unset GITHUB_TOKEN 2>/dev/null

# ═══════════════════════════════════════════════════════════════
#  Phase 4 — Global CLI
# ═══════════════════════════════════════════════════════════════
step "CLI"

CLI_JS="$INSTALL_DIR/packages/core/dist/cli.js"
BIN_SCRIPT="$INSTALL_DIR/packages/core/bin/orionomega"
BIN_DIR="$CONFIG_DIR/bin"
BIN_TARGET="$BIN_DIR/orionomega"

# Remove stale /usr/local/bin/orionomega if it exists (legacy installs)
if [[ -f "/usr/local/bin/orionomega" ]]; then
    $SUDO rm -f "/usr/local/bin/orionomega" 2>/dev/null || true
    info "Removed stale /usr/local/bin/orionomega from previous install"
fi

mkdir -p "$BIN_DIR"

if [[ -f "$BIN_SCRIPT" ]]; then
    ln -sf "$BIN_SCRIPT" "$BIN_TARGET"
    chmod +x "$BIN_SCRIPT" 2>/dev/null || true
elif [[ -f "$CLI_JS" ]]; then
    cat > "$BIN_TARGET" <<WRAPPER
#!/usr/bin/env bash
exec node "$CLI_JS" "\$@"
WRAPPER
    chmod +x "$BIN_TARGET"
fi

# Add ~/.orionomega/bin to PATH in shell config if not already present
add_to_path() {
    local shell_rc="$1"
    local path_line="export PATH=\"\$HOME/.orionomega/bin:\$PATH\""
    if [[ -f "$shell_rc" ]]; then
        if ! grep -qF '.orionomega/bin' "$shell_rc" 2>/dev/null; then
            echo "" >> "$shell_rc"
            echo "# OrionOmega CLI" >> "$shell_rc"
            echo "$path_line" >> "$shell_rc"
            info "Added to PATH in $(basename "$shell_rc")"
        fi
    fi
}

if [[ ! ":$PATH:" == *":$BIN_DIR:"* ]]; then
    add_to_path "$HOME/.bashrc"
    add_to_path "$HOME/.zshrc"
    export PATH="$BIN_DIR:$PATH"
fi

if command -v orionomega &>/dev/null; then
    ok "orionomega command available"
else
    warn "Open a new terminal or run: export PATH=\"\$HOME/.orionomega/bin:\$PATH\""
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
  default: ''
  planner: ''
  workers: {}

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

agentSdk:
  enabled: true
  permissionMode: 'acceptEdits'
  effort: 'high'
  maxTurns: 50
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
    ok "Hindsight already running on localhost:8888"
else
    info "Installing Hindsight via Docker..."

    # Install Docker if missing
    if ! command -v docker &>/dev/null; then
        info "Installing Docker..."
        curl -fsSL https://get.docker.com | $SUDO sh 2>/dev/null
        $SUDO systemctl enable --now docker 2>/dev/null || true
    fi

    if command -v docker &>/dev/null; then
        info "Pulling Hindsight image..."
        $SUDO docker pull ghcr.io/vectorize-io/hindsight:latest 2>&1 | tail -2

        # Prepare data directory with correct permissions
        # Embedded PostgreSQL runs as non-root inside the container
        HINDSIGHT_DATA="/opt/hindsight-data"
        $SUDO mkdir -p "$HINDSIGHT_DATA"
        $SUDO chmod 777 "$HINDSIGHT_DATA"

        # Check for Anthropic API key — Hindsight requires one to start
        ANTHROPIC_KEY=""
        if [[ -f "$CONFIG_DIR/config.yaml" ]]; then
            ANTHROPIC_KEY="$(grep 'apiKey:' "$CONFIG_DIR/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d "'\"")"
        fi

        if [[ -n "$ANTHROPIC_KEY" && "$ANTHROPIC_KEY" != "''" && "$ANTHROPIC_KEY" != "\"\"" ]]; then
            info "Starting Hindsight container with Anthropic API key..."
            $SUDO docker run -d \
                --name hindsight \
                --restart unless-stopped \
                -p 8888:8888 \
                -p 9999:9999 \
                -e "HINDSIGHT_API_LLM_API_KEY=$ANTHROPIC_KEY" \
                -e "HINDSIGHT_API_LLM_PROVIDER=anthropic" \
                -e "HINDSIGHT_API_LLM_MODEL=claude-haiku-4-5-20251001" \
                -v "$HINDSIGHT_DATA:/home/hindsight/.pg0" \
                ghcr.io/vectorize-io/hindsight:latest >/dev/null 2>&1

            # Wait for Hindsight to initialize (embedded Postgres + model loading)
            info "Waiting for Hindsight to initialize (this can take 30-60s on first run)..."
            HINDSIGHT_READY=false
            for i in $(seq 1 45); do
                if curl -sf http://localhost:8888/health &>/dev/null 2>&1; then
                    ok "Hindsight running on localhost:8888"
                    ok "Control plane at http://localhost:9999"
                    HINDSIGHT_READY=true
                    break
                fi
                sleep 2
            done

            if [[ "$HINDSIGHT_READY" != "true" ]]; then
                warn "Hindsight container started but API not yet responding."
                info "It may still be loading embedding models. Check: docker logs hindsight"
                info "Typical first-start time: 30-90 seconds"
            fi
        else
            ok "Hindsight image pulled and data directory prepared"
            info "Hindsight requires an Anthropic API key to start."
            info "Run 'orionomega setup' to configure your API key — Hindsight will be started automatically."
        fi
    else
        warn "Docker not available — Hindsight not installed"
        info "Install Docker and re-run, or point to an external instance in $CONFIG_DIR/config.yaml"
    fi
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
    # Mark install dir as safe for git (service runs as root, repo may be owned by user)
    $SUDO git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
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
echo -e "    5. Launch Web:   ${BLUE}orionomega ui start${RESET}"
echo ""
echo -e "  ${DIM}Install:   $INSTALL_DIR${RESET}"
echo -e "  ${DIM}Config:    $CONFIG_DIR/config.yaml${RESET}"
echo -e "  ${DIM}Workspace: $CONFIG_DIR/workspace/${RESET}"
echo ""
