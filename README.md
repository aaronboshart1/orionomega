<p align="center">
  <h1 align="center">OrionOmega</h1>
  <p align="center"><strong>Small enough to audit. Powerful enough to orchestrate.</strong></p>
  <p align="center">
    A plan-first, graph-based AI agent orchestration engine — built for Claude models, with persistent memory, parallel DAG execution, and an extensible skills system.
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version 0.1.0" />
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
    <img src="https://img.shields.io/badge/TypeScript-5.7+-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22" />
    <img src="https://img.shields.io/badge/Claude-native-d97706?logo=anthropic&logoColor=white" alt="Anthropic Claude" />
    <img src="https://img.shields.io/badge/packages-6-8b5cf6" alt="6 packages" />
  </p>
</p>

---

## Table of Contents

- [Why OrionOmega?](#why-orionomega)
- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [One-liner (Kali, Ubuntu, macOS)](#one-liner-kali-ubuntu-macos)
  - [Manual install](#manual-install)
  - [Environment variables](#environment-variables)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Agent Mode Toggle](#agent-mode-toggle)
- [Architecture](#architecture)
- [Skills](#skills)
- [Web UI](#web-ui)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)
- [Contributing](#contributing)
- [License](#license)

---

## Why OrionOmega?

Most AI agent frameworks grow into monoliths — hundreds of plugins, abstraction layers, and indirect API calls you can't trace. OrionOmega takes the opposite approach:

- **Auditable by default** — ~23k lines across 6 TypeScript packages; you can read the entire codebase in a focused afternoon
- **No hidden execution** — the main agent plans, you approve, workers execute. Nothing runs without your sign-off
- **Persistent memory that works** — [Hindsight](https://github.com/aaronboshart1/hindsight) stores what the agent learns in a temporal knowledge graph, not a flat context window
- **True parallelism** — tasks decompose into a DAG; independent workers run simultaneously, not sequentially
- **Anthropic-native** — built directly on Claude's native `fetch` API, no SDK wrapper overhead

### vs. Typical Agent Frameworks

| | OrionOmega | Typical alternatives |
|---|---|---|
| **Codebase size** | ~6 packages, auditable | Large monorepos, hard to trace |
| **Execution model** | Plan → Approve → Execute | Often fire-and-forget |
| **Memory** | Temporal knowledge graph (Hindsight) | Context window stuffing or flat files |
| **Parallelism** | DAG-based topological sort | Sequential or minimal concurrency |
| **Transparency** | Every tool call, event, and trace visible | Varies widely |
| **Skills/plugins** | Self-contained packages (manifest + handler) | Tightly coupled integrations |
| **AI provider** | Anthropic Claude (native fetch) | Often provider-agnostic (adds abstraction) |
| **Interfaces** | TUI + Web dashboard | Typically one or the other |

---

## Quick Start

```bash
# One-liner installer (Kali Linux, Ubuntu, macOS)
curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash

# Follow the prompts to enter your Anthropic API key, then:
orionomega          # launch the TUI
orionomega ui start # launch the web dashboard at http://localhost:3000
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | 22+ | Installed automatically by the one-liner if missing |
| **pnpm** | 9+ | Installed automatically by the one-liner if missing |
| **git** | Any recent | Required to clone the repo |
| **Anthropic API key** | — | Get one at [console.anthropic.com](https://console.anthropic.com/) |
| **Docker** (optional) | 20+ | Required only for Hindsight memory server |
| **Homebrew** (macOS) | Any | Required on macOS for Node.js and Docker install |

The installer checks all prerequisites and installs missing ones automatically (Node.js via NodeSource on Linux; via `brew` on macOS).

---

## Installation

### One-liner (Kali, Ubuntu, macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
```

Or with wget:
```bash
wget -qO- https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
```

**What the installer does:**

1. Detects your OS (Kali, Ubuntu/Debian, macOS, Fedora/RHEL)
2. Installs missing prerequisites (Node.js 22, pnpm, Docker)
3. Clones the repo to `~/.orionomega/repo` (or updates it if already present)
4. Builds all 6 packages with `pnpm build`
5. Links the `orionomega` CLI to `~/.local/bin` (Linux) or `~/.local/bin` (macOS)
6. Runs the interactive setup wizard to configure your API key
7. Starts Hindsight (memory server) via Docker if Docker is available
8. Creates a systemd service (Linux) or launchd plist (macOS) for the gateway

**Non-interactive install** (for CI or scripted environments):

```bash
ANTHROPIC_API_KEY=sk-ant-... \
ORIONOMEGA_NON_INTERACTIVE=1 \
  bash -c 'curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash'
```

**Private repo install** (with a GitHub token):

```bash
GITHUB_TOKEN=ghp_xxx \
  bash -c 'curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
    https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash'
```

#### Kali Linux specifics

OrionOmega installs cleanly on Kali Linux 2024.x and 2025.x. The installer correctly handles Kali's root-by-default environment:

- Root user detection skips `sudo` calls (Kali ships as root by default)
- Uses the same NodeSource + apt path as Ubuntu/Debian
- Docker CE installs via the official Docker apt repo for Debian

Verified on: Kali 2025.3, x86_64, Node.js 22+

#### Ubuntu specifics

Tested on Ubuntu 22.04 LTS and 24.04 LTS. The installer:

- Installs Node.js 22 via NodeSource (`setup_22.x`)
- Installs Docker CE via the official Docker apt repo
- Creates a systemd service: `orionomega-gateway.service`

To start the gateway at boot:
```bash
sudo systemctl enable orionomega-gateway
```

#### macOS specifics

Tested on macOS 13 (Ventura) and 14 (Sonoma), Intel and Apple Silicon.

- Requires [Homebrew](https://brew.sh/) — the installer will prompt you to install it if missing
- Installs Node.js via `brew install node@22`
- Installs Docker via Colima (`brew install colima docker`)
- Creates a launchd plist at `~/Library/LaunchAgents/com.orionomega.gateway.plist`
- The plist PATH includes `/opt/homebrew/bin` on Apple Silicon and `/usr/local/bin` on Intel

To start the gateway at login:
```bash
launchctl load ~/Library/LaunchAgents/com.orionomega.gateway.plist
launchctl start com.orionomega.gateway
```

---

### Manual install

```bash
# 1. Clone
git clone https://github.com/aaronboshart1/orionomega.git
cd orionomega

# 2. Install dependencies
pnpm install

# 3. Build all packages
pnpm build

# 4. Link the CLI
ln -sf "$(pwd)/packages/core/dist/cli.js" ~/.local/bin/orionomega

# 5. Run setup wizard
orionomega setup

# 6. Start the gateway
orionomega gateway start
```

---

### Environment variables

All config can be provided via environment variables instead of (or in addition to) `config.yaml`. See `.env.example` for the full reference.

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `HINDSIGHT_API_KEY` | No | Auth key for Hindsight, if enabled |
| `CONFIG_PATH` | No | Override config file path |
| `ORIONOMEGA_LOG_LEVEL` | No | `error\|warn\|info\|verbose\|debug` |
| `ORIONOMEGA_NON_INTERACTIVE` | No | Set to `1` to skip all interactive prompts |
| `ORIONOMEGA_RESTART_DELAY` | No | Gateway restart backoff in ms (default: 1000) |
| `GH_TOKEN` | No | GitHub token for the `github` skill |
| `LINEAR_API_KEY` | No | Linear API key for the `linear` skill |

---

## Configuration

Configuration lives at `~/.orionomega/config.yaml`. The file is written with `0o600` permissions (user-readable only).

```yaml
models:
  provider: anthropic
  apiKey: sk-ant-...          # or set ANTHROPIC_API_KEY in your environment
  default: claude-haiku-4-5-20251001
  planner: claude-sonnet-4-6
  workers:
    research: claude-haiku-4-5-20251001
    code: claude-sonnet-4-6
    writing: claude-sonnet-4-6
    analysis: claude-haiku-4-5-20251001

gateway:
  port: 8000
  bind: '127.0.0.1'           # Recommended: restrict to localhost
  auth:
    mode: none                 # Options: none | api-key
    # keyHash: <sha256-of-your-key>  # Required if mode: api-key
  cors:
    origins:
      - 'http://localhost:3000'
      - 'http://localhost:*'

hindsight:
  url: http://localhost:8888
  defaultBank: default
  retainOnComplete: true
  retainOnError: true

orchestration:
  planFirst: true              # always show plan before executing
  autoApprove: false           # set true to skip plan approval
  maxRetries: 2
  workerTimeout: 300           # seconds
  maxSpawnDepth: 3             # max recursive agent depth
  checkpointInterval: 30       # seconds
  defaultAgentMode: orchestrate  # 'orchestrate' | 'direct' — see Agent Mode Toggle

logging:
  level: info                  # error | warn | info | verbose | debug
  file: ~/.orionomega/logs/gateway.log
```

### Hardening for shared machines

If you expose the gateway beyond `127.0.0.1`:

```yaml
gateway:
  bind: '127.0.0.1'           # Never 0.0.0.0 on shared/internet-facing machines
  auth:
    mode: api-key
    keyHash: <sha256-of-your-key>
  cors:
    origins:
      - 'http://localhost:3000'   # exact origins only
```

Generate a keyHash:
```bash
echo -n "your-gateway-key" | sha256sum | awk '{print $1}'
```

See [`docs/getting-started.md`](docs/getting-started.md) for a complete walkthrough of every config option.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `orionomega` | Launch TUI |
| `orionomega ui <cmd>` | Manage web UI: `start \| stop \| restart \| status` |
| `orionomega setup` | Interactive setup wizard |
| `orionomega status` | System health check |
| `orionomega doctor` | Full diagnostics (includes skill health checks) |
| `orionomega gateway start\|stop\|restart` | Manage the gateway daemon |
| `orionomega skill list\|install\|create` | Manage skills |
| `orionomega config` | Edit configuration |
| `orionomega logs` | Tail logs |
| `orionomega update` | Pull latest and rebuild |

**In-session slash commands:**

| Command | Description |
|---------|-------------|
| `/stop` | Stop current orchestration |
| `/status` | Show active workers and task state |
| `/restart` | Restart the gateway |
| `/reset` | Clear session state |
| `/plan` | Show current execution plan |
| `/workers` | List all workers and their status |
| `/mode` | Show current agent mode (`orchestrate` \| `direct`) |
| `/mode direct` | Switch to Direct mode for this session |
| `/mode orchestrate` | Switch to Orchestrate mode for this session |

---

## Agent Mode Toggle

OrionOmega supports two execution modes, switchable per-session or per-message:

| Mode | Description |
|------|-------------|
| **Orchestrate** (default) | Full multi-agent DAG execution — plan → review → parallel workers |
| **Direct** | Bypass orchestration; respond conversationally without planning or worker spawning |

**Switching modes:**

- **Web UI:** Toggle buttons (⚡ Direct / ⎇ Orchestrate) in the chat toolbar, or press **Ctrl+M**
- **Slash command:** `/mode direct` or `/mode orchestrate` (works in both TUI and Web UI)
- **Config default:** Set `orchestration.defaultAgentMode` in `config.yaml`
- **WebSocket API:** Include `"agentMode": "direct"` in any `chat` message for a per-message override

**When to use Direct mode:** questions, quick lookups, single-step tasks, conversational brainstorming.

**When to use Orchestrate mode:** complex multi-file changes, research tasks, automated workflows, anything that benefits from a DAG plan and parallel execution.

Mode is persisted per-session and restored automatically on reconnect. See [`docs/agent-mode.md`](docs/agent-mode.md) for the full reference.

---

## Architecture

```
                              ┌──────────────────┐
                              │    Hindsight      │
                              │  (Memory Graph)   │
                              │  banks · models   │
                              └────────┬─────────┘
                                       │ recall/retain
┌─────────┐     ┌──────────┐ ┌────────┴─────────┐
│  User    │────▶│ TUI/Web  │ │     Gateway      │
│          │◀────│   UI     │◀│   (WS + REST)    │
└─────────┘     └────┬─────┘ └────────┬─────────┘
                     │ WebSocket       │
                     └────────┬────────┘
                              │
                     ┌────────┴─────────┐
                     │    Main Agent     │
                     │   (plans only)    │
                     └────────┬─────────┘
                              │ plan
                     ┌────────┴─────────┐
                     │     Planner       │
                     │  DAG generation   │
                     └────────┬─────────┘
                              │ user approves
                     ┌────────┴─────────┐
                     │     Executor      │
                     │   Kahn toposort   │
                     └───┬────┬────┬────┘
                         │    │    │  parallel
                    ┌────┘    │    └────┐
                    ▼         ▼         ▼
               ┌────────┐┌────────┐┌────────┐
               │Worker A││Worker B││Worker C│
               └───┬────┘└───┬────┘└───┬────┘
                   └─────────┬─────────┘
                             │ events
                        ┌────┴────┐
                        │Event Bus│──▶ TUI / Web UI
                        └─────────┘
```

### Package Map

```
skills-sdk  hindsight
    │           │
    └─────┬─────┘
          ▼
        core
          │
     ┌────┼────┐
     ▼    ▼    ▼
   tui gateway web
```

| Package | Description |
|---------|-------------|
| `@orionomega/core` | Orchestration engine, Anthropic client, config, memory, CLI |
| `@orionomega/gateway` | WebSocket + REST server for TUI and Web UI |
| `@orionomega/hindsight` | Hindsight temporal knowledge graph HTTP client |
| `@orionomega/skills-sdk` | Skill manifest types, loader, validator, executor, scaffolding |
| `@orionomega/tui` | Terminal UI built with Ink (React for CLI) |
| `@orionomega/web` | Next.js 15 dashboard with ReactFlow DAG visualization |

---

## How It Works

1. **Send a message** — describe what you need in natural language
2. **The main agent plans** — produces a DAG of worker nodes with dependencies, models, tools, and estimated cost
3. **You review and approve** — nothing executes until you say so (or you can set auto-approve)
4. **Workers run in parallel** — every tool call, finding, and status update streams to your interface in real-time
5. **Results are aggregated** — summaries, output files, decisions, and findings delivered to you
6. **Memory is retained** — Hindsight stores what was learned for the next session

---

## Skills

Skills are self-contained capability packages that add tools and domain knowledge to workers.

```
my-skill/
├── manifest.json       # Metadata, triggers, tool definitions, dependencies
├── SKILL.md            # Agent-facing documentation (when/how to use this skill)
├── scripts/
│   └── handler.ts      # Tool handler: JSON stdin → JSON stdout
└── prompts/
    └── worker.md       # Optional worker system prompt override
```

### Built-in Skills

| Skill | Description | Auth |
|-------|-------------|------|
| `github` | Full GitHub integration via `gh` CLI | OAuth / PAT |
| `linear` | Linear task management via GraphQL | API key |
| `web-search` | Web search via DuckDuckGo | None |
| `web-fetch` | Fetch any URL as readable text | None |

See [`docs/skills-guide.md`](docs/skills-guide.md) for the full authoring guide.

---

## Web UI

The web dashboard is a split-pane layout:

- **Left panel** — Chat interface for conversing with the main agent
  - **Agent Mode Toggle** — ⚡ Direct / ⎇ Orchestrate buttons in the chat toolbar (Ctrl+M to toggle)
- **Right panel** — Orchestration dashboard with:
  - **DAG visualization** (ReactFlow) — interactive graph, nodes colored by status
  - **Activity feed** — real-time stream of worker events (thinking, tool calls, findings)
  - **Worker detail** — click any node for its full event log, output, and timing
  - **Plan approval** — inline approve/reject/modify controls when a plan is pending

```bash
orionomega ui start    # starts on http://localhost:3000
orionomega ui stop
orionomega ui status
```

---

## Troubleshooting

### `orionomega: command not found`

The CLI binary is in `~/.local/bin`. Add it to your PATH:

```bash
# Add to ~/.bashrc or ~/.zshrc
export PATH="$HOME/.local/bin:$PATH"
source ~/.bashrc   # or source ~/.zshrc
```

### Gateway won't start

```bash
orionomega doctor          # full diagnostics
orionomega gateway status  # check if already running
orionomega logs            # tail gateway logs

# Check if port 8000 is in use:
ss -tlnp | grep 8000   # Linux
lsof -i :8000          # macOS
```

### `doctor` fails API key check

Ensure `ANTHROPIC_API_KEY` is set:

```bash
echo $ANTHROPIC_API_KEY
# If empty:
export ANTHROPIC_API_KEY=sk-ant-...
# Or set it in config.yaml:
orionomega config
```

### Hindsight not connecting

Hindsight runs in Docker. Verify:

```bash
docker ps | grep hindsight     # should show running container
curl http://localhost:8888/health   # should return {"status":"healthy"}

# If not running:
docker start hindsight
# Or re-run the installer to set it up:
orionomega update
```

### Build fails after `pnpm install`

```bash
# Clean and rebuild:
pnpm store prune
pnpm install --force
pnpm build

# Check Node.js version (must be 22+):
node --version
```

### One-liner fails in non-interactive SSH sessions

The installer requires a TTY for interactive prompts. Use one of:

```bash
# Option 1: Allocate a pseudo-TTY
ssh -tt user@host "curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash"

# Option 2: Pass config non-interactively
ssh user@host "ANTHROPIC_API_KEY=sk-ant-... ORIONOMEGA_NON_INTERACTIVE=1 bash -c '
  curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
'"
```

### macOS: `node` not found after install on Apple Silicon

Homebrew on Apple Silicon installs to `/opt/homebrew`. Add it to your PATH:

```bash
echo 'export PATH="/opt/homebrew/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Permission denied on Linux (non-root install)

The installer does not require root. If you see permission errors on system directories, check that `~/.local/bin` is writable and that Docker is accessible:

```bash
groups | grep docker   # must include 'docker'
# If not: sudo usermod -aG docker $USER && newgrp docker
```

### Kali Linux: `apt` lock or mirror errors

```bash
# Release the apt lock if stuck:
sudo rm /var/lib/apt/lists/lock /var/cache/apt/archives/lock /var/lib/dpkg/lock* 2>/dev/null
sudo dpkg --configure -a
sudo apt update

# Then re-run the installer
curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
```

---

## Security Considerations

OrionOmega runs with **exec-level access to your local machine** — this is intentional. The engine executes shell commands, reads and writes files, and calls external APIs on your behalf. Key points:

- **Plan-first by default** — the agent proposes a plan and waits for your approval before executing anything
- **Every action is visible** — tool calls, shell commands, and findings stream to your interface in real-time
- **Credentials are user-scoped** — the process runs as your user; it cannot escalate privileges beyond what your account already has
- **Local-only by default** — the gateway binds to `127.0.0.1:8000`; nothing is exposed to the network without explicit configuration

For full details on the security model, hardening options, and responsible use, see [SECURITY.md](SECURITY.md).

---

## Key Features

- **Graph-based orchestration** — DAG decomposition with topological sorting and parallel execution
- **Plan-first UX** — shows worker count, estimated cost, estimated time, and reasoning before any token is spent on execution
- **Agent Mode Toggle** — switch between full orchestration and direct conversational mode per-session or per-message (Ctrl+M in the Web UI)
- **Hindsight memory** — persistent knowledge graph with banks and mental models, recalled across sessions
- **Dual interface** — TUI (Ink/React for CLI) and Web UI (Next.js with ReactFlow DAG visualization)
- **Full transparency** — see every tool call, thinking trace, finding, and event in real-time
- **Skills system** — extend worker capabilities with self-contained skill packages (manifest + docs + handler scripts)
- **Anthropic-native** — built for Claude models (Haiku, Sonnet, Opus) with native fetch, no SDK overhead
- **Lean footprint** — six focused packages, minimal dependencies
- **Slash commands** — `/stop`, `/status`, `/restart`, `/reset`, `/plan`, `/workers`, `/mode`
- **Secure gateway** — API-key-hashed auth, configurable bind address, CORS allowlist

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+, TypeScript 5.7+ |
| Orchestration | Custom DAG engine (Kahn topological sort) |
| AI | Anthropic Claude (native `fetch`) |
| Memory | Hindsight temporal knowledge graph |
| TUI | Ink (React for CLI) |
| Web UI | Next.js 15, ReactFlow, Zustand, Tailwind CSS |
| Gateway | Native Node.js HTTP + `ws` WebSocket |
| Build | pnpm workspaces, tsx |

---

## Project Structure

```
orionomega/
├── packages/
│   ├── core/           # Config, orchestration engine, Anthropic client, memory, CLI
│   ├── gateway/        # WebSocket + REST server for client connections
│   ├── hindsight/      # Hindsight temporal knowledge graph client
│   ├── tui/            # Terminal UI (Ink/React)
│   ├── web/            # Next.js dashboard with ReactFlow
│   └── skills-sdk/     # Skill manifest, loader, validator, executor, scaffolding
├── default-skills/
│   ├── github/         # GitHub integration via gh CLI
│   ├── linear/         # Linear task management
│   ├── web-fetch/      # URL content fetcher
│   └── web-search/     # DuckDuckGo search
├── docs/
│   ├── architecture.md    # System architecture deep-dive
│   ├── getting-started.md # First-time user guide
│   └── skills-guide.md    # Full skill authoring guide
├── scripts/
│   └── install.sh      # One-line installer download wrapper
├── install.sh          # Main installer (clones, builds, configures)
├── SECURITY.md         # Security model and hardening guide
├── CONTRIBUTING.md     # Development setup and contribution guidelines
└── CHANGELOG.md        # Release history
```

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on code style, commit conventions, and how the packages fit together.

```bash
git clone https://github.com/aaronboshart1/orionomega.git
cd orionomega
pnpm install
pnpm build
pnpm typecheck
```

Read [`docs/architecture.md`](docs/architecture.md) before diving into the orchestration engine.

---

## License

MIT — see [LICENSE](LICENSE) for details.
