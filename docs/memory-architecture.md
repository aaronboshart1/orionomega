# Memory System Architecture

**OrionOmega v0.1.1 — Enterprise Documentation**

---

## Overview

OrionOmega's memory system provides cross-session persistent context via the Hindsight temporal knowledge graph. Seven coordinated components handle the full memory lifecycle: storage, retrieval, summarization, mental model management, and session continuity.

```
┌─────────────────────────────────────────────────────────────────┐
│                          MemoryBridge                           │
│  (single entry point: init() · flush() · summarize() · recall)  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐
  │ HindsightClient│ │  RetentionEngine │  │ SessionBootstrap│
  │  (HTTP API)  │  │  (event-driven)  │  │  (context load) │
  └──────┬───────┘  └────────┬─────────┘  └────────┬────────┘
         │                   │                     │
         │           ┌───────┴───────┐             │
         │           ▼               ▼             │
         │   ┌──────────────┐ ┌──────────────┐    │
         │   │CompactionFlush│ │SessionSummary│    │
         │   │  (pre-GC)    │ │  (on-close)  │    │
         │   └──────────────┘ └──────────────┘    │
         │                                         │
         └──────────┬──────────────────────────────┘
                    ▼
          ┌──────────────────┐
          │ MentalModelManager│
          │ (synth. context)  │
          └──────────────────┘
```

---

## Components

### 1. HindsightClient (`packages/hindsight/src/client.ts`)

The HTTP client for the Hindsight v0.4.x API. All memory reads and writes go through this class.

**Key methods:**

| Method | Description |
|--------|-------------|
| `retain(bankId, items[])` | Store one or more memory items |
| `retainOne(bankId, content, context)` | Convenience wrapper for a single item |
| `recall(bankId, query, opts?)` | Retrieve relevant memories by natural-language query |
| `recallWithTemporalDiversity(bankId, query, opts?)` | Multi-bucket temporal recall with confidence flag |
| `createBank(bankId, config)` | Create a new isolated memory bank |
| `bankExists(bankId)` | Check bank existence via cached list |
| `listBanksCached()` | Cached bank list (60s TTL) |
| `getMentalModel(bankId, modelId)` | Fetch a pre-synthesized context document |
| `refreshMentalModel(bankId, modelId)` | Trigger a mental model rebuild |
| `health()` | API health check |

**Relevance scoring pipeline:**

When Hindsight returns `relevance=0` for all results (which happens when no embedding backend is configured), the client automatically falls back to client-side scoring via `computeClientRelevance()`:

```
API results (all relevance=0?)
        │ yes
        ▼
computeClientRelevance(query, content)
  = (keywordScore × 0.6 + trigramScore × 0.4) × lengthPenalty
        │
        ▼
Filter at minRelevance=0.15 (capped at CLIENT_FALLBACK_CEILING)
        │
        ▼
Deduplicate by trigram similarity ≥ 0.85
```

**Observable callbacks:**

```typescript
client.onActivity = ({ connected, busy }) => { ... };
client.onIO = ({ op, bank, detail, meta }) => { ... };
```

---

### 2. MemoryBridge (`packages/core/src/agent/memory-bridge.ts`)

The facade that the main agent uses. Encapsulates all 7 memory components behind a clean interface.

**Lifecycle:**

```
init()          → creates all components, bootstraps context, starts retention
                  returns context block string (injected into system prompt)
ensureProjectBank(task) → creates/retrieves a task-scoped bank
recallForPlanning(task) → queries core + project banks for planning context
flush(history)  → pre-compaction dump of conversation to Hindsight
summarize(history) → end-of-session summary via LLM, retained to core bank
storeSessionAnchor(anchor) → saves session boundary state
retainConfigChange(description) → stores self-knowledge about configuration
verifyConsistency() → health + bank existence checks
```

**Mental model seeding (F7):**

On first `init()`, `seedMentalModelsIfNeeded()` probes three models:

| Bank | Model ID | Purpose |
|------|----------|---------|
| `core` | `user-profile` | Persistent user preferences and working style |
| `core` | `session-context` | Cross-session continuity summary |
| `infra` | `infra-map` | Infrastructure topology snapshot |

If a model returns 404 (never created), a `refreshMentalModel()` call seeds it. Subsequent `onRetain` callbacks refresh existing models automatically.

---

### 3. ContextAssembler (`packages/core/src/memory/context-assembler.ts`)

