# Getting Started

This guide walks you through installing OrionOmega, configuring it, and running your first orchestrated task.

## Prerequisites

- **Linux** — Ubuntu 22.04+, Debian 12+, or any modern distro (macOS and Windows WSL are not yet supported)
- **Node.js 22+** — the installer handles this if missing
- **An Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com/)

Optional:

- **Hindsight** — temporal knowledge graph for persistent memory (the installer can set this up)
- **Rust toolchain** — only needed if you want to build Hindsight from source

## Installation

The one-liner installs OrionOmega to `~/.orionomega/src` and links the CLI globally:

```bash
curl -fsSL https://orionomega.dev/install | bash
```

The installer will:

1. **Preflight check** — verify Linux, architecture (x64/arm64), and permissions
2. **Install Node.js 22** — via NodeSource if not already present
3. **Install pnpm** — for dependency management
4. **Clone the repository** — to `~/.orionomega/src`
5. **Build all packages** — TypeScript compilation across the monorepo
6. **Link the CLI** — `orionomega` command available globally
7. **Optionally install Hindsight** — clone, build (Rust), and set up as a systemd service
8. **Create config directory** — `~/.orionomega/` with default `config.yaml`
9. **Install gateway service** — systemd service for the WebSocket/REST gateway

## Running the Setup Wizard

After installation, run the interactive setup:

```bash
orionomega setup
```

The wizard walks you through:

| Step | What It Does |
|------|--------------|
| **API Key** | Sets your Anthropic API key in the config |
| **Models** | Configures default, planner, and worker models |
| **Gateway** | Sets the port (default 7800) and authentication mode |
| **Hindsight** | Configures the Hindsight URL and default memory bank |
| **Workspace** | Sets the workspace directory path |
| **Skills** | Sets the skills directory and enables auto-loading |

All settings are written to `~/.orionomega/config.yaml`. You can edit this file directly at any time.

## Your First Conversation

Start the TUI:

```bash
orionomega
```

You'll see a terminal interface. Type a simple message:

```
> Hello, what can you do?
```

The agent responds conversationally. For simple questions and direct requests, there's no orchestration overhead — the agent handles them directly.

## Your First Orchestrated Task

Now try something that requires multiple workers:

```
> Research the top 5 static site generators, compare their features, and write a summary report
```

### What Happens

1. **Planning** — the agent analyzes your request and creates an execution plan:

   ```
   📋 Plan: Research Static Site Generators
   
   Workers: 5 (parallel research) + 1 (sequential report writer)
   Estimated cost: $0.12
   Estimated time: ~45 seconds
   
   Worker 1: Research Hugo          [haiku]
   Worker 2: Research Astro         [haiku]
   Worker 3: Research Next.js       [haiku]
   Worker 4: Research Eleventy      [haiku]
   Worker 5: Research Gatsby        [haiku]
   Worker 6: Write comparison report [sonnet] (depends on 1-5)
   
   Approve? [Y]es / [N]o / [M]odify
   ```

2. **Approval** — type `y` to approve, `n` to reject, or `m` to modify

3. **Execution** — workers run in parallel. You see real-time updates:

   ```
   🔧 Worker 1 (Hugo): Searching web for Hugo features...
   🔧 Worker 2 (Astro): Searching web for Astro features...
   💡 Worker 1 (Hugo): Found — Go-based, fastest build times
   ✅ Worker 3 (Next.js): Research complete
   ...
   🔧 Worker 6 (Report): Writing comparison table...
   ✅ All workers complete — report ready
   ```

4. **Results** — the aggregated report is delivered in chat, with output files saved to the workspace

## Understanding the Plan Approval Flow

When `planFirst` is enabled (the default), every multi-step task goes through plan approval:

### The Plan Shows You

- **Worker count** — how many parallel agents will be spawned
- **Dependencies** — which workers depend on others (the DAG structure)
- **Model assignments** — which Claude model each worker uses (Haiku for research/data, Sonnet for writing/code)
- **Estimated cost** — based on expected token usage
- **Estimated time** — based on task complexity and parallelism
- **Reasoning** — why the planner chose this decomposition

### Your Options

| Action | What It Does |
|--------|--------------|
| **Approve** | Execute the plan as-is |
| **Reject** | Cancel — nothing runs |
| **Modify** | Describe changes ("add a worker for X", "use Sonnet for all workers", "merge workers 2 and 3") and the planner regenerates |

