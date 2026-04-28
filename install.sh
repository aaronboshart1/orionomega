#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  OrionOmega Installer
#  Cross-platform installer for Kali Linux, Ubuntu/Debian, and macOS.
#
#  Usage (direct):
#    bash install.sh
#
#  Usage (one-liner):
#    curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
#
#  Environment variables (all optional):
#    GITHUB_TOKEN          GitHub PAT for private repo access
#    ANTHROPIC_API_KEY     Anthropic API key (skips interactive prompt)
#    ORIONOMEGA_DIR        Override source install directory
#    ORIONOMEGA_MODEL      Default model (default: claude-haiku-4-5-20251001)
#    ORIONOMEGA_NO_SERVICE Set to skip service setup prompt
#    ORIONOMEGA_CLEAN      Set to "1" to wipe all packages/*/dist before
#                          building (recovery for half-finished builds that
#                          left stale compiled JS in place)
#    NO_COLOR              Disable colored output (https://no-color.org/)
#
#  After install, run `orionomega update --clean` to fully wipe and rebuild
#  the dist/ directories — useful if the gateway is loading stale compiled
#  code (look for the "rebuild required" badge in the web UI).
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────

REPO_OWNER="aaronboshart1"
REPO_NAME="orionomega"
MIN_NODE=22
PNPM_VERSION="9"
HINDSIGHT_IMAGE="ghcr.io/vectorize-io/hindsight:latest"

INSTALL_DIR="${ORIONOMEGA_DIR:-$HOME/.orionomega/src}"
BIN_DIR="$HOME/.orionomega/bin"
CONFIG_DIR="$HOME/.orionomega"
DATA_DIR="$HOME/.orionomega/hindsight-data"
COMMANDS_DIR="$HOME/.orionomega/commands"

# ── TTY detection for interactive prompts (curl | bash safe) ──────────────────
# Do NOT use "exec < /dev/tty" here — it replaces stdin mid-stream and kills
# the pipe that bash is reading the script from, causing curl error 23.
# Instead, all interactive reads use explicit "</dev/tty" redirects, and
# is_interactive() checks /dev/tty availability directly.
TTY_AVAILABLE=false
if [ -e /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
  TTY_AVAILABLE=true
fi

# ── Repository URL (with optional token) ──────────────────────────────────────

if [ -n "${GITHUB_TOKEN:-}" ]; then
  REPO_URL="https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
else
  REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
fi

# ═══════════════════════════════════════════════════════════════════════════════
#  Color / logging
#  Respects NO_COLOR (https://no-color.org/) and TERM=dumb.
#  Falls back to ASCII symbols when the locale is not UTF-8.
# ═══════════════════════════════════════════════════════════════════════════════

setup_colors() {
  if [ -n "${NO_COLOR:-}" ] || [ "${TERM:-}" = "dumb" ] || [ ! -t 1 ]; then
    GREEN='' RED='' YELLOW='' BOLD='' DIM='' NC=''
  else
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[0;33m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
  fi

  # Use unicode symbols only if the locale supports them
  if locale charmap 2>/dev/null | grep -qi 'utf' 2>/dev/null; then
    SYM_OK='✓' SYM_FAIL='✗' SYM_WARN='⚠'
  else
    SYM_OK='[ok]' SYM_FAIL='[!!]' SYM_WARN='[!]'
  fi
}

info()  { printf "${GREEN}${SYM_OK}${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}${SYM_WARN}${NC} %s\n" "$1"; }
fail()  { printf "${RED}${SYM_FAIL}${NC} %s\n" "$1" >&2; exit 1; }
step()  { printf "\n${BOLD}%s${NC}\n" "$1"; }

is_interactive() { $TTY_AVAILABLE && [ -t 1 ]; }

# ═══════════════════════════════════════════════════════════════════════════════
#  OS detection
#  Populates: OS  OS_ID  OS_VERSION  ARCH
#  OS_ID values: kali | ubuntu | debian | macos | fedora | arch | linux
# ═══════════════════════════════════════════════════════════════════════════════

detect_os() {
  OS="" OS_ID="" OS_VERSION="" ARCH=""
  ARCH="$(uname -m)"

  case "$(uname -s)" in
    Darwin)
      OS="macOS"
      OS_ID="macos"
      OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
      ;;
    Linux)
      if [ -f /etc/os-release ]; then
        # shellcheck source=/dev/null
        . /etc/os-release
        OS="${PRETTY_NAME:-${NAME:-Linux}}"
        OS_ID="${ID:-linux}"
        OS_VERSION="${VERSION_ID:-unknown}"
      elif [ -f /etc/lsb-release ]; then
        # shellcheck source=/dev/null
        . /etc/lsb-release
        OS="${DISTRIB_DESCRIPTION:-Linux}"
        OS_ID="$(printf '%s' "${DISTRIB_ID:-linux}" | tr '[:upper:]' '[:lower:]')"
        OS_VERSION="${DISTRIB_RELEASE:-unknown}"
      else
        OS="Linux"
        OS_ID="linux"
        OS_VERSION="unknown"
      fi
      ;;
    *)
      OS="$(uname -s)"
      OS_ID="unknown"
      OS_VERSION="unknown"
      ;;
  esac
}