Manages the two-layer context window: **hot window** (last N messages verbatim) + **Hindsight recall** (per-turn budget-aware retrieval).

**Context assembly per turn:**

```
User message arrives
        │
        ▼
classifyQuery(message) → queryType + RecallStrategy
        │
        ├─ external_action? → skip recall
        │
        ▼
Compute available recall budget:
  maxTurnTokens - systemPromptTokens - outputReserve - hotWindowTokens
        │
        ▼
recallFromBanks(query, budget, strategy)
  ├─ conversationBank  (60% of budget, or 85% for short replies)
  ├─ additionalBanks   (remaining budget split evenly)
  └─ federatedBanks    (auto-discovered populated banks)
        │
        ▼
Format as [PRIOR CONTEXT] block with confidence summary
        │
        ▼
AssembledContext { priorContext, hotMessages, estimatedTokens, ... }
```

**Token budget defaults:**

| Parameter | Default | Notes |
|-----------|---------|-------|
| `hotWindowSize` | 20 messages | Ring buffer of recent messages |
| `recallBudgetTokens` | 8,192 | Aligned with Hindsight `high` tier cap |
| `maxTurnTokens` | 60,000 | Total input token budget per turn |
| `systemPromptTokens` | 4,000 | Reserved for system prompt |
| `outputReserveTokens` | 4,096 | Reserved for model output |
| `minRelevance` | 0.15 | Minimum relevance for client-side scoring |
| `temporalDiversityRatio` | 0.15 | Fraction of budget for older memories |

**Disk persistence:**

When `persistPath` is set, the hot window is written to disk as JSON on every push. This survives gateway restarts. The path is typically `~/.orionomega/hot-window.json`.

---

### 4. Similarity Engine (`packages/hindsight/src/similarity.ts`)

Client-side relevance scoring used when the Hindsight embedding backend is not configured.

**Text normalization pipeline:**

1. Lowercase
2. Strip role prefixes: `[user]`, `[assistant]`, `[system]`
3. Strip structural labels: `Task:`, `Workers:`, `Decisions:`, `Findings:`, etc.
4. Strip bracket noise: `[`, `]`
5. Strip fused colons: `context:` → `context`
6. Collapse whitespace

**Scoring formula:**

```
computeClientRelevance(query, content):
  trigramScore  = Jaccard(trigrams(normalize(query)), trigrams(normalize(content)))
  keywordScore  = |{words in query ∩ words in content}| / |words in query|
                  (words > 2 chars, distinct-match counting)
  lengthPenalty = 0.8 if content < 20 chars, else 1.0
  score         = (keywordScore × 0.6 + trigramScore × 0.4) × lengthPenalty
```

**Why these weights:** Keywords provide semantic signal (user mentions `sql` → match `sql` in memories). Trigrams provide structural/spelling overlap. Keywords are weighted higher because recall queries are typically topical.

---

### 5. RetentionEngine (`packages/core/src/memory/retention-engine.ts`)

Event-driven memory writer. Listens on the `EventBus` for workflow events and retains relevant content to Hindsight.

**Retention triggers:**

| Event | Condition | Bank | Context |
|-------|-----------|------|---------|
| `workflow:complete` | `retainOnComplete=true` | project bank | `decision`, `lesson` |
| `workflow:error` | `retainOnError=true` | project bank | `infrastructure` |
| `node:complete` | always | project bank | `node_output` |
| `finding` | always | core + project | `lesson` |

After each successful retention, `onAfterRetain` fires and `MentalModelManager.onRetain()` refreshes the relevant mental model.

---

### 6. SessionSummarizer (`packages/core/src/memory/session-summary.ts`)

Generates and stores a 2–4 sentence session summary using a lightweight LLM call at session end.

**Guards:**
- Minimum 5 messages (skips trivially short sessions)
- 5-minute debounce window (prevents duplicate summaries from rapid disconnect/reconnect storms)
- Up to 3 retry attempts with exponential backoff (500ms, 1000ms, 2000ms) for transient API failures

**Retention targets:**
- `core` bank, context `session_summary` (always)
- Project bank, context `project_update` (if a project bank is active)

---

### 7. CompactionFlush (`packages/core/src/memory/compaction-flush.ts`)

Runs before Anthropic context compaction to prevent information loss. Converts the conversation hot window into structured memory items and retains them to Hindsight.

---

## Memory Bank Design

### Bank Types