### Why This Matters

Plan-first means:

- You never spend tokens on work you didn't want
- You can catch misunderstandings before they cost money
- You control the cost/speed tradeoff (fewer workers = cheaper, more = faster)
- You can see the agent's reasoning and correct it

## Slash Commands

The TUI and Web UI support slash commands for system control:

| Command | Description |
|---------|-------------|
| `/status` | Show system health, active workflows, Hindsight connection |
| `/stop` | Stop the current workflow |
| `/restart` | Restart the current workflow from the last checkpoint |
| `/reset` | Clear the current conversation |
| `/plan` | Show the last plan |
| `/workers` | Show status of all active workers |

## Using the Web UI

Launch the web dashboard:

```bash
orionomega ui
```

This starts the Next.js development server and opens your browser. The web UI provides:

- **Chat panel** (left) — same conversational interface as the TUI
- **DAG visualization** (right) — interactive graph showing the workflow structure, with nodes colored by status
- **Activity feed** — real-time stream of worker events
- **Worker detail** — click any node to inspect its full event log, tool calls, and output

The web UI connects to the gateway over WebSocket and receives events at a higher frequency (200ms batching vs. 500ms in the TUI).

## Customizing Your Agent

### SOUL.md

Create `~/.orionomega/workspace/SOUL.md` to define your agent's personality and tone:

```markdown
# Soul

You are a helpful, concise assistant. You prefer:
- Direct answers over lengthy explanations
- Code examples over prose
- Asking clarifying questions over guessing
```

The agent reads this on every session start.

### USER.md

Create `~/.orionomega/workspace/USER.md` to tell the agent about you:

```markdown
# About Me

- Name: Alex
- Role: Full-stack developer
- Tech stack: TypeScript, React, PostgreSQL
- Timezone: America/New_York
```

This helps the agent tailor responses to your context.

## Configuration Deep Dive

### Models

```yaml
models:
  provider: anthropic
  apiKey: sk-ant-...
  default: claude-sonnet-4-20250514      # Used for direct conversation
  planner: claude-sonnet-4-20250514      # Used for plan generation
  workers:                                # Profile → model mapping
    research: claude-haiku-4-20250514    # Fast, cheap — good for data gathering
    code: claude-sonnet-4-20250514       # Capable — good for writing code
    writing: claude-sonnet-4-20250514    # Capable — good for prose
    analysis: claude-haiku-4-20250514    # Fast — good for data processing
```

**Cost optimization tip:** Haiku is ~10x cheaper than Sonnet. Use it for research and analysis workers; reserve Sonnet for code and writing.

### Orchestration

```yaml
orchestration:
  planFirst: true              # Set to false to skip plan approval (not recommended)
  maxSpawnDepth: 3             # Max nesting depth for agents spawning agents
  workerTimeout: 300           # Kill workers after 5 minutes
  maxRetries: 2                # Retry failed workers up to 2 times
  checkpointInterval: 30       # Save state every 30 seconds (for recovery)
  eventBatching:
    tuiIntervalMs: 500         # TUI receives batched events every 500ms
    webIntervalMs: 200         # Web UI receives events every 200ms
    immediateTypes:            # These event types bypass batching
      - error
      - done
      - finding
```

### Hindsight

```yaml
hindsight:
  url: http://localhost:8888     # Hindsight server URL
  defaultBank: default           # Default memory bank name
  retainOnComplete: true         # Store memories when workflows succeed
  retainOnError: true            # Store memories when workflows fail
```

If Hindsight isn't running, OrionOmega works fine without it — you just won't have cross-session memory.

## Verifying Your Setup

Run the diagnostics tool:

```bash
orionomega doctor
```

This checks:

- Node.js version
- Package build status
- Gateway connectivity
- Hindsight connectivity
- API key validity
- Skills directory and loaded skills
- Config file validity

## Next Steps

- **[Architecture](architecture.md)** — understand how the system works internally
- **[Skills Guide](skills-guide.md)** — build custom skills to extend your agent
- **Install skills** — `orionomega skill install <path>` to add capabilities
- **Explore the API** — the gateway REST endpoints are useful for integrations
- **Set up Hindsight** — if you skipped it during install, persistent memory is worth configuring