# Returns 0 if the OS uses apt (Debian, Ubuntu, Kali, Pop, Mint, etc.)
is_debian_based() {
  case "$OS_ID" in
    debian|ubuntu|kali|pop|linuxmint|elementary|raspbian) return 0 ;;
    *) return 1 ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════════════
#  Privilege detection
#  Populates: IS_ROOT  SUDO
#  Kali defaults to root. Ubuntu typically uses sudo. macOS uses regular user.
# ═══════════════════════════════════════════════════════════════════════════════

detect_privileges() {
  IS_ROOT=false
  SUDO=""

  if [ "$(id -u)" -eq 0 ]; then
    IS_ROOT=true
  elif command -v sudo &>/dev/null; then
    SUDO="sudo"
  fi
}

# Run a command with appropriate privileges
run_privileged() {
  if $IS_ROOT; then
    "$@"
  elif [ -n "$SUDO" ]; then
    $SUDO "$@"
  else
    fail "Root privileges required but sudo is not available. Run as root or install sudo."
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  Cleanup trap — removes partial clones on failure
# ═══════════════════════════════════════════════════════════════════════════════

PARTIAL_CLONE=""

cleanup_on_failure() {
  local exit_code=$?
  if [ $exit_code -ne 0 ] && [ -n "$PARTIAL_CLONE" ] && [ -d "$PARTIAL_CLONE" ]; then
    warn "Installation failed (exit $exit_code). Removing partial clone at $PARTIAL_CLONE..."
    rm -rf "$PARTIAL_CLONE"
  fi
  # Reset terminal formatting
  printf '%b' "${NC:-}" 2>/dev/null || true
}

trap cleanup_on_failure EXIT INT TERM

# ═══════════════════════════════════════════════════════════════════════════════
#  Sudo confirmation helper
# ═══════════════════════════════════════════════════════════════════════════════

SKIPPED_STEPS=""

confirm_sudo() {
  local action="$1"
  # Root never needs confirmation
  if $IS_ROOT; then
    return 0
  fi
  if ! is_interactive; then
    SKIPPED_STEPS="${SKIPPED_STEPS:+$SKIPPED_STEPS, }$action"
    warn "Non-interactive mode: skipping: $action"
    return 1
  fi
  printf "${YELLOW}${SYM_WARN}${NC} Requires elevated privileges: %s\n" "$action"
  printf "  Proceed? [y/N] "
  read -r answer </dev/tty
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) warn "Skipped: $action"; return 1 ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════════════
#  Banner — uses ASCII when locale is not UTF-8
# ═══════════════════════════════════════════════════════════════════════════════

print_banner() {
  if locale charmap 2>/dev/null | grep -qi 'utf' 2>/dev/null; then
    cat <<'BANNER'

  ╔══════════════════════════════════════╗
  ║       OrionOmega — Installer         ║
  ╚══════════════════════════════════════╝

BANNER
  else
    cat <<'BANNER'

  +======================================+
  |       OrionOmega -- Installer        |
  +======================================+

BANNER
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  Network connectivity check
# ═══════════════════════════════════════════════════════════════════════════════

check_network() {
  step "Checking network connectivity..."
  local url="https://github.com"

  if command -v curl &>/dev/null; then
    if curl -fsSL --connect-timeout 10 -o /dev/null "$url" 2>/dev/null; then
      info "Network connectivity OK"
      return 0
    fi
  elif command -v wget &>/dev/null; then
    if wget -q --timeout=10 --spider "$url" 2>/dev/null; then
      info "Network connectivity OK"
      return 0
    fi
  fi

  fail "Cannot reach $url. Check your internet connection and try again."
}

# ═══════════════════════════════════════════════════════════════════════════════
#  1. Prerequisites — curl/wget, git, Node.js
# ═══════════════════════════════════════════════════════════════════════════════

install_prerequisites() {
  step "Checking prerequisites..."

  # ── curl or wget ──
  if ! command -v curl &>/dev/null; then
    if command -v wget &>/dev/null; then
      info "wget available (curl not found — wget will be used as fallback)"
    else
      warn "Neither curl nor wget found. Installing curl..."
      if is_debian_based; then
        if confirm_sudo "Install curl"; then
          run_privileged apt-get update -qq && run_privileged apt-get install -y -qq curl 2>&1 | tail -3
        fi
      fi
      command -v curl &>/dev/null || fail "curl is required. Install it manually: sudo apt-get install curl"
    fi
  fi

  # ── git ──
  if ! command -v git &>/dev/null; then
    warn "git not found. Installing..."
    case "$OS_ID" in
      kali|ubuntu|debian|pop|linuxmint|raspbian)
        if confirm_sudo "Install git"; then
          run_privileged apt-get update -qq && run_privileged apt-get install -y -qq git 2>&1 | tail -3
          command -v git &>/dev/null || fail "Failed to install git."
          info "git installed"
        else
          fail "git is required. Install: sudo apt-get install -y git"
        fi
        ;;
      fedora)
        if confirm_sudo "Install git"; then
          run_privileged dnf install -y git 2>&1 | tail -3
          info "git installed"
        else
          fail "git is required. Install: sudo dnf install -y git"
        fi
        ;;
      macos)
        # macOS: git ships with Xcode CLI tools
        if ! xcode-select -p &>/dev/null; then
          warn "Xcode Command Line Tools required (provides git)."
          printf "  Installing — a dialog may appear...\n"
          xcode-select --install 2>/dev/null || true
          if is_interactive; then
            printf "  Press Enter after the installation completes: "
            read -r </dev/tty
          fi
        fi
        command -v git &>/dev/null || fail "git not found. Install Xcode CLI tools: xcode-select --install"
        info "git available (Xcode CLI tools)"
        ;;
      *)
        fail "git is required. Please install git for your system."
        ;;
    esac
  else
    info "git $(git --version | sed 's/git version //')"
  fi

  # ── Node.js ──
  install_node_if_needed

  # Verify version after install
  local node_major
  node_major=$(node -v | sed 's/v//' | cut -d. -f1)
  if ! printf '%s' "$node_major" | grep -qE '^[0-9]+$'; then
    fail "Could not parse Node.js version (got: $(node -v)). Reinstall Node.js."
  fi
  if [ "$node_major" -lt "$MIN_NODE" ]; then
    warn "Node.js ${MIN_NODE}+ required (found v${node_major}). Upgrading..."
    install_node_if_needed force
    node_major=$(node -v | sed 's/v//' | cut -d. -f1)
    [ "$node_major" -ge "$MIN_NODE" ] || \
      fail "Node.js ${MIN_NODE}+ required. Found $(node -v). Upgrade manually: https://nodejs.org"
  fi
  info "Node.js $(node -v)"
}

