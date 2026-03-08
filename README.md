<p align="center">
  <h1 align="center">OrionOmega</h1>
  <p align="center"><strong>Lightweight AI Agent Orchestration System</strong></p>
  <p align="center">
    A plan-first, graph-based orchestration engine that decomposes complex tasks into parallel worker agents — with full transparency, persistent memory, and dual TUI/Web interfaces.
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version 0.1.0" />
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
    <img src="https://img.shields.io/badge/TypeScript-5.7+-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22" />
  </p>
</p>

---

## What is OrionOmega?

OrionOmega is a graph-based AI agent orchestration system built around a single principle: **the main agent never does work itself**. It plans, you approve, and parallel workers execute. Every task is decomposed into a directed acyclic graph (DAG), giving you full visibility into what will happen before a single token is spent.

The system ships with [Hindsight](https://github.com/aaronboshart1/hindsight) integration — a temporal knowledge graph that gives your agents persistent memory across sessions. Two interfaces (a terminal TUI and a Next.js web dashboard) let you watch orchestration unfold in real-time with DAG visualization, activity feeds, and per-worker detail. Extend capabilities with the built-in skills system — self-contained packages that add tools and domain knowledge to your workers.

## Key Features

- 🧠 **Graph-based orchestration** — DAG decomposition with topological sorting and parallel execution
- 📋 **Plan-first UX** — always shows you the plan (worker count, estimated cost, time, reasoning) before executing
- 💾 **Hindsight memory** — remembers across sessions via a temporal knowledge graph with banks and mental models
- 🖥️ **Dual interface** — TUI (pi-tui, differential rendering) and Web UI (Next.js dashboard with ReactFlow)
- 🔍 **Full transparency** — see every tool call, thinking trace, finding, and event in real-time
- 🔌 **Skills system** — extend capabilities with custom skill packages (manifest + docs + handlers)
- 🤖 **Anthropic-native** — built for Claude models (Haiku, Sonnet, Opus) with native fetch
- ⚡ **Zero bloat** — ships lean with no pre-built skills and no channel plugins
- 🛠️ **Slash commands** — `/stop`, `/status`, `/restart`, `/reset`, `/plan`, `/workers`

## Quick Start

```bash
# Install
curl -fsSL https://orionomega.dev/install | bash

# Configure (interactive wizard — sets API key, Hindsight URL, etc.)
orionomega setup

# Launch TUI
orionomega

# Or launch Web UI
orionomega ui
```

## Architecture

```
                                  ┌──────────────────┐
                                  │    Hindsight      │
                                  │  (Memory Graph)   │
                                  │  banks · models   │
                                  └────────┬─────────┘
                                           │ recall/retain
┌─────────┐     ┌──────────┐     ┌────────┴─────────┐
│  User    │────▶│ TUI/Web  │────▶│     Gateway      │
│          │◀────│   UI     │◀────│   (WS + REST)    │
└─────────┘     └──────────┘     └────────┬─────────┘
                                          │
                                 ┌────────┴─────────┐
                                 │    Main Agent     │
                                 │   (never works)   │
                                 └────────┬─────────┘
                                          │ plan
                                 ┌────────┴─────────┐
                                 │     Planner       │
                                 │  DAG generation   │
                                 └────────┬─────────┘
                                          │ approve
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
                               │         │         │
                               └────┬────┘─────────┘
                                    │ events
                               ┌────┴────┐
                               │Event Bus│──▶ TUI / Web UI
                               └─────────┘
```

## How It Works

1. **You send a message** — describe what you need in natural language
2. **The main agent creates an execution plan** — a DAG of worker nodes with dependencies, models, and tools
3. **You review the plan** — worker count, estimated cost, estimated time, and the planner's reasoning
4. **Approve, modify, or reject** — nothing runs until you say so
5. **Workers execute in parallel** — you see every tool call, finding, and status update in real-time
6. **Results are aggregated and delivered** — output files, summaries, decisions, and findings

## Web UI

The web dashboard is a split-pane layout:

- **Left panel** — Chat interface for conversing with the main agent
- **Right panel** — Orchestration dashboard with:
  - **DAG visualization** (ReactFlow) — interactive graph of the workflow, nodes colored by status (pending/running/done/error)
  - **Activity feed** — real-time stream of worker events (thinking, tool calls, findings)
  - **Worker detail** — click any node to see its full event log, output, and timing
  - **Plan approval** — inline approve/reject/modify controls when a plan is pending

## CLI Commands

| Command | Description |
|---------|-------------|
| `orionomega` | Launch TUI |
| `orionomega ui` | Launch Web UI |
| `orionomega setup` | Interactive setup wizard |
| `orionomega status` | System health check |
| `orionomega doctor` | Full diagnostics |
| `orionomega gateway start\|stop\|restart` | Manage the gateway daemon |
| `orionomega skill list\|install\|create` | Manage skills |
| `orionomega config` | Edit configuration |
| `orionomega logs` | Tail logs |
| `orionomega update` | Update to latest |

## Configuration

Configuration lives at `~/.orionomega/config.yaml`. Key sections:

```yaml
models:
  provider: anthropic
  apiKey: sk-ant-...
  default: claude-sonnet-4-20250514
  planner: claude-sonnet-4-20250514
  workers:
    research: claude-haiku-4-20250514
    code: claude-sonnet-4-20250514
    writing: claude-sonnet-4-20250514
    analysis: claude-haiku-4-20250514

gateway:
  port: 7800
  bind: '127.0.0.1'
  auth:
    mode: api-key
    keyHash: <hashed key>
  cors:
    origins: ['http://localhost:*']

hindsight:
  url: http://localhost:8888
  defaultBank: default
  retainOnComplete: true
  retainOnError: true

orchestration:
  planFirst: true           # always plan before executing
  maxRetries: 2             # retry failed workers up to 2 times
  workerTimeout: 300        # 5 minute timeout per worker
  maxSpawnDepth: 3          # maximum nested agent depth
  checkpointInterval: 30    # checkpoint state every 30s
  eventBatching:
    tuiIntervalMs: 500
    webIntervalMs: 200
    immediateTypes: [error, done, finding]
```

See [`docs/getting-started.md`](docs/getting-started.md) for a walkthrough of every configuration option.

## Skills

Skills are self-contained capability packages that add tools and domain knowledge to workers.

```
my-skill/
├── manifest.json       # Metadata, triggers, tool definitions, dependencies
├── SKILL.md            # Documentation and agent instructions
├── scripts/
│   └── handler.ts      # Tool handler (JSON stdin → JSON stdout)
└── prompts/
    └── worker.md       # Optional worker system prompt
```

```bash
# Scaffold a new skill
orionomega skill create my-skill

# List installed skills
orionomega skill list

# Install a skill from a directory or URL
orionomega skill install ./path/to/skill
```

See [`docs/skills-guide.md`](docs/skills-guide.md) for the full authoring guide.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+, TypeScript 5.7+ |
| Orchestration | Custom DAG engine (Kahn topological sort) |
| AI | Anthropic Claude (native `fetch`, no SDK) |
| Memory | Hindsight temporal knowledge graph |
| TUI | pi-tui (differential rendering, React-like API) |
| Web UI | Next.js 15, ReactFlow, Zustand, Tailwind CSS |
| Gateway | Native Node.js HTTP server + `ws` WebSocket library |
| Build | npm workspaces, tsx |

## Project Structure

```
orionomega/
├── packages/
│   ├── core/           # Config, orchestration engine, Anthropic client, memory, agent, CLI
│   ├── gateway/        # WebSocket + REST server for client connections
│   ├── hindsight/      # Hindsight temporal knowledge graph client library
│   ├── tui/            # Terminal UI built with pi-tui (differential rendering)
│   ├── web/            # Next.js dashboard with ReactFlow DAG visualization
│   └── skills-sdk/     # Skill manifest, loader, validator, executor, and scaffolding
├── scripts/
│   └── install.sh      # One-line installer
├── docs/
│   ├── architecture.md # System architecture deep-dive
│   ├── getting-started.md # First-time user guide
│   └── skills-guide.md # Skill authoring guide
└── package.json        # npm workspace root
```

## Contributing

Contributions are welcome. OrionOmega is structured as an npm workspaces monorepo — each package builds independently with TypeScript.

```bash
# Clone and install
git clone https://github.com/aaronboshart1/orionomega.git
cd orionomega
npm install

# Build everything
npm run build

# Type-check
npm run typecheck

# Run tests
npm test
```

See the [architecture docs](docs/architecture.md) for a system overview before diving in.

## License

MIT — see [LICENSE](LICENSE) for details.
