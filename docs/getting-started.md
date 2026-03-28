# Quick Start Guide

## Prerequisites

- **macOS or Linux** (Ubuntu 22.04+, Debian 12+, Kali, or any modern distro)
- **Node.js 22+**
- **pnpm** (the installer will install it if missing)
- **An Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com/)

Optional:

- **Docker** — required for Hindsight (persistent memory system)

---

## Installation

Run the one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
```

The installer will:

1. Verify Node.js 22+ is installed
2. Install pnpm if missing
3. Clone the repository to `~/.orionomega/src`
4. Install dependencies and build all packages
5. Link the `orionomega` CLI to `~/.orionomega/bin` and add it to your PATH
6. Pull the Hindsight Docker image (if Docker is available)
7. Launch the setup wizard automatically

---

## Setup Wizard

The setup wizard runs automatically after install, or any time with:

```bash
orionomega setup
```

It walks you through each step with a menu you can navigate back and forth:

| Step | Required | What It Configures |
|------|----------|--------------------|
| Anthropic API Key | Yes | Your API key (validated live against the API) |
| Default Model | Yes | Which Claude model to use (recommends a balanced option) |
| Gateway Security | Yes | Authentication mode — API key (password-protected) or none |
| Hindsight Memory | No | Connection to the Hindsight memory system (Docker) |
| Workspace | Yes | Directory for agent identity files (SOUL.md, USER.md) |
| Logging | No | Log level and file path |
| Claude Agent SDK | No | Permissions and token budgets for the Agent SDK |
| Skills | No | Configure integrations (GitHub, Linear, web search, etc.) |
| Web UI | No | Port and bind address for the web dashboard |

All settings are saved to `~/.orionomega/config.yaml`.

After saving, the wizard automatically starts the gateway for you.

---

## CLI Commands

### Service Management

```bash
orionomega gateway start       # Start the gateway (port 8000)
orionomega gateway stop        # Stop the gateway
orionomega gateway restart     # Restart the gateway
orionomega gateway status      # Check gateway status

orionomega ui start            # Start the web UI (port 5000)
orionomega ui stop             # Stop the web UI
orionomega ui restart          # Restart the web UI
orionomega ui status           # Check web UI status

orionomega ui start -p 3000    # Start on a custom port
orionomega ui start -H 0.0.0.0 # Bind to all interfaces
```

### System Health

```bash
orionomega status              # Quick health check (gateway, hindsight, config)
orionomega doctor              # Full diagnostic scan of the entire environment
```

### Configuration

```bash
orionomega config              # Open config.yaml in your $EDITOR
orionomega config get models.default    # Read a specific value (dot-notation)
orionomega config set models.default claude-sonnet-4-20250514  # Set a value
```

### Skills

```bash
orionomega skill list          # List installed skills and their status
orionomega skill setup         # Configure all skills interactively
orionomega skill setup github  # Configure a specific skill
orionomega skill install /path/to/skill  # Install a skill from a directory
orionomega skill create my-skill         # Scaffold a new skill from template
orionomega skill test github   # Run a skill's health check
orionomega skill enable github # Enable a skill
orionomega skill disable github # Disable a skill
```

### Logs

```bash
orionomega logs                # Tail the log file
orionomega logs --level error  # Show only errors
orionomega logs --level debug  # Show debug output
```

### Update and Remove

```bash
orionomega update              # Pull latest code, rebuild, restart services
orionomega remove              # Fully uninstall OrionOmega from this machine
```

### Interfaces

```bash
orionomega                     # Launch the Terminal UI (default)
orionomega tui                 # Same as above — opens the TUI
orionomega ui start            # Start the Web UI
```

---

## Directory Layout

```
~/.orionomega/
├── config.yaml           # All configuration
├── src/                  # Source code (cloned by installer)
├── bin/                  # CLI wrapper script
├── logs/
│   └── orionomega.log    # Application log file
├── gateway.pid           # Gateway process ID (when running)
├── ui.pid                # Web UI process ID (when running)
└── ui.log                # Web UI output log

