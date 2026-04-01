# @orionomega/core

Orchestration engine, Anthropic API client, configuration system, memory integration, and CLI for OrionOmega.

This is the lowest-level package that all others depend on. It contains no UI or server code.

---

## Key Exports

### Configuration

```ts
import { readConfig, writeConfig, getDefaultConfig, getConfigPath, normalizeBindAddresses } from '@orionomega/core';

const config = readConfig();          // reads ~/.orionomega/config.yaml, merges with defaults
const config = readConfig('/my/path'); // override path
writeConfig(config);                  // writes with 0o600 permissions
```

### Orchestration

```ts
import { Planner, GraphExecutor, EventBus, buildGraph, topologicalSort, validateGraph } from '@orionomega/core';

// Build and validate a graph
const graph = buildGraph(nodes);
const errors = validateGraph(graph.nodes);
const layers = topologicalSort(graph.nodes);

// Execute
const bus = new EventBus();
const executor = new GraphExecutor({ graph, config, eventBus: bus, skills: [] });
bus.subscribe('*', (event) => console.log(event));
await executor.execute();
```

### Logging

```ts
import { createLogger, setGlobalLogLevel, enableFileLogging } from '@orionomega/core';

setGlobalLogLevel('verbose');
enableFileLogging('/path/to/app.log');
const log = createLogger('my-module');

log.error('Unrecoverable failure', { err });     // operation cannot continue
log.warn('Recoverable issue', { detail });        // operation continues, but degraded
log.info('Gateway started', { port: 8000 });      // lifecycle milestone
log.verbose('Tool called', { tool, tokens });     // operational detail
log.debug('Full payload', { payload });           // internal state (dev only)
```

### Agent

```ts
import { MainAgent, buildSystemPrompt } from '@orionomega/core';

const agent = new MainAgent(config, callbacks);
await agent.chat('Analyze my codebase for security issues');
```

### Memory

```ts
import { BankManager, SessionBootstrap, RetentionEngine } from '@orionomega/core';

const bootstrap = new SessionBootstrap(client);
const ctx = await bootstrap.bootstrap('session-id');
```

### Model Discovery

```ts
import { discoverModels, buildModelGuide, pickModelByTier } from '@orionomega/core';

const models = await discoverModels(apiKey);
const model = pickModelByTier(models, 'fast');
```

### Utilities

```ts
import { deepMerge } from '@orionomega/core';

const merged = deepMerge(defaults, overrides); // deep merge with override semantics
```

---

## Directory Layout

```
src/
├── config/           # YAML config loading/writing, schema types, defaults
├── orchestration/    # DAG types, graph utils, EventBus, WorkflowState,
│                     #   WorkerProcess, GraphExecutor, Planner, RecoveryManager
├── anthropic/        # Anthropic API client, agent loop, built-in tools
├── agent/            # MainAgent, system prompt builder, conversation management
├── memory/           # Hindsight integration, recall/retain, session bootstrap
├── logging/          # Structured logger with levels, file output, audit events
├── models/           # Model discovery and selection
├── commands/         # File-based slash command loader
├── utils/            # deep-merge and other shared utilities
└── cli.ts            # orionomega CLI entry point
```

---

## Development

```bash
# From repo root
pnpm --filter @orionomega/core build
pnpm --filter @orionomega/core dev      # tsx --watch

pnpm typecheck                          # full monorepo type check
```

---

## Architecture Notes

- **Planner** converts a natural-language task into a `WorkflowGraph` JSON structure via a Claude API call.
- **GraphExecutor** runs the graph using Kahn's topological sort — nodes whose `dependsOn` are all satisfied run in parallel.
- **Workers** communicate only through `EventBus` events — no direct cross-worker calls. This keeps individual workers testable and the execution log fully reproducible.
- **MainAgent** only plans; it never executes tools directly. Execution is always delegated to workers via the graph.
- `maxSpawnDepth` in the config guards against runaway recursive agent spawning.
