#!/usr/bin/env bash
set -euo pipefail

# Restore stdin from /dev/tty when piped (e.g., curl | bash)
# This allows interactive prompts to work properly
if [ ! -t 0 ]; then
  exec < /dev/tty 2>/dev/null || true
fi

# Support GITHUB_TOKEN for private repo access
if [ -n "${GITHUB_TOKEN:-}" ]; then
  REPO="https://${GITHUB_TOKEN}@github.com/aaronboshart1/orionomega.git"
else
  REPO="https://github.com/aaronboshart1/orionomega.git"
fi
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

is_interactive() {
  [ -t 0 ] && [ -t 1 ]
}

SKIPPED_STEPS=""

confirm_sudo() {
  local action="$1"
  if ! is_interactive; then
    SKIPPED_STEPS="${SKIPPED_STEPS:+$SKIPPED_STEPS, }$action"
    warn "Non-interactive mode: skipping confirmation for: $action"
    return 1
  fi
  printf "${YELLOW}⚠${NC} The following operation requires sudo: %s\n" "$action"
  printf "  Proceed? [y/N] "
  read -r answer </dev/tty
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) warn "Skipped: $action"; return 1 ;;
  esac
}

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
if ! printf '%s' "$NODE_VERSION" | grep -qE '^[0-9]+$'; then
  fail "Could not determine Node.js version (got: $(node -v)). Please reinstall Node.js."
fi
if [ "$NODE_VERSION" -lt "$MIN_NODE" ]; then
  fail "Node.js $MIN_NODE+ required (found v$(node -v | sed 's/v//')). Please upgrade."
fi
info "Node.js $(node -v)"

# ── 2. Install pnpm ─────────────────────────────────────────────

if ! command -v pnpm &>/dev/null; then
  step "Installing pnpm..."
  if command -v corepack &>/dev/null; then
    corepack enable pnpm 2>/dev/null && info "pnpm installed via corepack" || {
      npm install -g pnpm </dev/null || fail "Could not install pnpm. Install it manually: npm install -g pnpm"
      info "pnpm installed via npm"
    }
  else
    npm install -g pnpm </dev/null || fail "Could not install pnpm. Install it manually: npm install -g pnpm"
    info "pnpm installed via npm"
  fi
else
  info "pnpm $(pnpm -v)"
fi

# ── 3. Clone or update repo ─────────────────────────────────────

step "Getting OrionOmega source..."

if [ -d "$INSTALL_DIR/.git" ]; then
  printf "  Updating existing installation... "
  cd "$INSTALL_DIR"
  git fetch origin main 2>/dev/null || true
  if ! git pull --ff-only origin main 2>/dev/null; then
    warn "Fast-forward pull failed. You may have local changes."
    printf "    To force update: cd %s && git reset --hard origin/main\n" "$INSTALL_DIR"
    printf "    Continuing with existing code.\n"
  fi
  printf "done\n"
else
  printf "  Cloning into %s... " "$INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO" "$INSTALL_DIR" </dev/null || fail "Failed to clone repository. Check your network connection."
  printf "done\n"
  cd "$INSTALL_DIR"
fi

if [ ! -f "$INSTALL_DIR/packages/core/package.json" ]; then
  fail "Repository clone appears incomplete (packages/core/package.json not found). Remove $INSTALL_DIR and try again."
fi

info "Source ready at $INSTALL_DIR"

# ── 4. Install dependencies ─────────────────────────────────────

step "Installing dependencies..."
if ! pnpm install --frozen-lockfile </dev/null 2>/dev/null; then
  warn "Frozen lockfile install failed — falling back to regular install (lockfile may be stale)"
  pnpm install </dev/null || fail "Dependency installation failed."
fi
info "Dependencies installed"

# ── 5. Build ─────────────────────────────────────────────────────

step "Building OrionOmega..."
pnpm build </dev/null || fail "Build failed. Run 'pnpm build' manually to see errors."
info "Build complete"

