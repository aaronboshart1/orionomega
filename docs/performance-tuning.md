# Performance Tuning Guide

**OrionOmega v0.1.1 — Enterprise Documentation**

---

## Overview

OrionOmega's performance is governed by four primary subsystems:

1. **Memory recall** (Hindsight round-trips, client-side scoring)
2. **LLM API calls** (token budgets, model selection)
3. **Orchestration** (worker concurrency, timeouts, batching)
4. **Gateway** (WebSocket event throughput, rate limits)

This guide provides concrete knobs for each subsystem and the trade-offs involved.

---

## Memory Recall Performance

### Token Budget Alignment

**Problem:** The previous default `recallBudgetTokens = 30,000` exceeded the Hindsight `high` tier cap (8,192 tokens) by 3.6×. Every request was silently clamped to 8,192, wasting budget calculation.

**Current default (v0.1.1):** `recallBudgetTokens = 8,192` — aligned with the `high` tier cap.

**Tuning the recall budget:**

| Scenario | Recommended `recallBudgetTokens` | `recallBudget` tier |
|----------|----------------------------------|---------------------|
| Short Q&A, quick lookups | 1,024 | `low` |
| Standard workflows | 4,096 | `mid` |
| Deep analysis, complex projects | 8,192 | `high` |

```typescript
const assembler = new ContextAssembler(hs, {
  recallBudgetTokens: 4096,
  recallBudget: 'mid',
});
```

**Lowering the budget reduces:**
- Hindsight API response time (~50–200ms per recall)
- Anthropic input token cost (fewer context tokens per turn)

**Lowering the budget reduces recall quality for:**
- Long-running projects with many memories
- Tasks requiring cross-session context

---

### Hot Window Size

The hot window is always included verbatim (no filtering). Larger windows consume more input tokens unconditionally.

```typescript
const assembler = new ContextAssembler(hs, {
  hotWindowSize: 10,  // Default: 20
});
```

**Recommendation:** Keep at 20 for interactive sessions. Reduce to 10 for autonomous mode where messages are more numerous and structured.

---

### Adaptive Recall (Query Classification)

`adaptiveRecall: true` (default) classifies each user query into one of several types and selects an optimized recall strategy (different budget splits, temporal diversity, relevance thresholds).

For predictable workloads where all queries are similar in nature, disable this to skip the classification overhead:

```typescript
const assembler = new ContextAssembler(hs, {
  adaptiveRecall: false,
});
```

Disabling saves ~1–2ms per turn (the classification is fast, but not free).

---

### Temporal Diversity

`temporalDiversityRatio: 0.15` (default) reserves 15% of the recall budget for memories from older time buckets (14 days, 90 days, 365 days ago). This prevents recent context from monopolizing recall.

For real-time workloads where only recent context matters:

```typescript
const assembler = new ContextAssembler(hs, {
  temporalDiversityRatio: 0.0,  // Disable temporal diversity
});
```

This removes 3 additional Hindsight API calls per recall turn.

---

### Bank Federation

`federateBanks: true` (default) auto-discovers all populated banks and queries them in parallel. This is powerful but costly when many banks exist.

For deployments with many banks and tight latency requirements:

```typescript
const assembler = new ContextAssembler(hs, {
  federateBanks: false,
  additionalBanks: ['core', 'infra'],  // Explicit list instead
});
```

---

### Deduplication Threshold

The deduplication step uses trigram similarity comparison (O(n²) for n results). For high-volume recall, tune the threshold:

| Threshold | Behavior |
|-----------|----------|
| `0.95` | Only removes near-exact duplicates (fast) |
| `0.85` | Default — removes strongly similar content |
| `0.70` | Aggressive deduplication (slower, removes more) |

```typescript
const result = await client.recall('core', query, {
  deduplicationThreshold: 0.90,
});
```

---

### Banks Cache TTL

`HindsightClient` caches the bank list for 60 seconds. If banks are created/deleted frequently (e.g., CI environments with ephemeral project banks), the cache can serve stale data.

The TTL is a compile-time constant (`BANKS_CACHE_TTL_MS = 60_000`). For dynamic environments, call `client.invalidateBanksCache()` after creating or deleting banks.

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
- `debug`: Logs internal HTTP requests to Hindsight (very noisy)

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

## Hindsight Server Performance

OrionOmega's memory performance is bounded by the Hindsight server. Key Hindsight-side configuration:

### Embedding Backend

Without an embedding backend, Hindsight returns `relevance=0` for all results, forcing OrionOmega to use client-side trigram/keyword scoring. Client-side scoring is adequate but less accurate than embedding similarity.

For production deployments with >100 memories per bank, configure an embedding backend in Hindsight to enable native vector search. Consult the Hindsight documentation for setup.

### Bank Size

Hindsight performs full candidate scanning when no embedding index is available. Performance degrades roughly linearly with bank size beyond ~1000 memories. For large deployments:

1. Use per-project banks instead of a single `default` bank
2. Archive old banks periodically (memories older than 90 days contribute less)
3. Enable the Hindsight embedding backend for indexed search

---

## Performance Monitoring

### Key Metrics to Watch

| Metric | Location | Alert Threshold |
|--------|----------|----------------|
| Recall surface rate | Log: `"surfaceRate"` | < 10% (see F13) |
| Recall duration | Log: `"durationMs"` | > 500ms |
| Worker timeout rate | Log: `"Worker timed out"` | > 5% of nodes |
| Session summary failure | Log: `"failed after retries"` | Any occurrence |
| Active ops count | `client.activeOps` | > 10 concurrent |

### Structured Log Queries

For log aggregation systems (Datadog, Splunk, etc.), key JSON fields:

```
# Memory performance
{ "type": "recall", "durationMs": ?, "resultCount": ?, "surfaceRate": ? }

# Worker performance
{ "type": "node_complete", "durationMs": ? }
{ "type": "node_error", "retryCount": ? }

# Session costs
{ "type": "done", "nodesCompleted": ?, "durationMs": ? }
```

Enable JSON log format by setting `ORIONOMEGA_LOG_FORMAT=json` environment variable.