install_node_if_needed() {
  local force="${1:-}"
  if [ -z "$force" ] && command -v node &>/dev/null; then
    return 0
  fi

  case "$OS_ID" in
    kali|ubuntu|debian|pop|linuxmint|raspbian)
      if confirm_sudo "Install Node.js ${MIN_NODE} via NodeSource"; then
        # Ensure prerequisites for NodeSource setup script
        run_privileged apt-get update -qq
        run_privileged apt-get install -y -qq ca-certificates curl gnupg 2>/dev/null || true
        # Run NodeSource setup
        if command -v curl &>/dev/null; then
          curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE}.x" | run_privileged bash - 2>&1 | tail -5
        elif command -v wget &>/dev/null; then
          wget -qO- "https://deb.nodesource.com/setup_${MIN_NODE}.x" | run_privileged bash - 2>&1 | tail -5
        fi
        run_privileged apt-get install -y -qq nodejs || fail "Failed to install Node.js via NodeSource."
        hash -r 2>/dev/null || true
        info "Node.js installed via NodeSource"
      else
        fail "Node.js ${MIN_NODE}+ is required. Install manually:
    curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE}.x | sudo bash -
    sudo apt-get install -y nodejs"
      fi
      ;;
    fedora)
      if confirm_sudo "Install Node.js ${MIN_NODE}"; then
        run_privileged dnf install -y nodejs 2>&1 | tail -3
        hash -r 2>/dev/null || true
        info "Node.js installed via dnf"
      else
        fail "Node.js ${MIN_NODE}+ is required."
      fi
      ;;
    macos)
      if command -v brew &>/dev/null; then
        brew install "node@${MIN_NODE}" 2>&1 | tail -3
        brew link --overwrite "node@${MIN_NODE}" 2>/dev/null || \
          brew link --force "node@${MIN_NODE}" 2>/dev/null || true
        hash -r 2>/dev/null || true
        info "Node.js installed via Homebrew"
      else
        fail "Homebrew required to install Node.js on macOS.
    Install Homebrew first: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
    Then re-run this installer."
      fi
      ;;
    *)
      fail "Please install Node.js ${MIN_NODE}+ manually: https://nodejs.org"
      ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════════════