# ── 6. Link CLI globally ─────────────────────────────────────────

step "Linking orionomega command..."

pnpm unlink -g @orionomega/core 2>/dev/null || true
npm unlink -g @orionomega/core 2>/dev/null || true

if [ -f /usr/local/bin/orionomega ]; then
  if confirm_sudo "Remove old /usr/local/bin/orionomega symlink"; then
    sudo rm -f /usr/local/bin/orionomega 2>/dev/null || true
  else
    rm -f /usr/local/bin/orionomega 2>/dev/null || true
  fi
fi

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/orionomega" <<WRAPPER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/packages/core/dist/cli.js" "\$@"
WRAPPER
chmod +x "$BIN_DIR/orionomega"

detect_shell_rc() {
  local user_shell="${SHELL:-}"
  case "$user_shell" in
    */zsh)
      if [ "$(uname -s)" = "Darwin" ]; then
        if [ -f "$HOME/.zprofile" ]; then
          printf '%s' "$HOME/.zprofile"
        else
          printf '%s' "$HOME/.zshrc"
        fi
      else
        printf '%s' "$HOME/.zshrc"
      fi
      ;;
    */bash)
      if [ "$(uname -s)" = "Darwin" ]; then
        if [ -f "$HOME/.bash_profile" ]; then
          printf '%s' "$HOME/.bash_profile"
        elif [ -f "$HOME/.profile" ]; then
          printf '%s' "$HOME/.profile"
        else
          printf '%s' "$HOME/.bashrc"
        fi
      else
        printf '%s' "$HOME/.bashrc"
      fi
      ;;
    */fish)
      printf '%s' "$HOME/.config/fish/config.fish"
      ;;
    *)
      if [ -f "$HOME/.profile" ]; then
        printf '%s' "$HOME/.profile"
      elif [ -f "$HOME/.bashrc" ]; then
        printf '%s' "$HOME/.bashrc"
      fi
      ;;
  esac
}

SHELL_RC="$(detect_shell_rc)"

if [ -n "$SHELL_RC" ]; then
  if [ ! -f "$SHELL_RC" ]; then
    mkdir -p "$(dirname "$SHELL_RC")"
  fi
  touch "$SHELL_RC"

  case "$SHELL_RC" in
    *.fish)
      if ! grep -q 'orionomega/bin' "$SHELL_RC" 2>/dev/null; then
        printf '\n# OrionOmega\nset -gx PATH $HOME/.orionomega/bin $PATH\n' >> "$SHELL_RC"
        info "Added to PATH in $SHELL_RC"
      fi
      ;;
    *)
      if ! grep -q 'orionomega/bin' "$SHELL_RC" 2>/dev/null; then
        printf '\n# OrionOmega\nexport PATH="$HOME/.orionomega/bin:$PATH"\n' >> "$SHELL_RC"
        info "Added to PATH in $SHELL_RC"
      fi
      ;;
  esac
fi

export PATH="$BIN_DIR:$PATH"
info "orionomega command ready"

# ── 6b. Set up custom commands directory ──────────────────────────────
COMMANDS_DIR="$HOME/.orionomega/commands"
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

  if docker info &>/dev/null; then
    info "Docker is running via Colima"
    return 0
  else
    warn "Colima started but Docker not responding. Try: colima start"
    return 1
  fi
}

DOCKER_READY=false

# Check if 'docker' found is the npm package (not Docker Engine)
# npm's 'docker' package doesn't support 'docker info' properly
if command -v docker &>/dev/null; then
  DOCKER_PATH=$(command -v docker)
  # npm packages are typically in node_modules/.bin or similar paths
  if echo "$DOCKER_PATH" | grep -q "node_modules\|npm\|\.npm"; then
    echo ""
    echo "WARNING: Found 'docker' at $DOCKER_PATH but this appears to be the npm 'docker' package,"
    echo "not Docker Engine (the container runtime)."
    echo "The npm 'docker' package is NOT the same as Docker Engine."
    echo ""
    echo "To install Docker Engine, visit: https://docs.docker.com/engine/install/"
    echo "On macOS: Install Docker Desktop from https://www.docker.com/products/docker-desktop/"
    echo ""
    # Unset docker so we fall through to installation logic
    DOCKER_READY=false
  fi
