# Architecture

This document describes the internal architecture of OrionOmega — how the packages fit together, how orchestration works, and how data flows from user input to worker execution and back.

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         OrionOmega                               │
│                                                                  │
│  ┌─────────┐   ┌─────────┐        ┌────────────────────────┐   │
│  │   TUI   │   │   Web   │        │       Hindsight        │   │
│  │  (Ink)  │   │(Next.js)│        │  (Temporal KG Server)  │   │
│  └────┬────┘   └────┬────┘        └───────────┬────────────┘   │
│       │              │                         │                 │
│       └──────┬───────┘          ┌──────────────┘                │
│              │ WebSocket        │ HTTP                           │
│       ┌──────┴───────┐   ┌─────┴──────┐                        │
│       │   Gateway     │   │  Hindsight │                        │
│       │  (WS + REST)  │   │   Client   │                        │
│       └──────┬───────┘   └─────┬──────┘                        │
│              │                  │                                │
│       ┌──────┴──────────────────┴──────┐                        │
│       │             Core               │                        │
│       │  ┌────────┐  ┌────────────┐    │                        │
│       │  │ Agent  │  │   Memory   │    │                        │
│       │  └───┬────┘  └────────────┘    │                        │
│       │      │                         │                        │
│       │  ┌───┴────────────────────┐    │                        │
│       │  │    Orchestration       │    │                        │
│       │  │  Planner → Executor   │    │                        │
│       │  │  Workers → Event Bus  │    │                        │
│       │  └────────────────────────┘    │                        │
│       │                                │                        │
│       │  ┌────────────────────────┐    │                        │
│       │  │     Skills SDK        │    │                        │
│       │  │  Loader · Executor    │    │                        │
│       │  └────────────────────────┘    │                        │
│       └────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────────┘
```

## Package Dependency Graph

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

- **`hindsight`** — standalone HTTP client for the Hindsight temporal knowledge graph. No dependencies on other OrionOmega packages.
- **`skills-sdk`** — skill manifest types, loader, validator, executor, and scaffolding. No dependencies on other packages.
- **`core`** — the heart of the system. Depends on `hindsight` and `skills-sdk`. Contains config, orchestration engine, Anthropic client, memory subsystem, agent logic, and CLI.
- **`gateway`** — WebSocket + REST server. Depends on `core` for types and orchestration access.
- **`tui`** — Ink-based terminal UI. Depends on `core` for types.
- **`web`** — Next.js dashboard. Communicates with `gateway` over WebSocket; no direct package dependency.

## Orchestration Engine

The orchestration engine lives in `packages/core/src/orchestration/` and is the central coordination layer.

### Workflow Graph

Every task is represented as a `WorkflowGraph` — a directed acyclic graph of `WorkflowNode` entries. Each node has:

- **`type`**: `AGENT` | `TOOL` | `ROUTER` | `PARALLEL` | `JOIN`
- **`dependsOn`**: array of node IDs that must complete first
- **`agent`/`tool`/`router`**: type-specific configuration
- **`status`**: runtime state — `pending` → `waiting` → `running` → `done`/`error`/`skipped`

The graph also stores pre-computed `layers` (topologically sorted parallel groups), `entryNodes`, and `exitNodes`.

### Planner (`planner.ts`)

The planner takes a user request and produces a `PlannerOutput`:

```typescript
interface PlannerOutput {
  graph: WorkflowGraph;     // the DAG
  reasoning: string;        // why this decomposition
  estimatedCost: number;    // estimated $ cost
  estimatedTime: number;    // estimated seconds
  summary: string;          // human-readable summary
}
```

The planner uses the model specified by `config.models.planner` (typically Sonnet or Opus). It determines which nodes can run in parallel, assigns models to workers based on the `config.models.workers` profile map, and produces a topologically valid DAG.

When `config.orchestration.planFirst` is `true` (the default), the plan is sent to the user for approval before any execution begins. The user can approve, reject, or modify the plan.

### Executor (`executor.ts`)

Once a plan is approved, the executor:

1. **Topological sort** — computes parallel layers using Kahn's algorithm (`graph.ts`)
2. **Layer-by-layer execution** — for each layer, spawns all nodes in parallel
3. **Dependency resolution** — a node starts only when all `dependsOn` nodes are `done`
4. **State management** — updates `GraphState` after each node transition, checkpoints periodically
5. **Result aggregation** — collects outputs from exit nodes into an `ExecutionResult`

### Workers (`worker.ts`)

Each `AGENT` node spawns a worker — an isolated agent with:

- Its own model (from `AgentConfig.model`)
- A scoped tool set (from `AgentConfig.tools` and loaded skills)
- A system prompt (from `AgentConfig.systemPrompt` or skill-provided `workerPrompt`)
- A timeout (from node config or `config.orchestration.workerTimeout`)

Workers report progress via `WorkerEvent` objects pushed to the Event Bus.

### Node Types (`nodes/`)

| Type | Purpose |
|------|---------|
| `AGENT` | Spawns a worker agent to execute a task |
| `TOOL` | Executes a single tool call directly |
| `ROUTER` | Evaluates a condition and routes to one of several downstream paths |
| `PARALLEL` | Fan-out marker — all children start simultaneously |
| `JOIN` | Fan-in synchronization — waits for all dependencies |

### Recovery (`recovery.ts`)

The recovery system handles:

- **Checkpointing** — serializes `GraphState` at `checkpointInterval` intervals
- **Resume** — on restart, loads the last checkpoint and re-enters the executor loop
- **Retry** — failed nodes are retried up to `maxRetries` times with exponential backoff

### Workflow Lifecycle

```
planning → planned → [user approves] → running → complete
                   → [user rejects]  → stopped
                                      → error (on unrecoverable failure)
                                      → paused (on /stop command)