#  2. pnpm — pinned to major version for reproducibility
# ═══════════════════════════════════════════════════════════════════════════════

install_pnpm() {
  if command -v pnpm &>/dev/null; then
    info "pnpm $(pnpm -v)"
    return 0
  fi

  step "Installing pnpm..."

  # Try corepack first (ships with Node.js 16.9+)
  if command -v corepack &>/dev/null; then
    if corepack enable pnpm 2>/dev/null; then
      hash -r 2>/dev/null || true
      if command -v pnpm &>/dev/null; then
        info "pnpm enabled via corepack"
        return 0
      fi
    fi
  fi

  # Fallback: npm global install with pinned major version
  if npm install -g "pnpm@${PNPM_VERSION}" </dev/null 2>/dev/null; then
    hash -r 2>/dev/null || true
    info "pnpm ${PNPM_VERSION} installed via npm"
    return 0
  fi

  # Last resort: try with elevated privileges
  if [ -n "$SUDO" ]; then
    $SUDO npm install -g "pnpm@${PNPM_VERSION}" </dev/null || \
      fail "Could not install pnpm. Install manually: npm install -g pnpm"
    hash -r 2>/dev/null || true
    info "pnpm ${PNPM_VERSION} installed via npm (elevated)"
  else
    fail "Could not install pnpm. Install manually: npm install -g pnpm"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  3. Clone or update repository
# ═══════════════════════════════════════════════════════════════════════════════

clone_or_update() {
  step "Getting OrionOmega source..."

  if [ -d "$INSTALL_DIR/.git" ]; then
    printf "  Updating existing installation... "
    cd "$INSTALL_DIR"
    git fetch origin main 2>/dev/null || true
    if ! git pull --ff-only origin main 2>/dev/null; then
      warn "Fast-forward pull failed (you may have local changes)."
      printf "    To force update: cd %s && git reset --hard origin/main\n" "$INSTALL_DIR"
      printf "    Continuing with existing code.\n"
    fi
    printf "done\n"
  else
    printf "  Cloning into %s... " "$INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    # Mark for cleanup-on-failure
    PARTIAL_CLONE="$INSTALL_DIR"
    # Shallow clone for speed; fall back to full clone
    if ! git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" </dev/null 2>/dev/null; then
      git clone "$REPO_URL" "$INSTALL_DIR" </dev/null || \
        fail "Failed to clone repository. Check network connectivity and GitHub access."
    fi
    PARTIAL_CLONE=""  # clone succeeded — disable cleanup
    printf "done\n"
    cd "$INSTALL_DIR"
  fi

  [ -f "$INSTALL_DIR/packages/core/package.json" ] || \
    fail "Clone appears incomplete (packages/core/package.json missing). Remove $INSTALL_DIR and retry."

  info "Source ready at $INSTALL_DIR"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  4. Install dependencies and build
# ═══════════════════════════════════════════════════════════════════════════════

build_project() {
  cd "$INSTALL_DIR"

  # Optional clean rebuild — wipe every packages/*/dist before installing so
  # the build cannot inherit stale compiled JS from a previous half-finished
  # run. Triggered by ORIONOMEGA_CLEAN=1 in the installer environment.
  if [ "${ORIONOMEGA_CLEAN:-}" = "1" ]; then
    step "Cleaning previous dist/ directories..."
    rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo 2>/dev/null || true
    info "dist/ directories cleaned"
  fi

  step "Installing dependencies..."
  if ! pnpm install --frozen-lockfile </dev/null 2>/dev/null; then
    warn "Frozen lockfile failed — using regular install (lockfile may be stale)"
    pnpm install </dev/null || fail "Dependency install failed. Run 'cd $INSTALL_DIR && pnpm install' manually."
  fi
  info "Dependencies installed"

  step "Building OrionOmega..."
  # `pnpm build` runs each package's prebuild + build, including the
  # build-info generator that bakes the current commit into dist/. The
  # gateway uses that BUILD_INFO at runtime to detect stale-build mismatches.
  pnpm build </dev/null || fail "Build failed. Run 'cd $INSTALL_DIR && pnpm build' to see errors.
  If a previous run left a partial dist/, retry with: ORIONOMEGA_CLEAN=1 bash install.sh"
  info "Build complete"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  5. Link CLI — create wrapper script and update PATH
# ═══════════════════════════════════════════════════════════════════════════════

link_cli() {
  step "Linking orionomega command..."

  # Remove stale global links
  pnpm unlink -g @orionomega/core 2>/dev/null || true
  npm unlink -g @orionomega/core 2>/dev/null || true

  # Remove old /usr/local/bin symlink if present
  if [ -f /usr/local/bin/orionomega ] || [ -L /usr/local/bin/orionomega ]; then
    if $IS_ROOT; then
      rm -f /usr/local/bin/orionomega 2>/dev/null || true
    elif confirm_sudo "Remove old /usr/local/bin/orionomega symlink"; then
      $SUDO rm -f /usr/local/bin/orionomega 2>/dev/null || true
    else
      rm -f /usr/local/bin/orionomega 2>/dev/null || true
    fi
  fi

  # Create wrapper script
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/orionomega" <<WRAPPER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/packages/core/dist/cli.js" "\$@"
WRAPPER
  chmod +x "$BIN_DIR/orionomega"

  # Add to shell RC
  setup_shell_path

  export PATH="$BIN_DIR:$PATH"
  info "orionomega command ready"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  Shell RC / PATH — works with bash, zsh, and fish
# ═══════════════════════════════════════════════════════════════════════════════

detect_shell_rc() {
  local shell_name="${SHELL:-/bin/bash}"
  case "$shell_name" in
    */zsh)
      if [ "$OS_ID" = "macos" ] && [ -f "$HOME/.zprofile" ]; then
        printf '%s' "$HOME/.zprofile"
      else
        printf '%s' "$HOME/.zshrc"
      fi
      ;;
    */bash)
      if [ "$OS_ID" = "macos" ]; then
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
      else
        printf '%s' "$HOME/.bashrc"
      fi
      ;;
  esac
}

setup_shell_path() {
  local rc
  rc="$(detect_shell_rc)"
  [ -n "$rc" ] || return 0

  # Ensure RC file exists
  mkdir -p "$(dirname "$rc")"
  touch "$rc"

  # Idempotent: skip if already present
  if grep -q 'orionomega/bin' "$rc" 2>/dev/null; then
    return 0
  fi

  case "$rc" in
    *.fish)
      printf '\n# OrionOmega\nset -gx PATH $HOME/.orionomega/bin $PATH\n' >> "$rc"
      ;;
    *)
      printf '\n# OrionOmega\nexport PATH="$HOME/.orionomega/bin:$PATH"\n' >> "$rc"
      ;;
  esac
  info "Added to PATH in $rc"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  6. Custom commands directory
# ═══════════════════════════════════════════════════════════════════════════════

setup_commands() {
  if [ ! -d "$COMMANDS_DIR" ]; then
    mkdir -p "$COMMANDS_DIR"
    if [ -d "$INSTALL_DIR/commands" ]; then
      cp "$INSTALL_DIR/commands/"*.md "$COMMANDS_DIR/" 2>/dev/null || true
    fi
    info "Custom commands directory created at $COMMANDS_DIR"
  else
    info "Custom commands directory exists at $COMMANDS_DIR"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  7. Docker + Hindsight memory system
#  Uses get.docker.com for Linux (not the outdated docker.io package).
#  Uses Colima on macOS (lightweight Docker runtime).
#  Fixes: BSD grep -E for alternation, BSD sed [[:space:]] for \s.
# ═══════════════════════════════════════════════════════════════════════════════

# Check if the docker binary is real Docker Engine (not the unrelated npm package)
is_real_docker() {
  local docker_path
  docker_path="$(command -v docker 2>/dev/null)" || return 1

  # The npm 'docker' package installs to node_modules paths
  # Use grep -E (extended regex) for portable alternation — BSD grep does not
  # support \| in basic regex mode (HIGH-2 fix).
  if echo "$docker_path" | grep -qE "node_modules|/\.?npm"; then
    warn "Found '$docker_path' — this is the npm 'docker' package, NOT Docker Engine."
    printf "    The npm 'docker' package is unrelated to Docker Engine.\n"
    printf "    Install Docker Engine: https://docs.docker.com/engine/install/\n"
    return 1
  fi
  return 0
}

install_docker_linux() {
  # Use the official convenience script instead of the outdated docker.io
  # distribution package (HIGH-4 fix).
  if confirm_sudo "Install Docker via get.docker.com (official script)"; then
    if command -v curl &>/dev/null; then
      curl -fsSL https://get.docker.com | run_privileged sh 2>&1 | tail -5
    elif command -v wget &>/dev/null; then
      wget -qO- https://get.docker.com | run_privileged sh 2>&1 | tail -5
    else
      fail "curl or wget required to install Docker."
    fi
    # Add current user to docker group (skip if root — already has access)
    if ! $IS_ROOT && [ -n "${USER:-}" ]; then
      run_privileged usermod -aG docker "$USER" 2>/dev/null || true
      warn "Added $USER to docker group. You may need to log out and back in."
    fi
    # Enable and start via systemd
    if command -v systemctl &>/dev/null; then
      run_privileged systemctl enable --now docker 2>/dev/null || true
    fi
    hash -r 2>/dev/null || true
    return 0
  fi
  return 1
}

install_docker_macos() {
  if ! command -v brew &>/dev/null; then
    warn "Homebrew not found — cannot auto-install Docker."
    printf "    Install Homebrew: https://brew.sh\n"
    printf "    Then re-run this installer.\n"
    return 1
  fi

  info "Installing Docker CLI and Colima via Homebrew..."
  brew install docker colima 2>&1 | tail -3

  start_colima
}

# Start Colima with an "already running" guard (M3 fix)
start_colima() {
  if ! command -v colima &>/dev/null; then
    return 1
  fi

  # Check if already running before attempting start
  if colima status 2>/dev/null | grep -qi 'running'; then
    info "Colima already running"
    if docker info &>/dev/null; then
      return 0
    fi
  fi

  info "Starting Colima (lightweight Docker runtime)..."
  colima start --cpu 2 --memory 4 2>&1 | tail -3

  if docker info &>/dev/null; then
    info "Docker running via Colima"
    return 0
  fi
  warn "Colima started but Docker not responding. Try: colima restart"
  return 1
}

setup_docker_and_hindsight() {
  step "Hindsight (Memory System)..."

  mkdir -p "$DATA_DIR"

  local docker_ready=false

  # Check for real Docker (not npm package)
  if is_real_docker; then
    if docker info &>/dev/null; then
      info "Docker is running"
      docker_ready=true
    else
      # Docker CLI exists but daemon not running
      if [ "$OS_ID" = "macos" ]; then
        if command -v colima &>/dev/null; then
          start_colima && docker info &>/dev/null && docker_ready=true
        fi
        if [ "$docker_ready" = false ]; then
          install_docker_macos && docker info &>/dev/null && docker_ready=true
        fi
      else
        warn "Docker installed but not running."
        if command -v systemctl &>/dev/null; then
          if confirm_sudo "Start Docker service"; then
            run_privileged systemctl start docker 2>/dev/null || true
            docker info &>/dev/null && docker_ready=true
          fi
        fi
        if [ "$docker_ready" = false ]; then
          printf "    Start Docker and re-run: orionomega setup\n"
        fi
      fi
    fi
  else
    # No real Docker — attempt install
    if [ "$OS_ID" = "macos" ]; then
      install_docker_macos && docker info &>/dev/null && docker_ready=true
    elif is_debian_based; then
      install_docker_linux && docker info &>/dev/null && docker_ready=true
    elif [ "$OS_ID" = "fedora" ]; then
      if confirm_sudo "Install Docker via dnf"; then
        run_privileged dnf install -y docker 2>&1 | tail -3
        run_privileged systemctl enable --now docker 2>/dev/null || true
        docker info &>/dev/null && docker_ready=true
      fi
    else
      warn "Docker not found. Install: https://docs.docker.com/engine/install/"
    fi
  fi

  if [ "$docker_ready" = false ]; then
    warn "Docker not available — Hindsight will not be started."
    printf "    Install Docker and re-run: orionomega setup\n"
    return 0
  fi

  # Pull Hindsight image (idempotent)
  if docker image inspect "$HINDSIGHT_IMAGE" &>/dev/null; then
    info "Hindsight image already available"
  else
    printf "  Pulling Hindsight image (this may take a few minutes)... "
    if docker pull "$HINDSIGHT_IMAGE" 2>&1 | tail -1; then
      info "Hindsight image pulled"
    else
      warn "Failed to pull Hindsight image. Pull manually: docker pull $HINDSIGHT_IMAGE"
    fi
  fi

  # Attempt to start Hindsight if an API key is available
  start_hindsight_if_configured
}

start_hindsight_if_configured() {
  # Already running? Skip.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hindsight$'; then
    info "Hindsight container already running"
    return 0
  fi

  # Image must be available
  if ! docker image inspect "$HINDSIGHT_IMAGE" &>/dev/null; then
    return 0
  fi

  # Resolve API key: env var first, then config file
  local api_key="${ANTHROPIC_API_KEY:-}"
  local config_file="$CONFIG_DIR/config.yaml"

  if [ -z "$api_key" ] && [ -f "$config_file" ]; then
    # POSIX-compatible sed: [[:space:]] instead of \s (HIGH-1 fix for BSD/macOS).
    api_key=$(sed -n '/^models:/,/^[^ ]/{
      /^[[:space:]]*apiKey:/{
        s/.*apiKey:[[:space:]]*//
        s/^["'"'"']//
        s/["'"'"']$//
        s/^[[:space:]]*//
        s/[[:space:]]*$//
        p
        q
      }
    }' "$config_file" 2>/dev/null) || true
  fi

  if [ -n "$api_key" ] && [ "$api_key" != "''" ] && [ "$api_key" != '""' ] && [ ${#api_key} -gt 8 ]; then
    docker stop hindsight 2>/dev/null || true
    docker rm hindsight 2>/dev/null || true
    printf "  Starting Hindsight container... "
    if docker run -d \
      --name hindsight \
      --restart unless-stopped \
      -p 8888:8888 -p 9999:9999 \
      -e "HINDSIGHT_API_LLM_API_KEY=${api_key}" \
      -e "HINDSIGHT_API_LLM_PROVIDER=anthropic" \
      -e "HINDSIGHT_API_LLM_MODEL=claude-haiku-4-5-20251001" \
      -v "${DATA_DIR}:/home/hindsight/.pg0" \
      "$HINDSIGHT_IMAGE" >/dev/null 2>&1; then
      printf "done\n"
      info "Hindsight container started"
      printf "  ${DIM}Hindsight needs 30-60s to initialize on first start.${NC}\n"
    else
      warn "Failed to start Hindsight container. Run: orionomega setup"
    fi
  else
    printf "  ${DIM}No API key found yet. The setup wizard will configure Hindsight.${NC}\n"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  8. Configuration — API keys, model defaults
#  Accepts env vars: ANTHROPIC_API_KEY, GITHUB_TOKEN, ORIONOMEGA_MODEL
#  Prompts interactively if env vars are not set.
# ═══════════════════════════════════════════════════════════════════════════════

setup_configuration() {
  step "Configuration..."

  local config_file="$CONFIG_DIR/config.yaml"
  local default_model="${ORIONOMEGA_MODEL:-claude-haiku-4-5-20251001}"

  # Skip if config already exists (idempotent)
  if [ -f "$config_file" ]; then
    info "Configuration already exists at $config_file"
    return 0
  fi

  local api_key="${ANTHROPIC_API_KEY:-}"

  # Prompt for API key if interactive and not provided via env
  if [ -z "$api_key" ] && is_interactive; then
    printf "\n  ${BOLD}Anthropic API key${NC} (get one at https://console.anthropic.com/)\n"
    printf "  Enter your API key (or press Enter to skip): "
    read -r api_key </dev/tty
  fi

  if [ -n "$api_key" ]; then
    mkdir -p "$CONFIG_DIR"
    cat > "$config_file" <<YAML
# OrionOmega configuration
# Generated by installer. See config.example.yaml for all options.
# Run 'orionomega setup' for interactive reconfiguration.

models:
  provider: anthropic
  apiKey: ${api_key}
  default: ${default_model}
  planner: claude-sonnet-4-20250514
  cheap: ${default_model}
  workers:
    research: ${default_model}
    code: claude-sonnet-4-20250514
    writing: claude-sonnet-4-20250514
    analysis: ${default_model}

gateway:
  port: 8000
  bind: '127.0.0.1'

hindsight:
  url: http://localhost:8888
  defaultBank: default
  retainOnComplete: true
  retainOnError: true

orchestration:
  planFirst: true
  maxRetries: 2
  workerTimeout: 300
  maxSpawnDepth: 3
  checkpointInterval: 30
YAML
    chmod 600 "$config_file"
    info "Configuration written to $config_file (model: $default_model)"
  else
    info "Skipping config — run 'orionomega setup' to configure"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  9. Service setup — systemd (Linux) or launchd (macOS)
#  Skipped only if ORIONOMEGA_NO_SERVICE is set.
# ═══════════════════════════════════════════════════════════════════════════════

setup_service() {
  if [ -n "${ORIONOMEGA_NO_SERVICE:-}" ]; then
    return 0
  fi

  step "Setting up OrionOmega gateway as a background service..."

  case "$OS_ID" in
    kali|ubuntu|debian|pop|linuxmint|fedora|raspbian)
      setup_systemd_service
      ;;
    macos)
      setup_launchd_service
      ;;
    *)
      warn "Service setup not available for $OS. Start manually: orionomega gateway start"
      ;;
  esac
}

setup_systemd_service() {
  local service_file="/etc/systemd/system/orionomega-gateway.service"
  local run_user node_dir

  if $IS_ROOT; then
    run_user="root"
  else
    run_user="${USER:-$(whoami)}"
  fi

  # Get the directory containing the node binary
  node_dir="$(dirname "$(command -v node)")"

  if [ -f "$service_file" ]; then
    info "systemd service already exists at $service_file"
    return 0
  fi

  if ! confirm_sudo "Create systemd service for OrionOmega gateway"; then
    return 0
  fi

  local tmpfile
  tmpfile="$(mktemp)"
  cat > "$tmpfile" <<SERVICE
[Unit]
Description=OrionOmega Gateway
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=${run_user}
Environment=PATH=${BIN_DIR}:${node_dir}:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${HOME}
ExecStart=${BIN_DIR}/orionomega gateway start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

  run_privileged mv "$tmpfile" "$service_file"
  run_privileged chmod 644 "$service_file"
  run_privileged systemctl daemon-reload
  run_privileged systemctl enable orionomega-gateway 2>/dev/null || true
  info "systemd service created: orionomega-gateway"
  printf "    Start:  sudo systemctl start orionomega-gateway\n"
  printf "    Status: sudo systemctl status orionomega-gateway\n"
  printf "    Logs:   sudo journalctl -u orionomega-gateway -f\n"
}

setup_launchd_service() {
  local plist_dir="$HOME/Library/LaunchAgents"
  local plist_file="$plist_dir/com.orionomega.gateway.plist"

  if [ -f "$plist_file" ]; then
    info "launchd service already exists at $plist_file"
    return 0
  fi

  mkdir -p "$plist_dir"
  mkdir -p "$CONFIG_DIR/logs"

  # Detect Homebrew prefix: /opt/homebrew on Apple Silicon, /usr/local on Intel
  local brew_prefix
  brew_prefix="$(brew --prefix 2>/dev/null || echo /usr/local)"

  cat > "$plist_file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.orionomega.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN_DIR}/orionomega</string>
    <string>gateway</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${CONFIG_DIR}/logs/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>${CONFIG_DIR}/logs/gateway.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${BIN_DIR}:${brew_prefix}/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

  info "launchd service created: com.orionomega.gateway"
  printf "    Load:   launchctl load %s\n" "$plist_file"
  printf "    Start:  launchctl start com.orionomega.gateway\n"
  printf "    Status: launchctl list | grep orionomega\n"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  10. Verify installation
# ═══════════════════════════════════════════════════════════════════════════════

verify_installation() {
  step "Verifying installation..."

  if "$BIN_DIR/orionomega" --help >/dev/null 2>&1; then
    info "Installation verified!"
  else
    warn "CLI built but --help check failed. Run 'orionomega doctor' to diagnose."
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
#  11. Summary and setup wizard
# ═══════════════════════════════════════════════════════════════════════════════

print_summary() {
  printf "\n"
  printf "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  printf "  ${BOLD}  Installation complete!${NC}\n"
  printf "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  printf "\n"
  printf "  ${DIM}OS: %s (%s %s)  Arch: %s${NC}\n" "$OS" "$OS_ID" "$OS_VERSION" "$ARCH"
  printf "\n"
  printf "  ${BOLD}Available commands:${NC}\n"
  printf "    ${GREEN}orionomega setup${NC}    Configure API keys, Hindsight, workspace\n"
  printf "    ${GREEN}orionomega tui${NC}      Launch the terminal UI\n"
  printf "    ${GREEN}orionomega doctor${NC}   Check system health\n"
  printf "    ${GREEN}orionomega status${NC}   Show current configuration\n"
  printf "\n"

  if [ -n "$SKIPPED_STEPS" ]; then
    printf "  ${YELLOW}${SYM_WARN}${NC} ${BOLD}Skipped steps (non-interactive):${NC}\n"
    printf "    %s\n" "$SKIPPED_STEPS"
    printf "    Re-run interactively to complete.\n\n"
  fi
}

run_setup_wizard() {
  if is_interactive; then
    printf "  Launching setup wizard...\n\n"
    PATH="$BIN_DIR:$PATH" "$BIN_DIR/orionomega" setup < /dev/tty || true
  else
    printf "  ${DIM}Non-interactive — skipping setup wizard.${NC}\n"
    printf "  Run ${GREEN}orionomega setup${NC} in an interactive terminal to configure.\n"
  fi

  printf "\n"
  printf "  ${BOLD}Restart your terminal or run:${NC}\n"
  printf "    export PATH=\"\$HOME/.orionomega/bin:\$PATH\"\n"
  printf "\n"
}

# ═══════════════════════════════════════════════════════════════════════════════
#  Main — orchestrates all installation steps
# ═══════════════════════════════════════════════════════════════════════════════

main() {
  setup_colors
  print_banner
  detect_os
  detect_privileges

  info "Detected: $OS ($OS_ID $OS_VERSION) on $ARCH"
  if $IS_ROOT; then
    warn "Running as root (common on Kali — no sudo needed)"
  fi

  check_network
  install_prerequisites
  install_pnpm
  clone_or_update
  build_project
  link_cli
  setup_commands
  setup_docker_and_hindsight
  setup_configuration
  setup_service
  verify_installation
  print_summary
  run_setup_wizard
}

main "$@"