~/orionomega/             # Workspace (user-facing, no dot)
├── SOUL.md               # Agent personality and behavior
├── USER.md               # Information about you
└── commands/             # Custom slash commands
    ├── summarize.md
    └── review.md
```

---

## Custom Commands

Custom commands are Markdown files in your workspace `commands/` directory. The filename (without `.md`) becomes the slash command name.

### Creating a Command

Create a file at `~/orionomega/commands/summarize.md`:

```markdown
Summarize the following content concisely. Focus on key points and actionable takeaways.
Organize the summary with bullet points.
```

Now you can use `/summarize` followed by your content in the TUI or Web UI. The file's content is sent to the agent as a prompt.

### How Commands Work

- The filename becomes the command: `review.md` → `/review`
- Content is treated as a user prompt — it goes through the full agent pipeline
- Built-in commands (`/status`, `/stop`, `/reset`, etc.) take priority over custom ones
- Commands are loaded at startup — restart the gateway after adding new ones

### Built-in Slash Commands

| Command | Description |
|---------|-------------|
| `/status` | Show system health, active workflows, Hindsight connection |
| `/stop` | Stop the current workflow |
| `/restart` | Restart the current workflow from the last checkpoint |
| `/reset` | Clear the current conversation |
| `/plan` | Show the last plan |
| `/workers` | Show status of all active workers |

---

## Customizing Your Agent

### SOUL.md

Define your agent's personality in `~/orionomega/SOUL.md`:

```markdown
# Soul

You are a direct, no-nonsense assistant. You prefer:
- Short, precise answers
- Code over prose
- Asking one clarifying question rather than guessing
```

### USER.md

Tell the agent about yourself in `~/orionomega/USER.md`:

```markdown
# About Me

- Name: Aaron
- Role: Security engineer
- Stack: Python, TypeScript, Kali Linux
- Timezone: America/Chicago
```

Both files are read at the start of every session.

---

## Where to Find Output

| What | Where |
|------|-------|
| Application logs | `~/.orionomega/logs/orionomega.log` |
| Gateway process output | `orionomega logs` (CLI) |
| Web UI output | `~/.orionomega/ui.log` |
| Agent responses | Displayed in TUI or Web UI chat panel |
| Workflow artifacts | Saved to workspace directory |
| Config | `~/.orionomega/config.yaml` |

---

## Using the Web UI

```bash
orionomega ui start
```

Open your browser to `http://localhost:5000`. The web UI provides:

- **Chat panel** (left) — conversational interface, same as the TUI
- **Orchestration panel** (right) — real-time DAG visualization, worker status, memory feed
- **Settings** — click the gear icon to configure models, gateway, Hindsight, and skills

To access the Web UI from another machine on your network:

```bash
orionomega ui start -H 0.0.0.0
```

Then visit `http://<your-ip>:5000` from any device on the same network.

---

## Updating

```bash
orionomega update
```

This pulls the latest code from GitHub, rebuilds all packages, and restarts the gateway and web UI automatically.

---

## Uninstalling

```bash
orionomega remove
```

This will:

1. Stop the gateway and web UI
2. Remove the global CLI link
3. Remove `~/.orionomega` (config, logs, source)
4. Clean up PATH entries from your shell config

To also remove Hindsight's Docker container and data:

```bash
docker stop hindsight && docker rm hindsight
docker volume rm hindsight_data
docker rmi hindsight
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `orionomega: command not found` | Run `source ~/.zshrc` (or `~/.bashrc`) or open a new terminal |
| Gateway won't start | Run `orionomega doctor` to diagnose |
| Hindsight shows OFFLINE | Check `docker ps` — the container may need restarting |
| Settings won't load in Web UI | Verify gateway is running: `orionomega gateway status` |
| Web UI not accessible from LAN | Start with `-H 0.0.0.0`: `orionomega ui start -H 0.0.0.0` |
| Port already in use | The CLI auto-detects conflicts — it will offer to kill the stale process |

For a full diagnostic:

```bash
orionomega doctor
```

---

## Next Steps

- [Architecture Guide](architecture.md) — how the system works internally
- [Skills Guide](skills-guide.md) — build custom skills to extend your agent
