# Memory System Architecture v2 — Redis-as-Store

**Status:** All design decisions resolved. Ready to implement — start at Phase 1 (§16).
**Supersedes:** [memory-architecture.md](memory-architecture.md) (Hindsight-based).
**Date:** 2026-07-24

---

## 1. Summary

OrionOmega replaces the Hindsight temporal knowledge graph with a self-hosted
Redis-backed memory system built in-repo. Hindsight is removed entirely — the
package, the separate Docker container, the HTTP transport, and every reference
to the name.

The property we are preserving is **not** the current implementation. It is:

> Context is rebuilt from memory on every turn within an explicit token budget.
> There is no conversation compaction and no naive sliding window.

In today's code that property is roughly fifteen lines
([context-assembler.ts:267-275](../packages/core/src/memory/context-assembler.ts:267)).
The surrounding ~750 lines are Hindsight-era accretion and are deleted, not ported.

### Decisions locked

| # | Decision | Rationale |
|---|---|---|
| D1 | **One store: Redis.** No `EmbeddedMemoryStore`. | Two stores double the test matrix for multi-process access that does not exist yet. |
| D2 | **Redis is authoritative.** Durability is AOF `everysec` + RDB. No write-ahead log. | Two durability layers must be reconciled; one does not. |
| D3 | **Status surface reports recall health**, never connectivity. | A Redis outage *is* a degraded state; the user is told what memory can do, not whether a socket is open. |
| D4 | **Rewrite the assembler to the property** (~150 lines). | Halves the port surface and removes provably dead paths. |
| D5 | **Lexical-only retrieval in v1.** Vector channel gated on measurement. | `localEmbedding` has never scored a real memory, and 256 buckets collide ~19×/100-token message. |
| D6 | **One Redis instance**, `noeviction`, store self-bounds. (§15, §19.1) | The eviction conflict only bites `queue.backend: 'redis'` users; the size caps are required either way. |
| D7 | **Delete `LessonsRollup` and `CompactionFlush`.** Keep `SessionSummarizer` behind a flag. (§12.1, §19.2) | Both are workarounds for Hindsight-era costs. `CompactionFlush` has never run. |
| D8 | **Redact `tool_result` secrets in place; never drop the record.** (§15, §19.4) | Dropping punches holes in `memory_read`'s contiguous-span contract. |
| D9 | **Breaking release, fresh install only.** No migration, no aliases, no back-compat reads. (§16) | Limited test audience with no consequential data. |

### What D2 buys us

Making Redis authoritative — rather than a hot cache in front of a JSONL log —
dissolves five problems at once: the `seq` allocation authority is unambiguous
(Redis `INCR`), there is no dual-write reconciliation, no torn-append recovery,
no two-writer race on a shared log file, and **deletion is implementable** (an
append-only log cannot forget). JSONL survives only as an offline
import/export format, never on the write path.

---

## 2. Goals and non-goals

### Goals

- Preserve budgeted per-turn context assembly with no compaction.
- Auto-load recent messages verbatim, like a conventional context window.
- Give the agent an **index of what else exists**, so it knows to reach for the tool.
- Expose memory to the agent as tools.
- Deterministic, LLM-free retrieval scoring.
- Self-hosted, no third-party service.

### Non-goals for v1