```

## Event Bus (`event-bus.ts`)

The `EventBus` distributes `WorkerEvent` objects from workers to subscribers (Gateway, TUI, Web).

### Design

- **Ring buffer** — stores the last 1,000 events for late-joining clients
- **Channels** — subscribers register on named channels (e.g., `workflow:<id>`, `worker:<id>`)
- **Throttling** — subscribers can opt into batched delivery with configurable intervals:
  - TUI: `tuiIntervalMs` (default 500ms)
  - Web: `webIntervalMs` (default 200ms)
- **Immediate types** — certain event types bypass throttling: `error`, `done`, `finding`

### Event Types

```typescript
type: 'thinking' | 'tool_call' | 'tool_result' | 'finding' | 'status' | 'error' | 'done'
```

Each event carries the `workerId`, `nodeId`, `timestamp`, human-readable `message`, optional `progress` percentage, and type-specific data (`tool`, `thinking`, `error`, `data`).

## Gateway (`packages/gateway/`)

The gateway is a Node.js HTTP server with WebSocket support. It bridges clients (TUI, Web) to the core orchestration engine.

### WebSocket Protocol

All messages are JSON envelopes.

**Client → Gateway (`ClientMessage`):**

| `type` | Purpose | Key Fields |
|--------|---------|------------|
| `chat` | Send a user message | `content` |
| `command` | Execute a slash command | `command` |
| `plan_response` | Respond to a pending plan | `planId`, `action` (approve/reject/modify), `modification` |
| `subscribe` | Subscribe to workflow events | `workflowId` |

**Gateway → Client (`ServerMessage`):**

| `type` | Purpose | Key Fields |
|--------|---------|------------|
| `text` | Agent response text | `content`, `streaming`, `done` |
| `thinking` | Agent thinking trace | `thinking` |
| `plan` | Pending plan for approval | `plan` |
| `event` | Worker event | `event` |
| `status` | System status update | `status` (health, active workflows, uptime) |
| `command_result` | Slash command result | `commandResult` |
| `error` | Error message | `error` |
| `ack` | Message acknowledgment | — |

### REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check |
| `GET` | `/status` | System status (active workflows, Hindsight connectivity) |
| `GET` | `/workflows` | List workflows |
| `GET` | `/workflows/:id` | Get workflow state |
| `POST` | `/workflows/:id/stop` | Stop a running workflow |

### Authentication

When `auth.mode` is `api-key`, clients must include `Authorization: Bearer <key>` on the WebSocket upgrade request or REST calls. The key is verified against `auth.keyHash`.

### Sessions (`sessions.ts`)

The gateway manages client sessions — tracking connected clients, their types (`tui`/`web`), event delivery mode, and active subscriptions. Reconnecting clients restore their session via a session ID token.

## Memory System (`packages/core/src/memory/`)

The memory system integrates with Hindsight to give agents persistent, queryable memory across sessions.

### Components

| File | Purpose |
|------|---------|
| `bank-manager.ts` | Creates and manages Hindsight memory banks (e.g., `default`, per-project) |
| `retention-engine.ts` | Decides what to retain after events — workflow completions, errors, decisions |
| `mental-models.ts` | Reads and refreshes Hindsight mental models (living summary documents) |
| `session-bootstrap.ts` | On session start, recalls relevant context from Hindsight to prime the agent |
| `session-summary.ts` | On session end, writes a summary back to Hindsight |
| `compaction-flush.ts` | Before context compaction, flushes important information to Hindsight |

### Banks

Memory is organized into **banks** — namespaced collections:

- **`default`** — general agent memory
- Per-project banks — created automatically for project-scoped work

### Retention Triggers

The retention engine automatically stores memories when:

- A workflow completes successfully (`retainOnComplete`)
- A workflow fails (`retainOnError`)
- Key decisions are made during execution
- Notable findings emerge from workers

### Mental Models

Mental models are pre-synthesized context documents maintained by Hindsight. They auto-refresh as new memories are added and provide fast bootstrapping — instead of recalling and synthesizing hundreds of memories, the agent reads a single mental model.

### Session Lifecycle

```
Session Start
  └─▶ session-bootstrap.ts recalls context from Hindsight
       └─▶ Agent runs with primed context
            └─▶ retention-engine.ts stores important events
                 └─▶ session-summary.ts writes summary on end