fi

if command -v docker &>/dev/null && ! echo "$(command -v docker)" | grep -q "node_modules\|npm\|\.npm"; then
  if docker info &>/dev/null; then
    info "Docker is running"
    DOCKER_READY=true
  else
    if [ "$(uname -s)" = "Darwin" ]; then
      if command -v colima &>/dev/null; then
        info "Starting Colima..."
        colima start --cpu 2 --memory 4 2>&1 | tail -3
        if docker info &>/dev/null; then
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
    if confirm_sudo "Install Docker via system package manager"; then
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
    fi
    if command -v docker &>/dev/null; then
      if confirm_sudo "Enable and start Docker service"; then
        sudo systemctl enable --now docker 2>/dev/null || true
      fi
      if docker info &>/dev/null; then
        info "Docker installed and running"
        DOCKER_READY=true
      fi
    fi
    if [ "$DOCKER_READY" != "true" ]; then
      echo ""
      echo "Docker Engine is required but was not found or could not be started."
      echo ""
      echo "NOTE: If you ran 'npm install docker', that installs an npm package, NOT Docker Engine."
      echo "      The npm 'docker' package is unrelated to Docker Engine."
      echo ""
      echo "To install Docker Engine:"
      echo "  - macOS:   https://www.docker.com/products/docker-desktop/"
      echo "  - Ubuntu:  curl -fsSL https://get.docker.com | sh"
      echo "  - Other:   https://docs.docker.com/engine/install/"
      echo ""
    fi
  fi
fi

HINDSIGHT_RUNNING=false

if [ "$DOCKER_READY" = "true" ]; then
  if docker image inspect ghcr.io/vectorize-io/hindsight:latest &>/dev/null; then
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
  elif docker image inspect ghcr.io/vectorize-io/hindsight:latest &>/dev/null; then
    CONFIG_FILE="$HOME/.orionomega/config.yaml"
    API_KEY=""
    if [ -f "$CONFIG_FILE" ]; then
      # Extract the apiKey under the models: section (skip commented lines)
      API_KEY=$(sed -n '/^models:/,/^[^ ]/{ /^\s*apiKey:/{ s/.*apiKey:\s*//; s/^["'"'"']//; s/["'"'"']$//; s/^[[:space:]]*//; s/[[:space:]]*$//; p; q; } }' "$CONFIG_FILE") || true
    fi

    if [ -n "$API_KEY" ] && [ "$API_KEY" != "''" ] && [ "$API_KEY" != '""' ] && [ ${#API_KEY} -gt 8 ]; then
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

# ── 9. Run setup wizard ──────────────────────────────────────────
if is_interactive; then
  PATH="$BIN_DIR:$PATH" "$BIN_DIR/orionomega" setup < /dev/tty
else
  printf "  ${DIM}Non-interactive shell detected — skipping setup wizard.${NC}\n"
  printf "  Run ${GREEN}orionomega setup${NC} in an interactive terminal to configure.\n"
fi

if [ -n "$SKIPPED_STEPS" ]; then
  printf "\n"
  printf "  ${YELLOW}⚠${NC} ${BOLD}The following steps were skipped (non-interactive mode):${NC}\n"
  printf "    %s\n" "$SKIPPED_STEPS"
  printf "    Re-run the installer interactively to complete these steps.\n"
fi

printf "\n"
printf "  ${BOLD}Restart your terminal or run the following to add orionomega to your PATH:${NC}\n"
printf "    export PATH=\"\$HOME/.orionomega/bin:\$PATH\"\n"
printf "\n"