- Semantic (synonym-capturing) recall. v1 is lexical. See §7.
- Server-side LLM synthesis (Hindsight's mental models, reflect) — deleted, not replaced.
- Multi-tenant or multi-user isolation.
- Horizontal scale beyond a single Redis instance.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      ContextAssembler                        │
│   hot window · budget math · Memory Map · [PRIOR CONTEXT]    │
│                        (~150 lines)                          │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                       RankingLayer                           │
│  computeClientRelevance · dedupe · TTL filter · budget fill  │
│         ONE implementation — never duplicated per backend    │
└───────────────────────────┬──────────────────────────────────┘
                            │  candidates(query, limit)
┌───────────────────────────▼──────────────────────────────────┐
│                       MemoryStore                            │
│         RedisMemoryStore — candidate generation only         │
└──────┬─────────────────────────────────┬─────────────────────┘
       │                                 │
┌──────▼──────────────┐          ┌───────▼─────────────────────┐
│  InProcessIndex     │          │        Redis                │
│  word postings      │◄─ boot ──│  om:msg · om:seg · om:terms │
│  trigram postings   │  scan    │  AOF everysec + RDB         │
│  (derived, rebuild) │          │  (authoritative)            │
└─────────────────────┘          └─────────────────────────────┘
```

**The critical invariant: the store generates candidates, the ranking layer
ranks.** Ranking is never implemented twice. This is what makes a future
RediSearch swap a pure candidate-generation change.

---

## 4. Record model

Two record classes. Conflating them was a design error caught in review.

### 4.1 Message records

Conversation turns. Ordered by `seq`, addressable by range.

```ts
interface MessageRecord {
  seq: number;              // Redis INCR, monotonic per session
  sid: string;              // session id
  scope: string;            // 'core' | 'project-<slug>' | 'infra'  (replaces banks)
  role: 'user' | 'assistant' | 'system';
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  context: string;          // SEE §4.3 — NOT the same axis as `kind`
  content: string | ContentBlock[];
  ts: string;               // ISO 8601
  tokens: number;           // estimateTokens() at write time
  hash: string;             // content fingerprint, for dedup
  indexed: 0 | 1;           // in the search corpus?
  blob?: string;            // pointer to om:blob:<id> when content > 8 KB
}
```

### 4.2 Document records

Non-message memories: session summaries, run artifacts, lessons, coding-run
records, config changes. These are written by `RetentionEngine`,
`CompactionFlush`, `SessionSummarizer`, and `RunArtifactCollector` — **all of
which are writers the original design overlooked.** They carry a stable
`document_id` used as an idempotent upsert key, which the monotonic `seq`
scheme cannot provide.

```ts
interface DocumentRecord {
  document_id: string;      // stable upsert key
  scope: string;
  context: string;
  content: string;
  ts: string;
  tags: string[];
  importance?: number;      // [0,1], clamped
  indexed: 0 | 1;
}
```

### 4.3 `context` is a first-class field

`context` is **not** `kind` and **not** `scope`. It is the memory category, and
it is load-bearing in three places that will silently break if dropped:

1. **TTL filtering** — `isMemoryExpired(r.context, r.timestamp)` filters every
   recalled item ([context-assembler.ts:663](../packages/core/src/memory/context-assembler.ts:663)),
   keyed on `DEFAULT_CATEGORY_TTL` ([retention-engine.ts:67](../packages/core/src/memory/retention-engine.ts:67)).
2. **Output format** — `context === 'observation'` selects the
   `[OBSERVATION, confidence: X.XX]` prefix; everything else gets
   `[confidence: X.XX] [ctx]`. Both strings are asserted verbatim by
   `context-assembler-observations.test.ts`.
3. ~~**Sort order** — observations are ordered separately from other categories.~~
   **CORRECTED (Phase 4).** This overstated the case. Observations were
   *Hindsight-generated* — produced by its server-side reflection engine, never
   written by OrionOmega. Verified: `'observation'` appears in this codebase
   only as a read-side `types:` filter, in no write path at all. With Hindsight
   removed, nothing produces the category, so prioritising it sorts an empty
   set. Recall now orders strictly by descending relevance, which is the
   principled ordering once `observation` is one `context` string among many
   rather than a distinct fact class. Points 1 and 2 stand.

Candidates returned by the store **must** carry `context` and `ts`, not just
`content` — the ranking layer cannot apply the TTL filter otherwise.

### 4.4 Indexing policy

Everything is stored. Not everything is indexed.

| `kind` | Stored | Indexed | Rationale |
|---|---|---|---|
| `user`, `assistant` | yes | yes | the search corpus |
| `system` | yes | no | boilerplate, pollutes IDF |
| `tool_use` | yes | yes | short, names the action |
| `tool_result` | yes | **no** | volume driver; reachable by range read |

`tool_result` exclusion is deliberate and must be documented in the tool
description, so the agent knows `memory_search` will not find file contents but
`memory_read` will.

---

## 5. Redis schema

All keys namespaced `om:`. Configurable `keyPrefix` for instances shared with
BullMQ.

| Key | Type | Contents |
|---|---|---|
| `om:msg:{sid}:{seq}` | HASH | `MessageRecord` fields |
| `om:doc:{scope}:{document_id}` | HASH | `DocumentRecord` fields |
| `om:seq:{sid}` | STRING | `INCR` ordering counter (Redis is the authority) |
| `om:hot:{sid}` | LIST | recent seq ids; `LPUSH` + `LTRIM` to bound |
| `om:seg:{sid}:{n}` | HASH | segment digest: `from`, `to`, `openedAt`, `closedAt`, `label`, `terms` |
| `om:terms:{scope}` | ZSET | term → weight, **scope-wide** (cross-session) |
| `om:terms:{sid}` | ZSET | term → weight, session-local |
| `om:sessions` | ZSET | sid → `lastActiveAt` |
| `om:scopes` | SET | known scopes (replaces `listBanksCached`) |
| `om:pin:{scope}` | HASH | pinned facts, always loaded, exempt from TTL |
| `om:blob:{id}` | STRING | content > 8 KB, offloaded |

A single append is one pipelined `MULTI`: `INCR` + `HSET` + `LPUSH` + `LTRIM` +
`ZADD` + `ZINCRBY`. One round trip.

---

## 6. Retrieval pipeline

```
query
  └─> store.candidates(q, limit)         ← term + trigram postings intersection
       └─> rank: computeClientRelevance   ← unchanged from today
            └─> TTL filter (isMemoryExpired, advisory)
                 └─> deduplicateByContent (threshold 0.85)
                      └─> budget fill → [PRIOR CONTEXT]
```

### 6.1 The equivalence property, stated correctly

The original claim — that a candidate/rank split yields "identical final
ordering" — was **false as stated**. Today's scorer is
`keywordScore × 0.6 + trigramScore × 0.4`
([similarity.ts:207](../packages/hindsight/src/similarity.ts:207)), and the
trigram channel is Jaccard over 3-grams of the whole normalized string. It is
not decomposable into word postings, and it awards non-zero score to documents
sharing **no** word with the query.

The property we can hold and must test:

> For a seeded corpus and query set, `candidates(q) ⊇ { d : computeClientRelevance(q, d) ≥ minRelevance }`
> at the lowest `minRelevance` any caller uses.

To make that true, the index carries **both** word postings and character-trigram
postings. The ranker is unchanged, so ranking behaviour is bit-identical to
today's production fallback path.

There is an existing template for exactly this test:
[`dedup-prefilter.test.ts:20-72`](../packages/hindsight/src/__tests__/dedup-prefilter.test.ts:20)
asserts a bloom + size-blocked prefilter is byte-for-byte identical to naive
O(n²) on a seeded random corpus. Clone it.

### 6.2 Budget arithmetic — a live bug to fix, not reproduce

Production constructs the assembler with `recallBudgetTokens: 30_000`,
`maxTurnTokens: 60_000` ([main-agent.ts:436](../packages/core/src/agent/main-agent.ts:436)).
But `recallWithTemporalDiversity` clamps to `BUDGET_TIER_MAX_TOKENS.mid = 4096`.
**Today's system silently discards ~80% of the requested budget** and delivers
≤ ~8 K tokens of recall where 30 K was asked for.

A `MemoryStore` that honours `maxTokens` literally — the obvious, correct-looking
implementation — returns 30 K tokens, and `assemble()` has no overflow handling.
Two consequences:

1. Remove the tier cap deliberately **and** add overflow clamping to `assemble()`.
2. Fix the truncation ratio mismatch: `smartTruncate` hard-truncates at
   `maxTokens × 3.5` chars while `estimateTokens` uses 3.2 for code-like text
   ([similarity.ts:51-58](../packages/hindsight/src/similarity.ts:51)). Recalled
   context is code-heavy, so truncated output can measure ~9% *over* budget.
   Either share the ratio or re-measure after truncating.

Add a regression test using the **production** numbers (60 K / 30 K / 15 K /
4 096, two scopes). No existing test exercises them.

---

## 7. The vector channel (deferred, gated)

`localEmbedding` is not shipping in v1.

**Why:** it is unreachable in production today. `computeHybridRelevance` runs
only when an `embeddingProvider` is set, and that is assigned in exactly four
places, all inside `hybrid-recall.test.ts`. It has never scored a real memory.
Separately, at `DEFAULT_EMBEDDING_DIMS = 256`, a 100-distinct-token message
expects `C(100,2)/256 ≈ 19` colliding pairs — far too lossy for
message-length documents.

**Gate for adding it later** — all three, as go/no-go, not as a report:

1. Raise dimensions to ≥ 2^14 with **sparse** storage (not a dense 256-byte row).
2. Measure hash collision rate on a real corpus.
3. Measure top-K overlap against the current Hindsight recall path in shadow mode.

Until then the system is lexical-only and the docs say so plainly.

---

## 8. In-process index

Derived state. Rebuilt at boot by scanning Redis; incrementally updated on append.

Three retrieval paths, all load-bearing — each one's removal is caught by the
§18 merge gate (verified by negative control, see §8.1):

1. **Word postings** — term → ids. Covers every document with `keyword > 0`.
2. **Trigram overlap** — covers `keyword == 0` documents whose trigram Jaccard
   alone clears the threshold. Admits on `I ≥ τ(|A|+|B|)/(1+τ)` where
   `τ = θ/0.4`, computed with `lengthPenalty = 1` so τ is the smallest — and
   therefore most permissive — admissible bound.
3. **Exact short-form** — documents whose normalised form is < 3 chars have an
   EMPTY trigram set but still score 1.0 via the scorer's equality
   short-circuit. Normalised `"ab"` scores 0.32 against query `"ab"`, above a
   0.15 threshold. Without this path they are silently unreachable.

Implemented in `packages/core/src/memory/memory-index.ts`.

### 8.1 MEASURED performance — the first implementation does not scale

⚠️ **The estimates previously in this section (~60–100 MB, 2–4 s boot, single-digit
ms queries) were wrong by roughly an order of magnitude.** Measured on a realistic
corpus (6 000-term Zipf vocabulary, 20–200 words per document):

| Corpus | Build | Heap | Query mean / worst | Candidates returned |
|---|---|---|---|---|
| 10 000 | 3.8 s | +287 MB | 9.5 / 13.2 ms | 45% of corpus |
| 50 000 | 22.5 s | +1 113 MB | 53.8 / 81.5 ms | 63% of corpus |

Extrapolated to 100 000 records that is roughly **2 GB of heap and a ~45 s boot** —
disqualifying for a desktop tool, and far short of the "comfortable to ~300–500 k
records" claim in §6.

The correctness gate passes at every threshold, and negative controls confirm it
binds: disabling the trigram path fails 6 tests, the short-form path 7, the word
path 8. The index is *correct*. It does not *scale*.

**Two independent root causes:**

- **Memory: `Map<string, Set<number>>` postings.** A ~100-word document yields
  several hundred distinct trigrams; at 50 k documents that is ~20 M posting
  entries, and a JS `Set` costs tens of bytes per element. Trigram postings, not
  word postings, dominate.
- **Pruning: Zipf-distributed vocabulary.** Common terms appear in most
  documents, so any query containing one pulls in most of the corpus through the
  word path. This is normal inverted-index behaviour, but it invalidates the
  "prefilter to ~2–5 k candidates" premise in §6 — the ranking layer would be
  scoring 30 k documents per turn.

### 8.2 The fix as implemented — the index scores, and postings are packed

The Bloom-bitset proposal previously in this section was **abandoned as
unsound**, and the reasoning is worth recording so nobody re-proposes it:

> The cheap form — `popcount(queryBits & docBits)` — is *not* a valid bound on
> trigram overlap. Two distinct shared trigrams can collide to the same bit, so
> the popcount **under**-counts, making it a lower bound. Filtering on a lower
> bound drops documents that should have been admitted, breaking the guarantee.
> The sound form (testing each query trigram's bits individually) costs `|A|`
> membership tests per document, which defeats the point.

Two changes were made instead.

**1. The index computes the score itself.** It already holds every input the
scorer needs — distinct keyword hits, `|Q|`, trigram overlap `I`, `|A|`, `|B|`,
and normalised length — so it evaluates `computeClientRelevance` exactly, in the
same pass that finds the documents. Nothing is rescored downstream.

This was not an optimisation but a necessity. Measured: rescoring 30 000
candidates with `computeClientRelevance` costs **3.6 seconds**, and it would land
on every turn.

The property therefore strengthens from superset to **equality**: the index
returns exactly the documents at or above θ, with scores bit-identical to the
scorer. §18's gate asserts all three (no missed document, no spurious document,
identical score).

**2. Postings are packed `number[]`, not `Set<number>`.** V8 SMI arrays cost
~8 bytes per element against a `Set`'s ~50. This is the single largest memory
lever and it is marked "do not tidy" in the source.

### 8.3 Measured result

| Corpus | Build | Heap | Query mean / worst | Hits median / p90 |
|---|---|---|---|---|
| 10 000 | 2.2 s | +102 MB | 10.4 / 15.8 ms | 681 / 4 673 |
| 50 000 | 11.9 s | +387 MB | 64.8 / 92.6 ms | 6 038 / 25 907 |
| 100 000 | 26.9 s | +493 MB | 134.9 / 245.6 ms | 6 609 / 45 338 |

Against §8.1: heap improves **2.8–4×** (1 113 MB → 387 MB at 50 k), and the
3.6 s rescore is gone entirely because results arrive pre-scored.

Query latency of ~135 ms at 100 k records is acceptable — it is noise beside the
multi-second LLM call it precedes.

**Two honest caveats:**

- **Boot is still slow**: 26.9 s to build 100 k records. The snapshot mitigation
  is now required, not optional — serialise the built index and reload it,
  replaying only the delta.
- **493 MB at 100 k is still heavy** for a desktop tool. If it becomes a problem
  the next lever is `Int32Array`-backed postings with capacity doubling
  (~4 bytes/element), at the cost of growth and tombstone management.

Neither blocks Phase 3; both should be revisited before anyone runs a 100 k+
corpus in anger.

**Index state is user-visible** (§13). A cold index is a degraded state, not a
silent one.

---

## 9. The Memory Map

A deterministically generated table of contents, injected every turn alongside
the hot window. No LLM in the hot path.

```
[MEMORY MAP] session 4f2a · 1,847 msgs · 312k tokens · since Jul 14
Verbatim in context: last 20 messages (#1827–1847).
Segments — use memory_search / memory_read to expand:
  seg:4f2a:1   1–140     Jul 14  redis schema, ioredis, key namespacing
  seg:4f2a:4   391–620   Jul 16  bullmq retries, noeviction policy
  seg:4f2a:9   1690–1826 Jul 24  memory map injection, token budgets
Frequent: context-assembler.ts(84) · localEmbedding(41) · ioredis(37)
Pinned: 3 facts
```

Four properties, each fixing a review blocker:

1. **Bounded.** The map has a hard token budget (default 600). This is a fixed
   tax on every request and must be O(1) in session length. When the segment
   list exceeds budget, the last K segments are listed individually and older
   ones collapse into coarser super-segments.
2. **Stable identifiers.** `seg:{sid}:{n}`, assigned once at segment close from a
   monotonic seq range, **never re-derived**. Labels are display-only metadata.
   An async titler may overwrite a label freely without breaking addressing.
3. **Deterministic labels.** The IDF snapshot used for labelling is frozen at
   segment-close time, so appending a message cannot retroactively relabel
   earlier segments.
4. **Segments close on a rule**, not on re-derivation: whichever of *N messages*
   or *T tokens* comes first. Closed segments are immutable.

A separate **cross-session bootstrap block** is injected into the system prompt
at session start (§10), equivalent to today's `SessionBootstrap.buildContextBlock`.

---

## 10. Scope, not session, is the primary partition

The original design keyed every artifact by `{sid}`. That silently dropped
cross-session recall, which is the single behaviour users would most notice
losing — today it comes from `SessionBootstrap`, `recallForPlanning` (core +
project + up to 5 cross-project scopes), `executor.recallContext`, and assembler
federation.

Corrected model:

- `om:terms:{scope}` exists alongside `om:terms:{sid}`.
- `memory_search` searches **across all scopes by default**. Both `scope` and
  `session` are narrowing filters, never the default. This is cheap in v2 because
  the in-process index spans every scope in one structure — unlike Hindsight,
  where each bank was a separate HTTP round trip. It is also what makes
  `LessonsRollup` unnecessary (§19.2).
- A cross-session bootstrap block is injected at session start.
- Scope replaces the Hindsight bank concept: `core`, `project-<slug>`, `infra`.
  `generateSlug` ([bank-manager.ts:120](../packages/hindsight/src/bank-manager.ts:120))
  is pure and moves to shared unchanged.

---

## 11. Tool surface

Three tools, registered alongside `read_file` / `exec` / `write_file`
([conversation.ts:97](../packages/core/src/agent/conversation.ts:97)).

### `memory_search(query, {scope?, session?, since?, role?, limit?, cursor?})`

Returns ranked snippets with `seq` ids, a total match count, and a cursor.

**Must return an explicit machine-readable negative.** The conversation loop is
`for (let round = 0; ; round++)` with **no round cap**, and the circuit breaker
only increments when a result starts with `"Error:"`
([conversation.ts:805](../packages/core/src/agent/conversation.ts:805)) — a
zero-result search is a *success* string, and success *decrements* the counter.
An agent that searches and finds nothing can search forever.

```json
{ "status": "no_results",
  "searched": 4212, "scope": "project-x", "threshold": 0.15,
  "hint": "0 records above threshold; try memory_read on a segment" }
```

### `memory_read({segment} | {around: seq, radius})`

Contiguous verbatim span. **Hard-capped** at 30 000 chars, mirroring the inline
caps `read_file` and `exec` already use
([conversation.ts:300](../packages/core/src/agent/conversation.ts:300), [:338](../packages/core/src/agent/conversation.ts:338)).
`radius` is clamped. Truncation emits an explicit continuation marker:

```
[truncated: 34 more messages, next seq=1691]
```

Without this cap an agent can pull an arbitrary fraction of the session back
into context in one call, defeating the entire point of the dynamic window.

### `memory_pin(content, scope)`

Durable facts, always loaded, exempt from TTL. The deterministic, inspectable
replacement for Hindsight's LLM-synthesized mental models.

### Loop guards (all three required)

1. Explicit `no_results` status (above).
2. **Per-turn budget**: max 3 `memory_search` + 2 `memory_read` per user turn,
   enforced in the tool-execution loop, returning a hard refusal past the cap.
3. Move the message-array token trim **inside** the round loop — it currently
   runs once before it ([conversation.ts:494-514](../packages/core/src/agent/conversation.ts:494)),
   so tool results accumulate unbounded across rounds.

---

## 12. Assembler rewrite (D4)

Target: ~150 lines. **Deleted rather than ported:**

| Component | Lines | Why |
|---|---|---|
| Bank federation | ~60 | replaced by scope-wide index; was up to 4 HTTP recalls per populated bank |
| Dynamic-summary fallback | ~40 | fires on every cold turn, issues 3 extra recalls per bank, and **replaces** rather than augments recall |
| `buildCausalChain` | ~30 | reorders and rewrites recalled text before the model sees it |
| Query classifier + `RecallStrategy` | ~200 | 5-way classification driving per-type budget ratios |
| Confidence summaries | ~40 | display-only, pinned byte-for-byte by tests |
| Temporal-diversity bucketing | ~50 | Hindsight-specific multi-bucket recall |

**Retained and pinned by test:**

1. Hot window is never dropped by `assemble()` — only `push()` trims.
2. Recall is skipped when the computed budget is ≤ 500 tokens.
3. `estimatedTokens = systemPromptTokens + recalledTokens + hotTokens`
   (deliberately excludes `outputReserve`).
4. `isExternalAction(task)` short-circuits recall entirely.

`isExternalAction` is imported directly from `query-classifier.js` by
`memory-bridge`, `planner`, and `executor` — it survives even though the rest of
the classifier does not.

### 12.1 The two LLM-driven components

The "no LLM" constraint applies to **vectorization and ranking**, which must stay
deterministic. It does not extend to off-hot-path summarization. Resolved:

**`CompactionFlush` — DELETE.** It is dead code. Its only entry point is
`MainAgent.flushMemory()` ([main-agent.ts:1703](../packages/core/src/agent/main-agent.ts:1703)),
which has **zero callers repo-wide** (verified). Its own module docstring states
its purpose: *"before context compaction discards them."* This system does not
compact, so it has never run. Its capability — durable extracted facts — is
served by `memory_pin` (§11), which is agent-authored and explicit about when it
fires rather than an LLM guessing during an event that does not occur.

**`SessionSummarizer` — KEEP, behind `memory.sessionSummary` (default `true`).**
Live: fires on last-client disconnect
([websocket.ts:907](../packages/gateway/src/websocket.ts:907)) and per-session at
graceful shutdown ([server.ts:2320](../packages/gateway/src/server.ts:2320)).
Min 5 messages, 5-minute debounce, transcript bounded to 500 K chars newest-first,
512 output tokens, 3× retry with backoff skipping 4xx, health tracked for
`/api/health`. It writes `session_summary` to `core` and `project_update` to the
project scope, both with stable `document_id`s — i.e. `DocumentRecord`s (§4.2).

It is what populates the cross-session bootstrap block (§10). Note the tradeoff
has shifted: because v2 retains full history in Redis permanently, the summary no
longer *preserves* anything, it only condenses. The deterministic fallback when
disabled is a bootstrap block assembled from segment digests (§9) — which yields
a topic list (`redis schema, ioredis, key namespacing`) rather than narrative
continuity (`decided on Redis-as-store; next: extract similarity.ts`). For
continuity specifically the LLM output is worth more, which is why the default
is on.

---

## 13. Status surface (D3)

Replace `hindsight_status {connected, busy}` with `memory_activity`:

```ts
{ busy: boolean,
  health: 'ready' | 'rebuilding' | 'degraded',
  pct?: number,                    // when rebuilding
  reason?: 'redis_unreachable' | 'index_cold' | 'write_failed',
  op?: string, count?: number }
```

The status bar renders `◈ Memory` **always**, with no connectivity gate; the
spinner replaces `◈` during I/O. It never says "offline" — it says what memory
can currently do.

Two things the original plan missed:

- **`hindsightConnected` currently drives `systemHealth: 'ok' | 'degraded'`** on
  `GET /api/status` ([routes/status.ts:72](../packages/gateway/src/routes/status.ts:72)),
  rendered as a System Health card in the web UI. `health` above is its
  replacement; deleting the gate without one silently redefines "degraded" for
  operators.
- **There are two competing producers today.** The `onActivity` callback
  ([server.ts:770-787](../packages/gateway/src/server.ts:770)) and a 15-second
  `/health` poll ([server.ts:1270-1292](../packages/gateway/src/server.ts:1270))
  both broadcast `hindsight_status`, and the poll always sends `busy: false`,
  clobbering real activity. Collapse to a single authority.

The **live memory feed** (`memory_event` / `memory_history`, driven by `onIO`)
survives and is repointed at Redis activity. Note the TUI currently drops these
messages — there is no `case 'memory_event'` in its switch
([gateway-client.ts:416](../packages/tui/src/gateway-client.ts:416)); only the
web UI renders the feed.

---

## 14. Configuration

`hindsight:` → `memory:`. Hard break, no silent alias. Mirrors the existing
`orchestration.queue` shape for consistency.

```yaml
memory:
  redis:
    url: redis://localhost:6379
    password: ${REDIS_PASSWORD}      # optional
    tls: false
    db: 1                            # separate logical DB from BullMQ
    keyPrefix: "om:"
  hotWindowSize: 20
  recallBudgetTokens: 30000
  maxTurnTokens: 60000
  memoryMapTokens: 600
  minRelevance: 0.15
  deduplicationThreshold: 0.85
  retainOnComplete: true
  retainOnError: true
  sessionSummary: true              # LLM session summary at session end (§12.1)
```

Dropped as dead config: `circuitBreakerThreshold` and `circuitBreakerCooldown`
have **no consumer anywhere** — the client hardcodes both as private statics.

### Two silent-failure sites in the rename

Both verified; neither produces a TypeScript error.

1. **Config allowlist.** [`routes/config.ts:11`](../packages/gateway/src/routes/config.ts:11)
   gates PATCHes through a **literal string array** containing `'hindsight'`.
   Rename the type without updating this and every settings save from the web UI
   is rejected at runtime. Same problem in the per-key validation block.
2. **Persisted session field.** `hindsightBank` is written into session JSON
   ([sessions.ts:1473](../packages/gateway/src/sessions.ts:1473)) and read back
   at `:1575`. This is an on-disk format in `~/.orionomega/sessions/*.json`.
   Because this is a fresh-install-only release (§16), rename it to `memoryScope`
   outright with **no back-compat read** — existing session files are abandoned
   along with their banks. Still worth listing here: neither file exists on a
   clean dev machine, so nothing local will fail if the rename is incomplete.

---

## 15. Operational requirements

### Deployment: one Redis instance — RESOLVED

**Context that reframes this:** `install.sh` and `packages/core/src/commands/setup.ts`
contain **zero** Redis references, and `queue.backend` defaults to `'in-process'`
([loader.ts:98](../packages/core/src/config/loader.ts:98)). Redis is not
provisioned today at all. v2 makes it a first-time install dependency.

**The conflict is real but narrow.** BullMQ requires `maxmemory-policy noeviction`
or it silently loses jobs. `maxmemory-policy` is **instance-wide** — selecting a
different DB index does **not** isolate it (that separates keyspace only, which
`keyPrefix` already does). But the conflict only exists for users who explicitly
opt into `queue.backend: 'redis'`.

**Decision: provision ONE instance, pinned to `noeviction`.** The memory store
enforces its own size bound rather than relying on eviction:

- `om:hot:{sid}` bounded by `LTRIM` on every append
- per-session cap on `om:msg` key count
- content > 8 KB offloaded to `om:blob:{id}` with its own TTL
- GC pass deletes expired non-pinned records (§15 Retention)

An unbounded conversation store is a bug regardless of eviction policy, so these
caps are required either way — which is what makes a single instance safe. One
daemon also matches the self-sufficient-tool framing better than two.

**Escape hatch, no code change required:** `memory.redis.url` is its own config
key, so anyone hitting the conflict points memory at a second instance.

**Required:** a startup probe issuing `CONFIG GET maxmemory-policy`, warning
loudly when it is not `noeviction` and `queue.backend === 'redis'`. Nothing in
the repo documents this requirement today.

### Connection handling

The existing connection is literally `{ url: this.redisUrl }`
([redis-queue.ts:129](../packages/core/src/orchestration/queue/redis-queue.ts:129))
— no password, TLS, db, keyPrefix, or retry policy. There is no shared
connection factory anywhere in `packages/*/src`.

Add `createRedisConnection()` in `packages/core`, consumed by both
`RedisTaskQueue` and `RedisMemoryStore`, so connection count is bounded and
options live in one place. Reuse `redactUrl`
([queue/index.ts:79](../packages/core/src/orchestration/queue/index.ts:79)) on
every log line.

Note `ioredis`/`bullmq` are **optionalDependencies** loaded through a
`const moduleName = 'bullmq'` indirection specifically to defeat static TS
resolution. Memory must either make them required or preserve the graceful
degradation path.

### Secrets in memory — RESOLVED: redact, do not drop

§4.4 stores `tool_result` content verbatim — exactly where API keys, env dumps,
and `exec` output land.

**Decision: redact matched spans in place; never refuse to persist the record.**
Replace each match with a visible marker (`[REDACTED:pem_private_key]`) so the
redaction is auditable rather than silent.

Three reasons drop-the-record loses:

1. **False positives are asymmetric.** `SECRET_PATTERNS` is currently used as a
   *deny* gate on `Write`
   ([agent-sdk-bridge.ts:660](../packages/core/src/orchestration/agent-sdk-bridge.ts:660)),
   where a false positive just makes the agent rephrase. Under "refuse to
   persist", a false positive loses the record permanently.
2. **Dropping breaks the range-read contract.** `memory_read` promises a
   *contiguous verbatim span*; a dropped record is a hole in the middle of one.
3. **`tool_result` is `indexed: 0`.** It is never in the search corpus and is
   reachable only by explicit `memory_read`, so the exposure surface is already
   narrow.

**Use a narrowed subset, NOT `SECRET_PATTERNS` verbatim.** The existing list is
tuned for blocking, not precision, and includes a bare-UUID matcher commented as
"Heroku API key":

```
/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/
```

That matches every session id, workflow id, and request id in the system. Applied
to persistence it would redact (or, under the rejected option, destroy) a large
fraction of all tool results.

Keep: PEM/X.509 private keys, JWTs, explicit `api_key`/`password`/`client_secret`
key-value forms, DB connection strings with embedded credentials, and the
vendor-prefixed tokens (`shpat_`, npm `_authToken`, Firebase, Cloudinary).
Drop: the bare-UUID pattern and the generic `.env`-style line matcher.

Also required:

- File mode `0600` on any exported JSONL.
- `/memory forget <scope|session|seq-range>` and programmatic purge on session
  delete, preserving today's session-tag purge behaviour.
- Update [security-compliance.md](security-compliance.md) §"Memory Data".

### Retention

Keep expiry **advisory** — a filter in the ranking layer, exactly as today.
**Never map `DEFAULT_CATEGORY_TTL` onto Redis `EXPIRE`**: `0` means *never
expires* in that table, so a naive mapping issues `EXPIRE 0` and destroys every
`decision`, `preference`, `architecture`, `lesson`, `infrastructure`,
`run_artifact`, and `run_manifest` record. Pinned categories beat TTL, which a
TTL-based scheme cannot express.

Add a GC pass that physically deletes expired non-pinned records. `RetentionPolicy`
and `ImportanceFactors` ([types.ts:120-141](../packages/hindsight/src/types.ts:120))
are retention-engine types, not Hindsight API shapes — they move to shared.

---

## 16. Phasing

> **No migration path. This is a breaking version installed fresh.**
> The product is in limited testing with no consequential data, so existing
> Hindsight banks are abandoned, not exported. This removes the export command,
> the `listMemories` retention, all config aliasing, and the `hindsightBank`
> back-compat read. Where earlier drafts called for back-compat, the answer is
> now: delete it and bump the version.

### Phase 1 — Extract pure code

`similarity.ts` (620 lines, **zero imports**, verified) → `@orionomega/shared`,
verbatim, with its private helpers (`normalize`, `trigrams`,
`computeKeywordScore`, `fnv1a`, `djb2`, `prepareTrigramProfile`,
`admissibleSizeBand`, and the five regex constants — none of which grep for
"hindsight"). Also `types.ts`, `errors.ts`, `generateSlug`, and
`buildContextBlock`.

Repoint `packages/gateway/src/server.ts:19`, which imports
`setLogLevel as setHindsightLogLevel` from the package — the logger is a 12-line
re-export shim over `@orionomega/shared/logger`, and deleting it without
repointing breaks the gateway build.

`dedup-prefilter.test.ts` and lines 38-109 of `hybrid-recall.test.ts` are fully
pure and survive with an import-path change only.

### Phase 2 — Define `MemoryStore`, refactor onto it

Against the **full live writer surface**, not just the assembler's three methods:
`retain`, `retainOne`, `recall`, `candidates`, `isDuplicateContent`,
`listScopes`, `deleteScope`. Do **not** carry the eight dead client methods
(`getBank`, `budgetMaxTokens`, `activeOps`, `circuitState`, `connected`,
`onActivity`, `vectorRecallEnabled`, `DEFAULT_TIMEOUT_MS`).

`listMemories` is **excluded**. It was retained for two reasons that no longer
exist: migration paging (out of scope, §16) and `LessonsRollup` (deleted, §19.2).
It is a full-scan API in a system otherwise built entirely on targeted candidate
generation, and nothing else calls it.

`retention-engine.ts:726` calls `(this.hs as any).consolidate(bankId)` — the
`as any` means removing `consolidate` is **not** a compile error. Fix the cast
so the decision surfaces.

Hindsight still sits behind the interface. Nothing has changed yet.

### Phase 3 — `RedisMemoryStore` + in-process index — IMPLEMENTED

`memory-index.ts`, `redis-connection.ts`, `redis-store.ts`, verified against a
real Redis by 137 integration tests across five risk surfaces.

**⚠️ D1's premise is falsified.** The decisions table justifies shipping a single
store because "multi-process access does not exist yet". Testing showed that
even when it *does* exist, this store does not support it: each
`RedisMemoryStore` owns a private in-process index, so **two instances sharing a
keyspace never see each other's writes until re-hydration**. Redis is shared;
the derived index is not.

That does not change D1 (one store is still right), but any future claim that
workers can share a store is false without one of: a Redis pub/sub invalidation
channel, periodic re-hydration, or routing worker recall through the gateway.
Kept visible as `it.fails('STILL BROKEN: ...')` rather than as a doc footnote.

### Phase 3b — GC and atomicity

**TTL enforcement — `RedisMemoryStore.collectGarbage()`.** TTL was advisory at
read time and nothing ever deleted anything. That became load-bearing once dedup
started honouring expiry too: an expired record is invisible to both `recall()`
and `isDuplicate()`, so re-learning the same content accreted records nothing
would reclaim. GC collects two classes:

- **Expired** — via `isMemoryExpired`, which already implements
  pinned-beats-TTL and reads a TTL of `0` as *never expires*. It must NOT be
  reimplemented as a Redis `EXPIRE`, which would read `0` as *expire now* and
  destroy every decision, preference, architecture and lesson record (§15).
- **Orphaned** — an `om:rec:{id}` hash referenced by no scope set: unreachable
  by any query and invisible to `hydrate()`, which walks scope sets.

Verified against live Redis: an expired `session_summary` (TTL 180 d) was
collected while a same-age `decision` (pinned) survived, and a hash whose
scope-set entry was removed was reclaimed as an orphan.

**Concurrent `documentId` allocation is now atomic.** The pointer is established
with `SET ... NX` instead of read-then-write, so exactly one caller allocates and
the losers read back the winner's id. Eight concurrent retains of one documentId
now converge on **one** record; previously each minted its own and all but one
were orphaned.

**Revised status — all four closed:**

| Issue | Status |
|---|---|
| Concurrent same-`documentId` retains create N records | **FIXED** — `SET NX` |
| TTL never collected | **FIXED** — `collectGarbage()` |
| A retain interleaved with `deleteScope` is orphaned | **FIXED** — atomic Lua |
| Cross-instance index divergence | **FIXED** — `syncFromRedis()` + eviction on fetch miss |

### Atomic `deleteScope`

Deletion used to read the scope's membership and then delete it in a second
round trip. A record retained in that window was dropped from the scope set
while its `om:rec` hash survived — invisible to `hydrate()` (which walks scope
sets) and unreachable by any query, yet still served by the writing process's
index.

It is now a single Lua script. Redis runs a script with no interleaving, so the
script re-enumerates atomically and the window does not exist. This is stronger
than `MULTI`, which batches but cannot branch on what it read.

> The script derives its keys from the prefix rather than declaring them in
> `KEYS[]`. Safe on the single instance §15 specifies; would need rework for
> Redis Cluster, where every key a script touches must hash to one slot.

### Cross-instance divergence — both directions

Redis is shared; the derived index is not. Two fixes, because divergence has two
directions and only fixing one leaves the other silently wrong:

- **Learning** — `syncFromRedis()` ingests records written by other processes.
  Cheap by construction: ids come from ONE global `om:seq`, so a single `GET`
  reveals whether anything new exists and only the delta is fetched. An idle
  keyspace costs one round trip. `startSync(intervalMs)` runs it periodically,
  off by default (a single-process deployment needs nothing).
- **Forgetting** — recall now *evicts* an id whose hash is gone instead of
  skipping it. That miss was already being discovered at fetch time; it just
  never repaired anything, so `indexSize` lied until the next hydration.

This makes "workers can share a store" true, which the D1 note in §16 recorded
as false. D1 itself still stands — one store implementation is still right.

**Verified against live Redis, with negative controls**: reverting the Lua
deletion, disabling sync ingestion, and disabling eviction each fail exactly one
test. The suite now carries **no `it.fails` tests at all** — there is no known-
broken behaviour left in the memory system.

**GC is scheduled, not just implemented.** `startGc()` / `stopGc()` follow the
same conventions as the codebase's other periodic maintenance task:

| Property | Behaviour | Why |
|---|---|---|
| Initial delay | 5 min (default) | A full keyspace scan must not compete with hydration during startup, but crash debris should still clear promptly |
| Interval | 6 h, floored at 60 s | The floor means a misconfigured `intervalMs: 1` cannot spin |
| Idle skip | Skips unless ≥ N records written since the last pass | Never rescan an unchanged keyspace |
| Overlap | A pass in flight suppresses the next tick | Two concurrent scans would race on the same connection |
| Errors | Caught and logged, loop continues | An async throw inside a timer is an unhandled rejection, which takes the process down |
| Timers | `unref`'d | A background chore must not keep the process alive |
| Lifecycle | `close()` calls `stopGc()`; opt in via `gc: true` or `startGc()` | Off by default so tests and short-lived scripts do not schedule work they never stop |

Each of those is pinned by a test, and each was verified by a negative control —
removing the guard fails exactly one test.

Wiring the gateway to pass `gc: true` lands with the rest of the cutover in
Phase 5; until then the store is constructed only by tests.

**Two fixes that initially made things worse**, caught by the adversarial pass
and since corrected — recorded because both are easy to reintroduce:

- `del`-before-`hset` on the upsert path was issued through a *pipeline*, which
  in ioredis batches but does not make commands atomic. A connection dying
  between the two destroyed the old revision without landing the new one —
  converting "stale fields survive" into "the record is silently gone". Writes
  now use `MULTI`.
- Recovering `documentId`s by reading record bodies inside `deleteScope` added a
  round trip *inside* the read-then-delete window, widening the race with a
  concurrent retain, and still missed pointers whose hash was already lost.
  documentIds are now tracked in a per-scope set (`om:scopedocs:{scope}`), so
  cleanup needs no read at all.

### Phase 3 (original plan)

Shadow-mode diff against the Hindsight path. The equivalence property test (§6.1)
is a **merge gate**.

### Phase 4 — Memory Map + tools + assembler rewrite — IN PROGRESS

**Landed:**

- **Scope membership is a ZSET** scored by seq. `memory_read` is a score-range
  query and a segment is a `[from, to]` span; a SET could answer neither
  without pulling every id and sorting in process. `om:scopes` and
  `om:scopedocs` remain SETs.
- **`range()` / `bounds()` / `pin()` / `unpin()` / `listPins()`** on the store.
- **Segments** (`om:seg:{scope}:{n}`, `om:segn:{scope}`) closing at 50 records
  or 8 000 tokens, whichever trips first. Boundaries are assigned once from a
  monotonic seq range and **never re-derived** — a shifting boundary would make
  a segment id the agent saw last turn point somewhere else. Labels are frozen
  at close and are display-only, so an async titler may overwrite one without
  breaking addressing.
- **`memory-map.ts`** — a pure renderer. Bounded (1 000 segments render no
  larger than 10, via oldest-first rollup into super-segments), deterministic,
  and budget-enforced (drops frequent-terms first, then oldest rows, never the
  header).
- **`memory-tools.ts`** — the three tools with §11's guards.
- **The message-array trim now runs every round** in `conversation.ts`, not
  once at entry. Tool results are appended to the array each round, so trimming
  only at entry bounded just the first request of a turn — and the memory tools
  can return tens of KB per call.

**A cold-start hole IDF cannot close.** Segment labels are TF-IDF ranked, but
the FIRST segment of a scope closes when the index holds only its own
near-identical records, so every term has zero IDF and ranking degenerates to
alphabetical. That produced a real label: `and, elaborating, for, keyspace`.
Fixed with a stopword list; IDF alone is not sufficient at cold start.

**Assembler rewritten: 899 → 519 lines.** Not the ~150 §12 estimated — that
figure counted the *arithmetic*, not the file. The rest is disk persistence,
retain buffering, the scope merge, and commentary recording why each deletion
happened. `dynamic-summary.ts` was deleted outright.

Removing `ConfidenceSummary` and the old config keys produced exactly three
compile errors — `main-agent`, `dynamic-summary`, the barrel export — so the
deletion surfaced as a build failure rather than a silent behaviour change.

**`RecallQuery` lost four fields**: `budget`, `temporalDiversityRatio`, `types`,
`queryTimestamp`. Every one was honoured only by `HindsightMemoryStore` and
silently ignored by `RedisMemoryStore`. A parameter one backend honours and
another quietly drops is worse than no parameter — callers write code that
appears to take effect and stops doing so at cutover.

**Test triage: 63 ported, 12 retired, 4 regressions found and resolved.** Each
retirement names the specific deleted feature it asserted. All four regressions
traced to one root cause — Hindsight's fact-class model (`world` / `experience` /
`observation`) has no Redis analogue — and resolving them is what produced the
`RecallQuery` cleanup and the §4.3 correction above.
`context-assembler-observations.test.ts` was deleted entirely: every test in it
asserted the `[OBSERVATION, confidence: X.XX]` format or observation-first
sorting, both gone.

**The gate is `context-assembler-properties.test.ts`** (19 tests) — the four
retained properties, Memory Map injection, and the §6.2 budget fix. Written
*before* the old tests were touched, so "make it green" could never be satisfied
by deleting the safety net.

### Phase 4 (original plan)

### Phase 5 — Cut over and remove — DONE

**`packages/hindsight` is deleted.** Zero `hindsight` references remain in any
`.ts`/`.tsx` source file. The workspace is `core · gateway · shared ·
skills-sdk · tui · web`.

| Component | Outcome |
|---|---|
| `MemoryBridge` | 977 → 513 lines; owns `RedisMemoryStore({ gc: true })` |
| `CompactionFlush` | deleted — dead code, zero callers |
| `MentalModelManager`, `SelfKnowledge`, `LessonsRollup`, `SessionBootstrap`, `BankManager` | deleted |
| `generateSlug` | extracted as `projectScopeFor()` in `scope-slug.ts` |
| `RetentionPolicy`, `ImportanceFactors` | relocated into `retention-engine.ts` — never Hindsight API shapes |
| `HindsightMemoryStore` | deleted; the Phase 2 adapter served its purpose |
| `migrate-bank-missions.ts` | deleted — bank configs do not exist in Redis |

**`consolidate` proved the Phase 2 discipline.** Un-`as any`-ing that call in
Phase 2 was specifically so its removal would be a compile error rather than a
silent no-op. It was, exactly as intended.

**Health checks became reachability probes.** `doctor` and `status` issued HTTP
`fetch` calls against Hindsight's `/health`. Redis speaks RESP, not HTTP, so
both now use `RedisMemoryStore.health()` — a `PING`, contractually
non-throwing, so an unreachable server reports `{ healthy: false }` rather than
rejecting. URLs are redacted before printing.

**Recall health is now genuinely wired**, not merely declared. The store emits
`{ busy, health, reason?, op?, count? }` around every retain and recall;
`MemoryBridge` owns it and `MainAgent.onMemoryActivity` forwards it. A callback
that existed but never fired would have been worse than none — and the previous
arrangement had exactly that failure mode in reverse, with a 15-second poll
clobbering real activity with a hardcoded `busy: false`.

**Verification:** clean `tsc --build` from zero artifacts · `pnpm -r build` with
no errors · core 72 files / 1180 tests · shared 296 · web 42 · 0 lint errors.
Gateway shows 4 failures in `scheduler.test.ts`, confirmed pre-existing against
a pristine HEAD worktree and tracked separately.

### Phase 5b — closing the inert-wiring gaps

Three components were built, tested, and **connected to nothing**. Each would
have shipped as working code that never executed:

| Gap | Cause | Fix |
|---|---|---|
| `PlannerConfig.memoryStore` never passed | The planner is constructed before `MemoryBridge.init()`, so reading `memory.store` there captures `null` forever | `Planner.setMemoryStore()` + `OrchestrationBridge.bindMemoryStore()`, called after init |
| `ExecutorConfig.memoryStore` never passed | Same class of bug | Resolved **per dispatch**, where the store already exists |
| `assembled.memoryMap` discarded | `main-agent` consumed only `priorContext` | Injected first, unconditionally |
| `buildMemoryTools` had no consumer | Never added to the conversation tool list | `memoryTools` on `ConversationOptions`, built fresh per turn |

**The Memory Map is injected whether or not recall matched anything.** Recall
answers *"what is relevant to this turn"*; the map answers *"what else exists"*.
Those are different questions, and the second must not be conditional on the
first succeeding — that is the entire mechanism by which the agent learns there
is more to ask for.

Wiring the map also **forced** wiring the tools: the map tells the model to use
`memory_search` / `memory_read`, so injecting it while those tools were absent
from the tool list would have been worse than not injecting it at all.

Memory tools are rebuilt **per turn**, because the per-turn call budget lives in
the `buildMemoryTools` closure — reusing one toolset across turns would leak a
spent budget forward.

### Phase 5 (original plan)

### Phase 6 — Docs

Rewrite this file's predecessor rather than patching it.

---

## 17. Removal inventory

**Corrected scope: ~1302 occurrences across 144 files** (my earlier estimate of
951/92 was low — it missed `packages/web/public/*.patch`, `pnpm-lock.yaml`,
`test-results.txt`, and the 257 occurrences inside `packages/hindsight/` itself).

`MIGRATION.md` has **zero** Hindsight references — the real migration doc is
[docs/migration-guide.md](migration-guide.md).

| Category | Surface |
|---|---|
| Structural imports | 33 module-level + 6 relative = **39 refactor points** |
| Identifiers | 44 distinct tokens, ~370 occurrences (`HindsightClient` 188, `HindsightError` 76, `hindsightClient` 52) |
| Wire protocol | 5 boundaries; `'hindsight_status'` declared in **5 independent places** — there is no generated union |
| Config | 1 section, 13 sub-keys, 5 env vars, 1 string allowlist |
| User-visible | `/hindsight` in **3 registries** — including `main-agent.ts:708` which lists it **bare, without the slash**, so `grep '/hindsight'` misses it |
| Docs | 21 files in 3 tiers |
| Tests | 26 files; 15 Hindsight-specific, 11 incidental mocks |
| Plumbing | workspace + 3 tsconfigs + 2 package.json deps + lockfile; build order `shared → hindsight → skills-sdk → core → gateway` is load-bearing |

---

## 18. Test plan

**Merge gates:**

- Candidate superset property (§6.1), cloned from `dedup-prefilter.test.ts`.
- Production-config budget regression (§6.2) — 60 K / 30 K / 15 K / 4 096.
- Memory Map determinism and O(1) growth in session length.
- Segment id stability across appends and titler overwrites.
- `memory_read` cap + continuation marker.
- Zero-result `memory_search` returns `no_results`, and per-turn budget refuses
  past the cap.

**Coverage gap to close first:** `estimateTokens`, `smartTruncate`,
`compressMemoryContent`, `computeClientRelevance`, and `trigramSimilarity` are
**never the subject of a test** — they appear only as reference oracles. They
have the widest blast radius in the extraction. Characterize them *before*
moving them.

`client-validation.test.ts` covers behaviours that should migrate rather than be
deleted: empty-content rejection, max-content truncation, importance clamping to
`[0,1]`, negative-limit rejection.

Respect the known gotcha in [`.agents/memory/vitest-stale-src-js.md`](../.agents/memory/vitest-stale-src-js.md).

---

## 19. Resolved decisions

All open questions are closed. Recorded here with rationale.

### 19.1 Redis deployment — one instance

Provision a single Redis pinned to `noeviction`; the store enforces its own size
bound. See §15 for the full rationale, the escape hatch, and the required startup
probe.

### 19.2 `LessonsRollup` — DELETE

**What it did:** on a timer
([memory-bridge.ts:276](../packages/core/src/agent/memory-bridge.ts:276),
interval overridable via `ORIONOMEGA_LESSONS_ROLLUP_MS`), it scanned every
`project-*` bank, seeded a `DedupIndex` from up to 1000 existing `core` memories,
filtered project memories to lesson categories above a length threshold, deduped,
and copied survivors into `core` as `context: 'lesson'` with
`document_id: lesson-rollup-<shortHash>`.

**Why it existed:** under Hindsight, cross-bank query meant N HTTP round trips.
Physically copying lessons into `core` was a **cache** — `core` is always
queried, so promotion made cross-project knowledge cheap to reach.

**Why it goes:** v2's in-process index spans every scope in one structure.
Searching across scopes is a filter you omit, not N network calls (§10).
The rollup is a workaround for a cost that no longer exists. Deleting it also
removes the last consumer of `listMemories`.

**The behaviour change, stated explicitly:** promotion was not only about cost,
it was also about *priority* — a lesson copied into `core` got recalled because
`core` was always queried. Without the copy, that lesson competes on pure
relevance against everything else. Relevance-ranked is the better default, but
this is a real change, not a no-op. **If cross-project lessons stop surfacing
after the cutover, this is the cause.**

### 19.3 `SessionSummarizer` / `CompactionFlush` — see §12.1

`CompactionFlush` deleted (dead code; its premise contradicts the architecture).
`SessionSummarizer` kept behind `memory.sessionSummary`, default `true`.

### 19.4 `tool_result` redaction — redact, never drop

Redact matched spans in place with visible markers, using a narrowed
high-precision pattern subset rather than `SECRET_PATTERNS` verbatim. See §15 for
the pattern list and the bare-UUID problem that decides it.
