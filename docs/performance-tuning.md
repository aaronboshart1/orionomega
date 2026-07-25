# Performance Tuning Guide

**OrionOmega v0.1.1 — Enterprise Documentation**

---

## Overview

OrionOmega's performance is governed by four primary subsystems:

1. **Memory recall** (in-process lexical index, Redis round-trips)
2. **LLM API calls** (token budgets, model selection)
3. **Orchestration** (worker concurrency, timeouts, batching)
4. **Gateway** (WebSocket event throughput, rate limits)

This guide provides concrete knobs for each subsystem and the trade-offs involved.

---

## Memory Recall Performance

### Where the time actually goes

Recall is **not** a network-bound operation. Records are scored by an
in-process lexical index, so a recall costs CPU and heap, not round trips. Redis
is on the write path and on the boot-time hydration path.

**Do not tune against guesses — real measured numbers for index build time,
heap, and query latency across 10 k / 50 k / 100 k record corpora are recorded
in [memory-architecture-v2.md §8.3](memory-architecture-v2.md#83-measured-result),
together with the two honest caveats about boot time and heap at 100 k.** Those
figures are the basis for every recommendation below.

Two shapes are worth internalising from that table:

- **Query latency grows with corpus size but stays far below the LLM call it
  precedes.** It is not the thing to optimise first.
- **Boot time and heap are the real costs.** A cold index is a `rebuilding`
  health state during which recall under-returns, so on large corpora the thing
  worth attention is hydration, not per-query speed.

---

### Token Budget

`memory.recallBudgetTokens` caps how many tokens of recalled records may enter a
turn. There are **no budget tiers** — the `low`/`mid`/`high` tier caps are gone,
along with the bug where a request for 30 000 tokens was silently clamped to
4 096. The budget you set is the budget honoured, and the assembler clamps
overflow rather than overshooting.

```yaml
memory:
  recallBudgetTokens: 16384   # default
  maxTurnTokens: 128000       # total input ceiling per turn
```

Recall is skipped entirely when the computed budget falls below ~500 tokens —
below that the block is not worth its own overhead.

**Lowering the budget reduces** Anthropic input token cost per turn.
**Lowering the budget costs** recall quality on long-running projects and
anything needing cross-session context.

---

### Hot Window Size

The hot window is always included verbatim (no filtering). Larger windows consume more input tokens unconditionally.

```yaml
memory:
  hotWindowSize: 10   # default: 20
```

**Recommendation:** Keep at 20 for interactive sessions. Reduce to 10 for autonomous mode where messages are more numerous and structured.

Shrinking the window does not lose the messages — they are in Redis, named by
the Memory Map, and retrievable with `memory_read`. It only changes how much is
reproduced word-for-word up front.

---

### Memory Map Budget

`memory.memoryMapTokens` (default 600) bounds the table-of-contents block. This
is a **fixed tax on every request**, so it is capped hard and is O(1) in session
length: past the budget, older segments collapse into coarser super-segments
rather than the list growing.

Lowering it saves tokens on every turn but makes the map coarser, which makes
the agent's `memory_search` / `memory_read` targeting less precise.

---

### Relevance Threshold

`memory.minRelevance` (default 0.15) is the score floor for recalled records.

- **Raise it** to cut recall volume and input cost — at the risk of a
  `NO_RESULTS` on queries that would have matched weakly but usefully.
- **Lower it** to surface more — at the risk of noise crowding out the budget.

Because scoring is deterministic and lexical, the effect of a threshold change
is reproducible: the same query over the same corpus always ranks identically.

---

### Deduplication Threshold

Deduplication uses trigram similarity comparison (O(n²) in the number of
results). Tune via `memory.deduplicationThreshold`:

| Threshold | Behavior |
|-----------|----------|
| `0.95` | Only removes near-exact duplicates (fast) |
| `0.85` | Default — removes strongly similar content |
| `0.70` | Aggressive deduplication (slower, removes more) |

---

### Agent Tool Call Budget

The memory tools are capped per turn: 3 `memory_search`, 2 `memory_read`. These
are correctness guards, not performance knobs — a zero-result search is a
*successful* tool call, so without the cap an agent can search, find nothing,
rephrase, and loop indefinitely while replaying the whole message array each
round. Each `memory_read` is also capped at 30 000 chars.

Raising these caps directly raises worst-case tokens per turn. Treat them as
fixed unless you have measured a specific need.

---

## LLM API Performance

### Model Selection

OrionOmega uses four model slots. Assigning the right model to each slot is the highest-impact performance decision:

| Slot | Config Key | Role | Recommended |
|------|-----------|------|-------------|
| Default | `models.default` | Main agent responses | `claude-sonnet-4-20250514` |
| Planner | `models.planner` | DAG planning | `claude-sonnet-4-20250514` |
| Cheap | `models.cheap` | Intent classification, summaries | `claude-haiku-4-5-20251001` |
| Workers | `models.workers.*` | Task execution | Profile-specific |

```yaml
models:
  default: claude-sonnet-4-20250514
  planner: claude-sonnet-4-20250514
  cheap: claude-haiku-4-5-20251001
  workers:
    research: claude-haiku-4-5-20251001    # Fast reads
    code: claude-sonnet-4-20250514         # Complex edits
    writing: claude-sonnet-4-20250514
    analysis: claude-haiku-4-5-20251001   # Classification
```

**Rule:** Only use Sonnet+ models for roles that require complex reasoning. Haiku is 10–15× cheaper and adequate for classification, summarization, and lookup tasks.

---

### Agent SDK Effort Level

The `agentSdk.effort` setting controls thinking depth for coding-agent workers:

| Level | Latency | Token cost | Use when |
|-------|---------|------------|----------|
| `low` | ~2s | Low | Simple file edits, formatting |
| `medium` | ~5s | Medium | Moderate code changes |
| `high` | ~15s | High | Complex refactoring (default) |
| `max` | ~30s+ | Very high | Architecture-level decisions |

```yaml
agentSdk:
  effort: medium  # Default: high
```

---

### Context Token Budget

Reduce the per-turn token ceiling if you observe high latency from long contexts:

```yaml
# No YAML key — set programmatically:
# maxTurnTokens: 40000  (default: 60000)
# systemPromptTokens: 3000  (default: 4000)
# outputReserveTokens: 2048  (default: 4096)
```

The available recall budget is `maxTurnTokens - systemPromptTokens - outputReserveTokens - hotWindowTokens`. Shrinking the ceiling leaves less room for recalled context.

---

## Orchestration Performance

### Worker Concurrency

OrionOmega executes DAG nodes in parallel when their dependencies are satisfied. The concurrency is bounded by the number of nodes in the ready queue, not by a separate setting. To increase effective parallelism:

1. **Write tasks with explicit parallelism:** "Research three topics simultaneously" results in a 3-node parallel tier.
2. **Reduce `maxSpawnDepth`:** Nested spawns add latency. Default of 3 is rarely needed; most tasks work with depth 1–2.

---

### Worker Timeout

```yaml
orchestration:
  workerTimeout: 300  # Default: 5 minutes
```

Tight timeouts with `maxRetries: 2` mean a stuck worker contributes `workerTimeout × (maxRetries + 1)` of blocking latency. For latency-sensitive workflows, lower the timeout and ensure retry behavior is acceptable:

```yaml
orchestration:
  workerTimeout: 120   # 2 minutes
  maxRetries: 1        # 1 retry only
```

---

### Checkpoint Interval

```yaml
orchestration:
  checkpointInterval: 30  # Default: 30 seconds
```

Checkpoints write to disk. For I/O-sensitive deployments, increase the interval:

```yaml
orchestration:
  checkpointInterval: 60  # Every minute
```

This trades recovery granularity for I/O overhead.

---

### Event Batching

The gateway batches events before flushing to connected clients. Lower intervals increase UI responsiveness at the cost of more frequent I/O:

```yaml
orchestration:
  eventBatching:
    tuiIntervalMs: 100    # TUI (default: 250ms) — faster for interactive use
    webIntervalMs: 500    # Web UI (default: 1000ms)
    immediateTypes: [error, done, finding]  # Always sent without delay
```

Events in `immediateTypes` bypass batching. Add event types that require immediate user notification.

---

## Gateway Performance

### Bind Address

Binding to `127.0.0.1` (loopback) is faster than `0.0.0.0` (all interfaces) because the OS skips routing logic. For production deployments accessed via a reverse proxy on the same machine, keep `bind: '127.0.0.1'`.

---

### Rate Limiting

Rate limits are enforced per-IP in memory. In high-throughput scenarios with many concurrent users behind a NAT, all users share a single IP limit. Configure higher per-IP limits or disable rate limiting when behind a trusted reverse proxy that enforces its own limits:

```typescript
// No YAML key — modify in gateway/src/rate-limit.ts
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 300;  // Default: 120
```

---

### Log Level

The default `info` level is fine for production. `verbose` and `debug` can generate significant log volume from memory operations:

- `verbose`: Logs every recall/retain operation with metadata (useful for debugging memory issues)
- `debug`: Logs individual Redis commands and index activity (very noisy)

```yaml
logging:
  level: info  # For production
  # level: verbose  # For memory debugging
```

**Use targeted grep instead of raising the global level:**
```bash
tail -f ~/.orionomega/logs/orionomega.log | grep -E "(WARN|ERROR)"
```

---

## Redis Performance

Redis backs memory, and OrionOmega does not provision or manage it. There is no
memory server to tune — only Redis itself, and the index built on top of it.

### Eviction policy

If you also run the task queue on Redis (`orchestration.queue.backend: redis`),
that instance **must** be `maxmemory-policy noeviction` or BullMQ silently loses
jobs. The policy is instance-wide; picking a different `db` does not isolate it.

```bash
redis-cli config get maxmemory-policy    # expect: noeviction
```

The memory store bounds its own size rather than relying on eviction — the hot
list is trimmed on every append, oversized content is offloaded to separate
blob keys with their own TTL, and the GC pass deletes expired unpinned records.
An unbounded conversation store is a bug regardless of eviction policy, which is
what makes a single shared instance safe.

If you do hit the conflict, `memory.redis.url` is its own config key — point
memory at a second instance.

### Durability

Durability is AOF `everysec` plus RDB snapshots. `appendfsync always` costs
throughput on the write path for a guarantee this workload does not need;
`appendonly no` risks losing the tail of a session on an unclean shutdown.

### Corpus size

The dominant cost of a large corpus is **index build time and heap at boot**,
not query latency. See
[memory-architecture-v2.md §8.3](memory-architecture-v2.md#83-measured-result)
for the measured figures and the two caveats attached to them. For large
deployments:

1. Keep scopes meaningful — `project-<slug>` rather than one giant scope — so a
   scope purge is a usable operation
2. Let the GC pass run, so expired records leave the corpus instead of
   accumulating
3. Expect a `rebuilding` health state on startup proportional to corpus size,
   during which recall under-returns

---

## Performance Monitoring

### Key Metrics to Watch

| Metric | Location | Alert Threshold |
|--------|----------|----------------|
| Recall effectiveness | Log: `"Memory recall effectiveness checkpoint"` | < 10% |
| Recall duration | Log: `"durationMs"` | > 500ms |
| Memory health | `GET /health` → `system.memory.health` | anything other than `ready` |
| Worker timeout rate | Log: `"Worker timed out"` | > 5% of nodes |
| Session summary failure | Log: `"failed after retries"` | Any occurrence |

### Structured Log Queries

For log aggregation systems (Datadog, Splunk, etc.), key JSON fields:

```
# Memory performance
{ "type": "recall", "durationMs": ?, "resultCount": ?, "effectiveness": ? }

# Worker performance
{ "type": "node_complete", "durationMs": ? }
{ "type": "node_error", "retryCount": ? }

# Session costs
{ "type": "done", "nodesCompleted": ?, "durationMs": ? }
```

Enable JSON log format by setting `ORIONOMEGA_LOG_FORMAT=json` environment variable.
