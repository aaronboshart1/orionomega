# @orionomega/hindsight

HTTP client for the [Hindsight](https://github.com/aaronboshart1/hindsight) temporal knowledge graph, plus higher-level memory management modules used by OrionOmega.

This package has **zero external dependencies** — it uses the Node.js built-in `fetch` API.

---

## Prerequisites

A running Hindsight server. See the [Hindsight repo](https://github.com/aaronboshart1/hindsight) for setup instructions. The default URL is `http://localhost:8888`.

---

## Core Client

```ts
import { HindsightClient } from '@orionomega/hindsight';

const client = new HindsightClient('http://localhost:8888', 'my-project');

// Store a memory
await client.retainOne('my-bank', 'The user prefers concise answers', 'preference');

// Recall relevant memories
const result = await client.recall('my-bank', 'user communication style');
console.log(result.items); // MemoryItem[]

// Bank management
await client.createBank('my-bank', { name: 'My Project', tuning: {} });
const banks = await client.listBanks();

// Health check
const health = await client.health();
console.log(health.version);
```

### Constructor

```ts
new HindsightClient(
  baseUrl: string,         // e.g. 'http://localhost:8888'
  namespace?: string,      // default: 'default' — isolates banks per project
  apiKey?: string          // falls back to HINDSIGHT_API_KEY env var
)
```

### Key Properties

| Property | Type | Description |
|----------|------|-------------|
| `connected` | `boolean` | `true` after a successful request |
| `activeOps` | `number` | Number of in-flight API requests |
| `onActivity` | callback | Fired when connection or busy state changes |
| `onIO` | callback | Fired for every retain/recall operation |

---

## Memory Management Modules

Higher-level modules used by `@orionomega/core` for session memory:

### BankManager

```ts
import { BankManager } from '@orionomega/hindsight';

const bm = new BankManager(client);
await bm.ensureProjectBank('my-project');
```

### SessionBootstrap

Loads relevant memories at session start:

```ts
import { SessionBootstrap } from '@orionomega/hindsight';

const bootstrap = new SessionBootstrap(client);
const ctx = await bootstrap.bootstrap('session-id-123');
// ctx.memories — recalled items
// ctx.anchor   — session continuity marker
```

### MentalModelManager

Tracks and refreshes high-level mental models about the codebase/project:

```ts
import { MentalModelManager } from '@orionomega/hindsight';

const mgr = new MentalModelManager(client, 'my-project');
await mgr.onRetain(); // refreshes stale models after a retain
const models = mgr.getAll();
```

### SelfKnowledge

```ts
import { SelfKnowledge } from '@orionomega/hindsight';

const sk = new SelfKnowledge(client, config);
await sk.storeObservation('User prefers TypeScript over JavaScript');
```

---

## Similarity Utilities

Exported for use in matching and deduplication:

```ts
import { trigramSimilarity, deduplicateByContent, computeClientRelevance } from '@orionomega/hindsight';

const score = trigramSimilarity('hello world', 'hello there'); // 0–1
const unique = deduplicateByContent(items, 0.9);               // removes near-duplicates
const ranked = computeClientRelevance(query, items);           // relevance-ranked items
```

---

## Directory Layout

```
src/
├── client.ts            # HindsightClient — core HTTP API wrapper
├── bank-manager.ts      # BankManager — bank lifecycle helpers
├── mental-models.ts     # MentalModelManager — high-level model tracking
├── session-bootstrap.ts # SessionBootstrap — session-start memory recall
├── self-knowledge.ts    # SelfKnowledge — agent self-observation storage
├── similarity.ts        # Trigram similarity, deduplication, relevance scoring
├── errors.ts            # HindsightError
├── types.ts             # MemoryItem, BankInfo, RecallOptions, etc.
├── logger.ts            # Lightweight logger (mirrors core/logging pattern)
└── index.ts             # Public API
```

---

## Development

```bash
pnpm --filter @orionomega/hindsight build
```

This package has no `dev` watch script by default. Add one if iterating frequently:
```bash
pnpm --filter @orionomega/hindsight exec tsx --watch src/index.ts
```