| Bank | Created by | Purpose |
|------|-----------|---------|
| `core` | `MemoryBridge.init()` | Cross-session persistent memory: session summaries, user preferences, lessons learned |
| `project-*` | `BankManager.ensureProjectBank()` | Task-scoped memory: node outputs, decisions, artifacts for a specific project |
| `infra` | Manual / `BankManager` | Infrastructure state: topology, deployment history |
| `conv-*` | `ContextAssembler` | Conversation history bank for a specific gateway session |

### Bank Isolation

Banks are namespace-scoped. The namespace is set at `HindsightClient` construction time and defaults to `'default'`. For multi-tenant deployments, set a per-customer namespace.

### Memory Context Categories

| Context | Meaning |
|---------|---------|
| `preference` | User-expressed preferences or working style |
| `decision` | Architectural or implementation decision |
| `lesson` | Lesson learned from a failure or unexpected result |
| `project_update` | High-level project state change |
| `infrastructure` | Infrastructure configuration or state |
| `architecture` | System design choice |
| `codebase` | Codebase structure or conventions |
| `relationship` | Stakeholder or team relationship information |
| `session_summary` | End-of-session LLM summary |
| `node_output` | Output from a completed workflow node |
| `artifact` | File or resource produced by a worker |
| `conversation_user` | User message (stored by ContextAssembler) |
| `conversation_assistant` | Assistant response (stored by ContextAssembler) |

---

## Data Flow: End-to-End

```
1. User sends message
   → ContextAssembler.push(message)
       → retain to Hindsight asynchronously (fire-and-forget)
       → add to hot window ring buffer
       → write hot window to disk (if persistPath set)

2. Agent assembles context for next turn
   → ContextAssembler.assemble(query)
       → classifyQuery() → queryType + RecallStrategy
       → recallFromBanks() → [PRIOR CONTEXT] block
       → returns { priorContext, hotMessages, estimatedTokens }

3. Workflow executes
   → RetentionEngine listens for events
       → retains node outputs, decisions, errors to Hindsight
       → refreshes mental models after each retention

4. Session ends
   → SessionSummarizer.summarize(history)
       → LLM generates 2–4 sentence summary
       → retained to core bank (with retry)
   → SessionBootstrap.storeSessionAnchor(anchor)
       → saves session boundary state for continuity

5. Context compaction triggered
   → MemoryBridge.flush(history)
       → CompactionFlush converts hot window to memory items
       → retains to Hindsight before GC
```

---

## Configuration Reference

All memory options are in `~/.orionomega/config.yaml` under the `hindsight:` section:

```yaml
hindsight:
  url: http://localhost:8888       # Hindsight server URL
  defaultBank: default             # Fallback bank name
  retainOnComplete: true           # Store memories after successful workflows
  retainOnError: true              # Store memories after failed workflows
```

`ContextAssembler` and `MemoryBridge` defaults can be overridden programmatically but have no YAML keys — they are tuned constants. See `context-assembler.ts:88–96` for current defaults.

---

## Embedding Backend

When Hindsight is deployed without an embedding backend (the default for self-hosted v0.4.x), all API `relevance` scores are `0`. The `HindsightClient` detects this condition and activates client-side scoring automatically. No configuration is required.

To enable native embedding-based scoring (recommended for production):

1. Configure an embedding provider in your Hindsight server config.
2. Verify by calling `GET /health` — it should report embedding backend status.
3. Once embeddings are active, the `usedClientRelevance` field in recall logs will be `false`.

---

## Observability

Every memory operation emits a structured log via `onMemoryEvent` and `onIO` callbacks, consumed by the gateway's event bus and forwarded to TUI/Web UI clients.

**Memory event types:**

| `op` | When fired |
|------|-----------|
| `bootstrap` | Subsystem init, bank creation, mental model seeding |
| `retain` | Memory stored |
| `recall` | Memory retrieved |
| `dedup` | Duplicate message skipped |
| `flush` | Pre-compaction flush complete |
| `summary` | Session summary retained |
| `session_anchor` | Session anchor stored |
| `self_knowledge` | Config change retained to self-knowledge bank |

**Recall effectiveness metric (F13):**

After every recall, the client computes:
```
surfaceRate = results_returned / results_from_api
```
If `surfaceRate < 0.10` and the API returned at least one result, a `WARN` log is emitted. Sustained values below 10% indicate a misconfigured threshold or scoring issue.
