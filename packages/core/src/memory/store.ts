/**
 * @module memory/store
 * Backend-neutral memory interface. This is the seam the context assembly layer
 * talks to: it names what persistent memory must be able to do without naming
 * how or where it is stored.
 *
 * See docs/memory-architecture-v2.md. The implementation today is
 * `RedisMemoryStore`, backed by self-hosted Redis.
 *
 * DESIGN RULES
 * ------------
 * 1. Nothing in this file may reference a specific backend — no HTTP, no Redis,
 *    no storage-engine vocabulary. Vocabulary is *scope* (not bank) and
 *    *record* (not memory item).
 * 2. Ranking policy that callers depend on — blending, dedup, TTL filtering,
 *    and budget fill across scopes — belongs in the layer ABOVE this
 *    interface so it exists exactly once and every backend produces identical
 *    ordering.
 *
 * Recall is NOT a candidate/rank split at this interface. `recall` returns
 * scored records: `RedisMemoryStore` holds an in-process `MemoryIndex` and
 * scores lexically (keyword + character-trigram Jaccard, identical to
 * `computeClientRelevance`), so scoring is local and cheap and there is no
 * reason to expose an unscored candidate feed. Callers order and budget-fill
 * using `relevance`.
 */

/** A memory partition — the unit of isolation for records. */
export interface ScopeInfo {
  /** Stable scope identifier, e.g. `core`, `project-auth`, `conversation-<sid>`. */
  id: string;
  /** Number of records currently held in this scope. */
  recordCount: number;
}

/** A record being written to memory. */
export interface MemoryWrite {
  content: string;
  /**
   * Memory category — drives TTL, output formatting, and sort order.
   * NOTE: this is a different axis from record *kind* (user/assistant/tool).
   * See docs/memory-architecture-v2.md §4.3.
   */
  context: string;
  timestamp?: string;
  /** Stable idempotency key. Re-writing the same id updates in place. */
  documentId?: string;
  tags?: string[];
  /** Importance score in [0,1]. */
  importance?: number;
  metadata?: Record<string, string>;
}

/** A record returned from a recall. */
export interface RecalledRecord {
  content: string;
  context: string;
  timestamp: string;
  /** Match quality in [0,1]. */
  relevance: number;
  estimatedTokens?: number;
}

/**
 * Query parameters for a recall.
 *
 * Deliberately minimal. Four fields were removed in Phase 4 because each named
 * a behaviour with no analogue in the store, and each was silently ignored by
 * `RedisMemoryStore` while appearing to be honoured:
 *
 *   budget: 'low'|'mid'|'high'  — a per-tier cap that silently discarded ~80%
 *                                 of the requested budget (§6.2).
 *   temporalDiversityRatio      — selected a multi-bucket recall mode that no
 *                                 longer exists.
 *   types                       — a fact-class filter (world / experience /
 *                                 observation). Records carry `context`
 *                                 instead; there is nothing to filter on.
 *   queryTimestamp              — server-side recency weighting.
 *
 * A parameter only one backend honours is worse than no parameter: callers
 * write code that appears to take effect and silently stops doing so at cutover.
 */
export interface RecallQuery {
  maxTokens?: number;
  /** Drop records scoring below this. */
  minRelevance?: number;
}

/** Result of a recall. */
export interface RecallOutcome {
  records: RecalledRecord[];
  /**
   * True when the backend believes this result set is weak enough that the
   * caller should hedge (surfaced to the model as a confidence note).
   */
  lowConfidence: boolean;
  tokensUsed: number;
}

/** Result of a retain. */
export interface RetainOutcome {
  /** True only when every write the store attempted was durably stored. */
  ok: boolean;
  /**
   * Number of RECORDS STORED — not the number of writes submitted.
   *
   * These differ legitimately: writes sharing a `documentId` within one batch
   * collapse to a single record (last write wins), so
   * `retain(scope, [w, w])` with one documentId returns `{ ok: true, count: 1 }`.
   * Do NOT test `count === writes.length` to decide whether a batch landed —
   * check `ok`.
   */
  count: number;
}

/**
 * Persistent memory backing the dynamic context window.
 *
 * Implementations must be safe to call concurrently and must not throw for
 * routine miss cases (an unknown scope recalls empty, not an error).
 */
export interface MemoryStore {
  /** Write records to a scope. `async: true` permits fire-and-forget batching. */
  retain(scope: string, writes: MemoryWrite[], opts?: { async?: boolean }): Promise<RetainOutcome>;

  /** Convenience single-record write. */
  retainOne(scope: string, content: string, context: string, tags?: string[]): Promise<RetainOutcome>;

  /** Retrieve records relevant to `query` from a single scope. */
  recall(scope: string, query: string, opts?: RecallQuery): Promise<RecallOutcome>;

  /** Whether `content` is a near-duplicate of something already in `scope`. */
  isDuplicate(scope: string, content: string, threshold?: number): Promise<boolean>;

  /** All known scopes with their record counts. Used for scope discovery. */
  listScopes(): Promise<ScopeInfo[]>;

  /** Remove a scope and everything in it. */
  deleteScope(scope: string): Promise<void>;

  /** Liveness probe. Implementations must not throw — report `healthy: false`. */
  health(): Promise<{ healthy: boolean }>;
}
