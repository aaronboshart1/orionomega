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

## Key Features

- 🧠 **Graph-based orchestration** — DAG decomposition with topological sorting and parallel execution
- 📋 **Plan-first UX** — shows worker count, estimated cost, estimated time, and reasoning before any token is spent on execution
- 💾 **Hindsight memory** — persistent knowledge graph with banks and mental models, recalled across sessions
- 🖥️ **Dual interface** — TUI (Ink/React for CLI) and Web UI (Next.js with ReactFlow DAG visualization)
- 🔍 **Full transparency** — see every tool call, thinking trace, finding, and event in real-time
- 🔌 **Skills system** — extend worker capabilities with self-contained skill packages (manifest + docs + handler scripts)
- 🤖 **Anthropic-native** — built for Claude models (Haiku, Sonnet, Opus) with native fetch, no SDK overhead
- ⚡ **Lean footprint** — six focused packages, minimal dependencies
- 🛠️ **Slash commands** — `/stop`, `/status`, `/restart`, `/reset`, `/plan`, `/workers`
- 🔒 **Secure gateway** — API-key-hashed auth, local-bind-only by default, CORS allowlist

---

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)
- An [Anthropic API key](https://console.anthropic.com/)
- Optional: [Hindsight](https://github.com/aaronboshart1/hindsight) for persistent memory

```bash
# Clone and install
git clone https://github.com/aaronboshart1/orionomega.git
cd orionomega
pnpm install

# Build all packages
pnpm build

# Run the interactive setup wizard
node packages/core/dist/cli.js setup

# Launch the TUI
node packages/core/dist/cli.js

# Or launch the Web UI
node packages/core/dist/cli.js ui start
```

> **One-line installer** (if you have a pre-built release):
> ```bash
> curl -fsSL https://raw.githubusercontent.com/aaronboshart1/orionomega/main/scripts/install.sh | bash
> ```

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

Skills are self-contained capability packages that add tools and domain knowledge to workers. They're how you teach OrionOmega to interact with external services, APIs, or data.

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

### Quick Example: Weather Skill

```json
// manifest.json
{
  "name": "weather",
  "version": "1.0.0",
  "description": "Get weather and forecasts for any location",
  "orionomega": ">=0.1.0",
  "tools": [{
    "name": "get_weather",
    "description": "Get current weather and forecast by lat/lon",
    "inputSchema": {
      "type": "object",
      "properties": {
        "latitude":  { "type": "number" },
        "longitude": { "type": "number" },
        "days":      { "type": "number", "default": 3 }
      },
      "required": ["latitude", "longitude"]
    },
    "handler": "scripts/get-weather.ts",
    "timeout": 15000
  }],
  "triggers": {
    "keywords": ["weather", "temperature", "forecast"],
    "commands": ["/weather"]
  }
}
```

```typescript
// scripts/get-weather.ts
#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';

const { latitude, longitude, days = 3 } = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

const url = new URL('https://api.open-meteo.com/v1/forecast');
url.searchParams.set('latitude', String(latitude));
url.searchParams.set('longitude', String(longitude));
url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m');
url.searchParams.set('forecast_days', String(Math.min(days, 7)));

const res = await fetch(url.toString());
const data = await res.json();
console.log(JSON.stringify({ current: data.current, daily: data.daily }));
```

```bash
# Scaffold, then test directly
orionomega skill create weather
echo '{"latitude": 41.8781, "longitude": -87.6298}' | tsx scripts/get-weather.ts

# Verify it loads
orionomega skill list
```

See [`docs/skills-guide.md`](docs/skills-guide.md) for the full authoring guide, including manifest schema, handler protocol, SKILL.md best practices, auth patterns, and the complete weather skill walkthrough.

---

## Web UI

The web dashboard is a split-pane layout:

- **Left panel** — Chat interface for conversing with the main agent
- **Right panel** — Orchestration dashboard with:
  - **DAG visualization** (ReactFlow) — interactive graph, nodes colored by status
  - **Activity feed** — real-time stream of worker events (thinking, tool calls, findings)
  - **Worker detail** — click any node for its full event log, output, and timing
  - **Plan approval** — inline approve/reject/modify controls when a plan is pending

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `orionomega` | Launch TUI |
| `orionomega ui <cmd>` | Manage web UI: start \| stop \| restart \| status |
| `orionomega setup` | Interactive setup wizard |
| `orionomega status` | System health check |
| `orionomega doctor` | Full diagnostics (includes skill health checks) |
| `orionomega gateway start\|stop\|restart` | Manage the gateway daemon |
| `orionomega skill list\|install\|create` | Manage skills |
| `orionomega config` | Edit configuration |
| `orionomega logs` | Tail logs |
| `orionomega update` | Update to latest |

**In-session slash commands:**

| Command | Description |
|---------|-------------|
| `/stop` | Stop current orchestration |
| `/status` | Show active workers and task state |
| `/restart` | Restart the gateway |
| `/reset` | Clear session state |
| `/plan` | Show current execution plan |
| `/workers` | List all workers and their status |

---

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
  bind: '127.0.0.1'        # local-only by default
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
  maxRetries: 2
  workerTimeout: 300        # seconds
  maxSpawnDepth: 3
  checkpointInterval: 30    # seconds
```

See [`docs/getting-started.md`](docs/getting-started.md) for a complete walkthrough of every option.

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
└── scripts/
    └── install.sh      # One-line installer
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
