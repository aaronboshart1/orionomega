#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/aaronboshart1/orionomega.git"
INSTALL_DIR="${ORIONOMEGA_DIR:-$HOME/.orionomega/src}"
BIN_DIR="$HOME/.orionomega/bin"
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
  printf "  Updating existing installation... "
  cd "$INSTALL_DIR"
  git fetch origin main 2>/dev/null
  git reset --hard origin/main 2>/dev/null || git pull origin main
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
pnpm install --frozen-lockfile
info "Dependencies installed"

# ── 5. Build ─────────────────────────────────────────────────────

step "Building OrionOmega..."
pnpm build
info "Build complete"

# ── 6. Link CLI globally ─────────────────────────────────────────

step "Linking orionomega command..."

pnpm unlink -g @orionomega/core 2>/dev/null || true
npm unlink -g @orionomega/core 2>/dev/null || true

if [ -f /usr/local/bin/orionomega ]; then
  sudo rm -f /usr/local/bin/orionomega 2>/dev/null || rm -f /usr/local/bin/orionomega 2>/dev/null || true
fi

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/orionomega" <<WRAPPER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/packages/core/dist/cli.js" "\$@"
WRAPPER
chmod +x "$BIN_DIR/orionomega"

SHELL_RC=""
if [ -n "${ZSH_VERSION:-}" ] || [ "${SHELL:-}" = "/bin/zsh" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -n "${BASH_VERSION:-}" ] || [ "${SHELL:-}" = "/bin/bash" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  touch "$SHELL_RC"
  if ! grep -q 'orionomega/bin' "$SHELL_RC" 2>/dev/null; then
    printf '\n# OrionOmega\nexport PATH="$HOME/.orionomega/bin:$PATH"\n' >> "$SHELL_RC"
    info "Added to PATH in $SHELL_RC"
  fi
fi

export PATH="$BIN_DIR:$PATH"
info "orionomega command ready"

# ── 6b. Set up custom commands directory ──────────────────────────────
COMMANDS_DIR="$HOME/orionomega/commands"
if [ ! -d "$COMMANDS_DIR" ]; then
  mkdir -p "$COMMANDS_DIR"
  if [ -d "$INSTALL_DIR/commands" ]; then
    cp "$INSTALL_DIR/commands/"*.md "$COMMANDS_DIR/" 2>/dev/null || true
  fi
  info "Custom commands directory created at $COMMANDS_DIR"
else
  info "Custom commands directory already exists at $COMMANDS_DIR"
fi

# ── 7. Pre-pull Hindsight Docker image ─────────────────────────────

step "Hindsight (Memory System)..."

HINDSIGHT_DATA="$HOME/.orionomega/hindsight-data"
mkdir -p "$HINDSIGHT_DATA"

install_docker_macos() {
  if ! command -v brew &>/dev/null; then
    warn "Homebrew not found — cannot auto-install Docker."
    printf "    Install Homebrew first: https://brew.sh\n"
    printf "    Then re-run this installer.\n"
    return 1
  fi

  info "Installing Docker CLI and Colima via Homebrew..."
  brew install docker colima 2>&1 | tail -3
  info "Starting Colima (lightweight Docker runtime)..."
  colima start --cpu 2 --memory 4 2>&1 | tail -3

  if docker info &>/dev/null 2>&1; then
    info "Docker is running via Colima"
    return 0
  else
    warn "Colima started but Docker not responding. Try: colima start"
    return 1
  fi
}

DOCKER_READY=false

if command -v docker &>/dev/null; then
  if docker info &>/dev/null 2>&1; then
    info "Docker is running"
    DOCKER_READY=true
  else
    if [ "$(uname -s)" = "Darwin" ]; then
      if command -v colima &>/dev/null; then
        info "Starting Colima..."
        colima start --cpu 2 --memory 4 2>&1 | tail -3
        if docker info &>/dev/null 2>&1; then
          info "Docker is running via Colima"
          DOCKER_READY=true
        fi
      else
        warn "Docker CLI found but daemon not running."
        install_docker_macos && DOCKER_READY=true
      fi
    else
      warn "Docker is installed but not running."
      printf "    Start the Docker daemon and re-run setup to enable Hindsight.\n"
    fi
  fi
else
  if [ "$(uname -s)" = "Darwin" ]; then
    install_docker_macos && DOCKER_READY=true
  else
    warn "Docker not found — installing via package manager..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq docker.io 2>&1 | tail -3
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y docker 2>&1 | tail -3
    elif command -v yum &>/dev/null; then
      sudo yum install -y docker 2>&1 | tail -3
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm docker 2>&1 | tail -3
    elif command -v zypper &>/dev/null; then
      sudo zypper install -y docker 2>&1 | tail -3
    else
      warn "No supported package manager found. Install Docker manually using your distribution's package manager."
    fi
    if command -v docker &>/dev/null; then
      sudo systemctl enable --now docker 2>/dev/null || true
      if docker info &>/dev/null 2>&1; then
        info "Docker installed and running"
        DOCKER_READY=true
      fi
    fi
  fi
fi

HINDSIGHT_RUNNING=false

if [ "$DOCKER_READY" = "true" ]; then
  if docker image inspect ghcr.io/vectorize-io/hindsight:latest &>/dev/null 2>&1; then
    info "Hindsight image already available"
  else
    printf "  Pulling Hindsight image (this may take a few minutes)... "
    if docker pull ghcr.io/vectorize-io/hindsight:latest 2>&1 | tail -1; then
      info "Hindsight image pulled"
    else
      warn "Failed to pull Hindsight image — you can pull it manually later:"
      printf "    docker pull ghcr.io/vectorize-io/hindsight:latest\n"
    fi
  fi

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hindsight$'; then
    info "Hindsight container already running"
    HINDSIGHT_RUNNING=true
  elif docker image inspect ghcr.io/vectorize-io/hindsight:latest &>/dev/null 2>&1; then
    CONFIG_FILE="$HOME/.orionomega/config.yaml"
    API_KEY=""
    if [ -f "$CONFIG_FILE" ]; then
      API_KEY=$(grep -E '^\s*apiKey:' "$CONFIG_FILE" | head -1 | sed 's/.*apiKey:\s*//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//' | tr -d '[:space:]')
    fi

    if [ -n "$API_KEY" ] && [ "$API_KEY" != "not" ]; then
      docker stop hindsight 2>/dev/null || true
      docker rm hindsight 2>/dev/null || true
      printf "  Starting Hindsight container... "
      if docker run -d \
        --name hindsight \
        --restart unless-stopped \
        -p 8888:8888 -p 9999:9999 \
        -e "HINDSIGHT_API_LLM_API_KEY=${API_KEY}" \
        -e "HINDSIGHT_API_LLM_PROVIDER=anthropic" \
        -e "HINDSIGHT_API_LLM_MODEL=claude-haiku-4-5-20251001" \
        -v "${HINDSIGHT_DATA}:/home/hindsight/.pg0" \
        ghcr.io/vectorize-io/hindsight:latest >/dev/null 2>&1; then
        printf "done\n"
        info "Hindsight container started"
        HINDSIGHT_RUNNING=true
        printf "  ${DIM}Hindsight needs 30-60s to initialize on first start.${NC}\n"
      else
        warn "Failed to start Hindsight container."
        printf "    Run: orionomega setup  (step 4 to configure Hindsight)\n"
      fi
    else
      printf "  ${DIM}No API key found yet. The setup wizard will start Hindsight after you configure it.${NC}\n"
    fi
  fi
else
  warn "Docker not available — Hindsight will not be started."
  printf "    You can install Docker later and re-run: orionomega setup\n"
fi

# ── 8. Verify ────────────────────────────────────────────────────

step "Verifying installation..."
"$BIN_DIR/orionomega" --help >/dev/null 2>&1 && info "Installation verified!" || warn "CLI built but --help check failed"

printf "\n"
printf "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "  ${BOLD}  Installation complete!${NC}\n"
printf "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "\n"
printf "  ${BOLD}Available commands:${NC}\n"
printf "    ${GREEN}orionomega setup${NC}    Configure API keys, Hindsight, workspace\n"
printf "    ${GREEN}orionomega tui${NC}      Launch the terminal UI\n"
printf "    ${GREEN}orionomega doctor${NC}   Check system health\n"
printf "    ${GREEN}orionomega status${NC}   Show current configuration\n"
printf "\n"
printf "  Launching setup wizard...\n"
printf "\n"

# ── 9. Run setup wizard, then drop into a fresh login shell ──────
# Run setup in a subshell with PATH set, then exec a fresh login shell
# so the user lands in a shell where `orionomega` is immediately available.
PATH="$BIN_DIR:$PATH" "$BIN_DIR/orionomega" setup </dev/tty

printf "\n"
printf "  ${BOLD}Opening a new shell so 'orionomega' is in your PATH...${NC}\n"
printf "  ${DIM}(Type 'exit' to return to your previous shell)${NC}\n"
printf "\n"
exec "${SHELL:-/bin/sh}" -l </dev/tty