```

## Skills System (`packages/skills-sdk/`)

Skills are self-contained capability packages that extend what workers can do.

### Architecture

| File | Purpose |
|------|---------|
| `types.ts` | `SkillManifest`, `SkillTool`, `LoadedSkill`, `RegisteredTool`, validation types |
| `loader.ts` | Discovers and loads skills from the skills directory |
| `validator.ts` | Validates manifests and checks dependencies (commands, env vars, services) |
| `executor.ts` | Runs tool handlers — spawns the handler script, passes JSON on stdin, reads JSON from stdout |
| `scaffold.ts` | `orionomega skill create` — generates a skeleton skill directory |

### Manifest Format

Every skill has a `manifest.json`:

```json
{
  "name": "example",
  "version": "1.0.0",
  "description": "An example skill",
  "author": "Your Name",
  "license": "MIT",
  "orionomega": ">=0.1.0",
  "requires": {
    "commands": ["curl"],
    "env": ["EXAMPLE_API_KEY"]
  },
  "tools": [
    {
      "name": "example_lookup",
      "description": "Look up an example",
      "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
      "handler": "scripts/lookup.ts"
    }
  ],
  "triggers": {
    "keywords": ["example", "lookup"],
    "commands": ["/example"]
  }
}
```

### Tool Execution Flow

```
Planner assigns skill to worker
  → Loader finds and validates skill
    → Worker calls tool by name
      → Executor spawns handler script
        → JSON params on stdin
        → JSON result on stdout
      → Result returned to worker
```

### Skill Loading

On startup (when `config.skills.autoLoad` is `true`), the loader:

1. Scans `config.skills.directory` for directories containing `manifest.json`
2. Validates each manifest and checks dependencies
3. Registers tools from valid skills into the tool registry
4. Loads `SKILL.md` and optional `prompts/worker.md` for agent context

Skills can also declare `workerProfile` to specify a preferred model and tool set when the skill runs as an independent worker.
