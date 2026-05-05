import { HindsightError } from './errors.js';
import { createLogger } from './logger.js';
import {
  computeClientRelevance, deduplicateByContent, trigramSimilarity,
  estimateTokens, smartTruncate, compressMemoryContent,
} from './similarity.js';
import type {
  BankConfig,
  BankInfo,
  HealthStatus,
  MemoryItem,
  MentalModel,
  RecallOptions,
  RecallResult,
  RecalledMemory,
  RetainResult,
} from './types.js';

const log = createLogger('hindsight-client');

/**
 * Client for the Hindsight temporal knowledge graph API.
 *
 * @example
 * ```ts
 * const client = new HindsightClient('http://localhost:8888');
 * await client.retainOne('my-bank', 'Remember this', 'preference');
 * const result = await client.recall('my-bank', 'what do I prefer?');
 * ```
 */
const BUDGET_TIER_MAX_TOKENS: Record<string, number> = {
  low: 1024,
  mid: 4096,
  high: 8192,
};

/** Circuit-breaker state for the Hindsight client. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Snapshot of the Hindsight client's health for `/api/health`. */
export interface HindsightStatus {
  /**
   * Rolled-up health verdict for operator dashboards:
   * - `up`     — breaker closed, last request succeeded, no suppressed endpoints.
   * - `degraded` — breaker closed but the server is rejecting some endpoints
   *   (e.g. mental-models not implemented, or an auth error on the last call).
   * - `down`   — breaker is open or half-open; requests are being short-circuited.
   */
  status: 'up' | 'down' | 'degraded';
  /** Whether the last completed request succeeded at the transport level. */
  connected: boolean;
  /** Current circuit-breaker state. */
  circuitState: CircuitState;
  /** Number of consecutive transport-level failures recorded. */
  failureCount: number;
  /** Most recent error string (network or 5xx), if any. */
  lastError: string | null;
  /** Endpoint associated with `lastError`, if any. */
  lastErrorEndpoint: string | null;
  /** ISO timestamp when the breaker was last opened, if currently open. */
  openedAt: string | null;
  /** Whether mental-models support has been confirmed unavailable for this session. */
  mentalModelsAvailable: boolean | null;
  /**
   * Endpoints currently being suppressed because the server keeps returning
   * 404/405/501 for them (i.e. the deployed Hindsight version doesn't
   * implement them). Populated by the per-endpoint suppressor — see
   * `_suppressedEndpoints` for details.
   */
  suppressedEndpoints: Array<{ key: string; status: number; until: string }>;
}

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly namespace: string;
  private readonly apiKey?: string;
  private _activeOps = 0;
  private _connected = false;

  private _banksCache: BankInfo[] | null = null;
  private _banksCacheTime = 0;
  private static readonly BANKS_CACHE_TTL_MS = 60_000;

  // ── Circuit breaker ─────────────────────────────────────────────────
  /**
   * Trips after this many consecutive transport-level failures (network errors
   * or 5xx). 4xx responses do not increment the counter — those mean the
   * server is up and chose to reject the request, not that it is unhealthy.
   */
  private static readonly CIRCUIT_FAILURE_THRESHOLD = 5;
  /** Wait this long before allowing a single half-open probe request. */
  private static readonly CIRCUIT_COOLDOWN_MS = 60_000;

  private _circuitState: CircuitState = 'closed';
  private _failureCount = 0;
  private _lastError: string | null = null;
  private _lastErrorEndpoint: string | null = null;
  /**
   * HTTP status code attached to `_lastError`, if it came from a non-OK
   * response. 0 for transport/network failures. Cleared on the next
   * successful request. Used by `getStatus()` so auth errors (401/403)
   * surface as `degraded` even though the connection is technically up.
   */
  private _lastErrorStatus = 0;
  private _circuitOpenedAt = 0;
  /**
   * True while a half-open probe request is in flight. Concurrent callers
   * see this and short-circuit instead of all racing the server during the
   * recovery window — only one probe gets to decide whether the breaker
   * closes again.
   */
  private _halfOpenProbeInFlight = false;
  /** Set once the capability probe finishes; null while unknown. */
  private _mentalModelsAvailable: boolean | null = null;

  // ── Per-endpoint suppression ────────────────────────────────────────
  /**
   * Status codes that signal an endpoint isn't implemented by this server
   * and is therefore not worth retrying for a while. Repeated 404/405/501
   * was the dominant noise source before this task — once an endpoint has
   * returned one of these `SUPPRESS_AFTER_HITS` times in a row, we mark it
   * as suppressed and short-circuit subsequent calls until the TTL
   * expires (or a successful call to that key clears it).
   */
  private static readonly SUPPRESSIBLE_STATUSES = new Set([404, 405, 501]);
  private static readonly SUPPRESS_AFTER_HITS = 2;
  private static readonly SUPPRESS_TTL_MS = 5 * 60_000;
  private _endpointHitCounts = new Map<string, { status: number; count: number; message: string }>();
  private _suppressedEndpoints = new Map<string, { status: number; until: number; message: string }>();

  /** Callback invoked when I/O activity state changes (busy/idle or connected/disconnected). */
  onActivity?: (status: { connected: boolean; busy: boolean }) => void;

  /** Callback invoked for every retain/recall I/O operation with details. */
  onIO?: (event: { op: 'retain' | 'recall'; bank: string; detail: string; meta?: Record<string, unknown> }) => void;

  /** Number of in-flight API requests. */
  get activeOps(): number { return this._activeOps; }

  /** Whether the last request succeeded (connection is alive). */
  get connected(): boolean { return this._connected; }

  /** Current circuit-breaker state. */
  get circuitState(): CircuitState { return this._circuitState; }

  /**
   * Snapshot of overall client health. Safe to call from `/api/health` —
   * does not perform any I/O. Used by the gateway to surface a structured
   * `system.hindsight` block without grepping logs.
   */
  getStatus(): HindsightStatus {
    // Strip expired suppression entries lazily so the returned snapshot
    // doesn't surface stale data, and so suppressedEndpoints reflects what
    // would actually be enforced if a request fired right now.
    this.pruneExpiredSuppressions();

    const suppressedEndpoints = Array.from(this._suppressedEndpoints.entries()).map(
      ([key, entry]) => ({
        key,
        status: entry.status,
        until: new Date(entry.until).toISOString(),
      }),
    );

    // Roll up the verdict for operator dashboards. `down` wins over
    // `degraded` wins over `up` — the most-broken signal dominates.
    let status: 'up' | 'down' | 'degraded' = 'up';
    if (this._circuitState !== 'closed') {
      status = 'down';
    } else if (
      suppressedEndpoints.length > 0 ||
      this._mentalModelsAvailable === false ||
      (!this._connected && this._lastError !== null) ||
      // Auth errors don't trip the breaker (the connection is fine, the
      // credentials aren't), but they're operator-actionable and should
      // not be reported as 'up'. Cleared on the next successful request.
      this._lastErrorStatus === 401 ||
      this._lastErrorStatus === 403 ||
      // Any transport/5xx failure streak below the trip threshold should
      // still surface as degraded — the breaker trips at
      // CIRCUIT_FAILURE_THRESHOLD, but operators want visibility into
      // partial degradation before that point. Reset to 0 by recordSuccess
      // (or by any 4xx, which proves the server is reachable).
      this._failureCount > 0
    ) {
      status = 'degraded';
    }

    return {
      status,
      connected: this._connected,
      circuitState: this._circuitState,
      failureCount: this._failureCount,
      lastError: this._lastError,
      lastErrorEndpoint: this._lastErrorEndpoint,
      openedAt: this._circuitOpenedAt > 0 && this._circuitState !== 'closed'
        ? new Date(this._circuitOpenedAt).toISOString()
        : null,
      mentalModelsAvailable: this._mentalModelsAvailable,
      suppressedEndpoints,
    };
  }

  /**
   * Build the suppression bucket key for a request. Identifiers in the path
   * (bank IDs, mental-model IDs, namespaces) are normalised to `:id` so
   * that, e.g., 404s on every per-bank `mental-models/foo` URL collapse
   * onto a single suppression entry rather than spawning one per bank.
   *
   * Note: we deliberately do NOT normalise the segment after `/memories/`
   * — the only sub-path used there is `/memories/recall`, which is an
   * action name, not an identifier. Treating it as `:id` would conflate
   * a 404 on the recall endpoint with theoretical per-memory-ID lookups.
   */
  private suppressionKey(method: string, path: string): string {
    const normalised = path
      .replace(/\/v1\/[^/]+/g, '/v1/:ns')
      .replace(/\/banks\/[^/]+/g, '/banks/:id')
      .replace(/\/mental-models\/[^/]+/g, '/mental-models/:id');
    return `${method} ${normalised}`;
  }

  /** Remove suppression entries whose TTL has elapsed. */
  private pruneExpiredSuppressions(): void {
    const now = Date.now();
    for (const [key, entry] of this._suppressedEndpoints) {
      if (entry.until <= now) this._suppressedEndpoints.delete(key);
    }
  }

  /**
   * Whether the deployed Hindsight server exposes mental-model endpoints.
   * Returns null until the capability probe has run.
   */
  get mentalModelsAvailable(): boolean | null { return this._mentalModelsAvailable; }

  /**
   * Mark mental-models support as available/unavailable for the session.
   * Called by the memory bridge after the capability probe.
   */
  setMentalModelsAvailable(available: boolean): void {
    this._mentalModelsAvailable = available;
  }

  /**
   * Create a new Hindsight client.
   * @param baseUrl - Base URL of the Hindsight API (e.g. `http://localhost:8888`).
   * @param namespace - Namespace for bank isolation (default: `'default'`).
   * @param apiKey - Optional API key for authenticating with the Hindsight server.
   */
  constructor(baseUrl: string, namespace: string = 'default', apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.namespace = namespace;
    this.apiKey = apiKey || process.env.HINDSIGHT_API_KEY;
  }

  // ── Health ──────────────────────────────────────────────────────────

  /** Check API health and version. */
  async health(): Promise<HealthStatus> {
    return this.request<HealthStatus>('GET', '/health');
  }

  // ── Banks ──────────────────────────────────────────────────────────

  /**
   * Create a new memory bank.
   * @param bankId - Unique identifier for the bank.
   * @param config - Bank configuration (name, tuning parameters).
   */
  async createBank(bankId: string, config: BankConfig): Promise<void> {
    await this.request<unknown>('PUT', this.bankPath(bankId), config);
    this.invalidateBanksCache();
  }

  /**
   * Get information about an existing bank.
   * @param bankId - The bank identifier.
   */
  async getBank(bankId: string): Promise<BankInfo> {
    return this.request<BankInfo>('GET', this.bankPath(bankId));
  }

  /** List all banks in the current namespace. */
  async listBanks(): Promise<BankInfo[]> {
    const res = await this.request<{ banks: BankInfo[] }>('GET', `/v1/${this.namespace}/banks`);
    return res.banks;
  }

  async listBanksCached(): Promise<BankInfo[]> {
    const now = Date.now();
    if (this._banksCache && (now - this._banksCacheTime) < HindsightClient.BANKS_CACHE_TTL_MS) {
      return this._banksCache;
    }
    try {
      this._banksCache = await this.listBanks();
      this._banksCacheTime = now;
      return this._banksCache;
    } catch (err) {
      log.warn('Failed to refresh banks cache', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this._banksCache ?? [];
    }
  }

  invalidateBanksCache(): void {
    this._banksCache = null;
    this._banksCacheTime = 0;
  }

  async isDuplicateContent(
    bankId: string,
    content: string,
    threshold = 0.85,
  ): Promise<boolean> {
    try {
      const existing = await this.recall(bankId, content, {
        maxTokens: 512,
        budget: 'low',
        minRelevance: 0.0,
        deduplicate: false,
      });
      return existing.results.some(
        (r) => trigramSimilarity(r.content, content) >= threshold,
      );
    } catch {
      return false;
    }
  }

  static budgetMaxTokens(tier: 'low' | 'mid' | 'high'): number {
    return BUDGET_TIER_MAX_TOKENS[tier] ?? 4096;
  }

  /**
   * Check whether a bank exists.
   * Uses the cached list endpoint to avoid redundant API calls.
   * @param bankId - The bank identifier.
   * @returns `true` if the bank exists, `false` otherwise.
   */
  async bankExists(bankId: string): Promise<boolean> {
    try {
      const banks = await this.listBanksCached();
      return banks.some((b) => b.bank_id === bankId);
    } catch (err) {
      log.warn('bankExists check failed', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ── Memories ───────────────────────────────────────────────────────

  /**
   * Retain (store) one or more memory items in a bank.
   * @param bankId - Target bank identifier.
   * @param items - Array of memory items to store.
   */
  async retain(bankId: string, items: MemoryItem[]): Promise<RetainResult> {
    const start = Date.now();

    // Compress content and compute token estimates before storage
    const processedItems = items.map((item) => {
      const compressed = compressMemoryContent(item.content);
      return {
        ...item,
        content: compressed,
        estimatedTokens: item.estimatedTokens ?? estimateTokens(compressed),
      };
    });

    log.verbose(`Retain → ${bankId}`, {
      itemCount: processedItems.length,
      contexts: processedItems.map(i => i.context),
      totalChars: processedItems.reduce((sum, i) => sum + (i.content?.length ?? 0), 0),
      totalTokens: processedItems.reduce((sum, i) => sum + (i.estimatedTokens ?? 0), 0),
    });
    const result = await this.request<RetainResult>(
      'POST',
      `${this.bankPath(bankId)}/memories`,
      { items: processedItems },
    );
    const durationMs = Date.now() - start;
    log.verbose(`Retain ← ${bankId}`, { durationMs });

    const contexts = [...new Set(items.map(i => i.context))].join(', ');
    const preview = items.length === 1
      ? items[0].content.slice(0, 120) + (items[0].content.length > 120 ? '…' : '')
      : `${items.length} items`;
    this.onIO?.({
      op: 'retain',
      bank: bankId,
      detail: `Stored ${preview} [${contexts}]`,
      meta: {
        itemCount: items.length,
        contexts: contexts.split(', '),
        durationMs,
        items: items.map(i => ({
          content: i.content,
          context: i.context,
          timestamp: i.timestamp,
        })),
        result: { success: result.success, bankId: result.bank_id, itemsCount: result.items_count },
      },
    });
    return result;
  }

  /**
   * Convenience method to retain a single memory.
   * @param bankId - Target bank identifier.
   * @param content - The memory content text.
   * @param context - Category for the memory (e.g. `'preference'`, `'decision'`).
   * @param tags - Optional tags (e.g. `['session:<id>']`) attached to the
   *   stored item. Tags are used by callers to attribute provenance
   *   (e.g. which gateway session wrote a memory) without affecting
   *   cross-session recall.
   */
  async retainOne(
    bankId: string,
    content: string,
    context: string,
    tags?: string[],
  ): Promise<RetainResult> {
    const item: MemoryItem = {
      content,
      context,
      timestamp: new Date().toISOString(),
    };
    if (tags && tags.length > 0) item.tags = tags;
    return this.retain(bankId, [item]);
  }

  /**
   * Recall memories from a bank matching a natural-language query.
   *
   * When the API returns relevance=0 for all results (a known backend issue),
   * this method computes client-side relevance scores using trigram + keyword
   * similarity as a proxy. This ensures the minRelevance filter and
   * confidence propagation pipeline still function correctly.
   *
   * @param bankId - Source bank identifier.
   * @param query - Natural-language search query.
   * @param opts - Optional recall parameters (maxTokens, budget).
   */
  async recall(
    bankId: string,
    query: string,
    opts?: RecallOptions,
  ): Promise<RecallResult> {
    const start = Date.now();
    const tier = opts?.budget ?? 'mid';
    const tierCap = BUDGET_TIER_MAX_TOKENS[tier] ?? 4096;
    const effectiveMaxTokens = Math.min(opts?.maxTokens ?? tierCap, tierCap);

    // F6: Truncate oversized queries to prevent HTTP 400 errors from the API.
    // Context assembler can pass full workflow payloads (~10KB+) as queries.
    const MAX_QUERY_LENGTH = 4000;
    const effectiveQuery = query.length > MAX_QUERY_LENGTH
      ? query.slice(0, MAX_QUERY_LENGTH)
      : query;

    if (query.length > MAX_QUERY_LENGTH) {
      log.verbose(`Recall query truncated from ${query.length} to ${MAX_QUERY_LENGTH} chars`, { bankId });
    }

    log.verbose(`Recall → ${bankId}`, {
      queryPreview: effectiveQuery.slice(0, 200),
      maxTokens: effectiveMaxTokens,
      budget: tier,
      tierCap,
    });
    const body: Record<string, unknown> = {
      query: effectiveQuery,
      max_tokens: effectiveMaxTokens,
      budget: tier,
    };
    if (opts?.maxCandidates) {
      body.max_candidates = opts.maxCandidates;
    }
    // F5: Fix temporal diversity parameter name to match API schema.
    // The API expects `query_timestamp`, not `before`.
    if (opts?.before) {
      body.query_timestamp = opts.before;
    }

    const raw = await this.request<{ results: Array<Record<string, unknown>> }>(
      'POST',
      `${this.bankPath(bankId)}/memories/recall`,
      body,
    );

    // F4: Default threshold lowered from 0.3 → 0.15. The old 0.3 was calibrated
    // for embedding scores; the client-side fallback produces ~0.05–0.40.
    const requestedMinRelevance = opts?.minRelevance ?? 0.15;
    const shouldDedup = opts?.deduplicate !== false;
    const dedupThreshold = opts?.deduplicationThreshold ?? 0.85;

    let allResults: RecalledMemory[] = (raw.results ?? []).map((r) => {
      const content = (r.text as string) ?? (r.content as string) ?? '';
      return {
        content,
        context: (r.context as string) ?? '',
        timestamp: (r.mentioned_at as string) ?? (r.timestamp as string) ?? '',
        relevance: (r.relevance as number) ?? 0,
        estimatedTokens: estimateTokens(content),
      };
    });

    // Client-side relevance when API returns all zeros.
    // Hindsight v0.4.x without embedding backend returns relevance=0 always.
    const allZeroRelevance = allResults.length > 0 &&
      allResults.every((r) => r.relevance === 0);

    if (allZeroRelevance) {
      log.verbose('API returned all-zero relevance scores, computing client-side relevance', {
        bankId,
        resultCount: allResults.length,
      });
      allResults = allResults.map((r) => ({
        ...r,
        relevance: computeClientRelevance(effectiveQuery, r.content),
      }));
    }

    // When using client-side scoring, cap the threshold at 0.15 even if
    // callers passed a higher value (their 0.3 was calibrated for embeddings).
    const CLIENT_FALLBACK_CEILING = 0.15;
    const minRelevance = allZeroRelevance
      ? Math.min(requestedMinRelevance, CLIENT_FALLBACK_CEILING)
      : requestedMinRelevance;

    let filtered = allResults.filter((r) => r.relevance >= minRelevance);
    const droppedByRelevance = allResults.length - filtered.length;

    // F10: Distinguish "no API results" from "threshold dropped all results".
    if (allResults.length === 0) {
      log.verbose(`Recall: API returned 0 results`, { bankId });
    } else if (filtered.length === 0) {
      const topScore = Math.max(...allResults.map((r) => r.relevance));
      log.warn(`Recall: ${allResults.length} result(s) dropped by relevance threshold`, {
        bankId,
        totalFromApi: allResults.length,
        minRelevance,
        topScore: topScore.toFixed(3),
        usedClientRelevance: allZeroRelevance,
      });
    } else {
      log.verbose(`Recall relevance filter`, {
        bankId,
        totalFromApi: allResults.length,
        aboveThreshold: filtered.length,
        dropped: droppedByRelevance,
        minRelevance,
        usedClientRelevance: allZeroRelevance,
      });
    }

    filtered = this.applyDeduplication(filtered, shouldDedup, dedupThreshold);
    const droppedByDedup = allResults.length - droppedByRelevance - filtered.length;

    // Enforce token budget: trim results that would exceed the requested max tokens.
    // Smart-truncate individual items that are oversized before dropping them entirely.
    const budgetCap = effectiveMaxTokens;
    let tokenAccum = 0;
    const budgetFiltered: RecalledMemory[] = [];
    for (const r of filtered) {
      const itemTokens = r.estimatedTokens ?? estimateTokens(r.content);
      if (tokenAccum + itemTokens > budgetCap && budgetFiltered.length > 0) {
        // Try smart truncation to fit remaining budget
        const remaining = budgetCap - tokenAccum;
        if (remaining > 50) {
          const truncated = smartTruncate(r.content, remaining);
          const truncTokens = estimateTokens(truncated);
          if (truncTokens <= remaining) {
            budgetFiltered.push({ ...r, content: truncated, estimatedTokens: truncTokens });
            tokenAccum += truncTokens;
          }
        }
        break;
      }
      budgetFiltered.push(r);
      tokenAccum += itemTokens;
    }

    const totalEstimatedTokens = budgetFiltered.reduce((sum, r) => sum + (r.estimatedTokens ?? 0), 0);

    const result: RecallResult = {
      results: budgetFiltered,
      tokens_used: (raw as unknown as Record<string, unknown>).tokens_used as number ?? 0,
      totalEstimatedTokens,
    };

    const droppedByBudget = filtered.length - budgetFiltered.length;

    const durationMs = Date.now() - start;
    log.verbose(`Recall ← ${bankId}`, {
      durationMs,
      resultCount: result.results.length,
      droppedByRelevance,
      droppedByDedup,
      droppedByBudget,
      totalEstimatedTokens,
    });

    // F13: Recall effectiveness metric — log the ratio of results surfaced vs total
    // from API. Critical for monitoring recall health. Alert when <10% sustained.
    const surfaceRate = allResults.length > 0
      ? budgetFiltered.length / allResults.length
      : 1; // no results from API → not a scoring problem
    if (allResults.length > 0 && surfaceRate < 0.1) {
      log.warn(`Recall effectiveness critically low: ${(surfaceRate * 100).toFixed(0)}% surfaced (${filtered.length}/${allResults.length})`, {
        bankId, minRelevance, usedClientRelevance: allZeroRelevance,
      });
    }

    this.emitRecallIO(bankId, query, result.results, allResults.length, droppedByRelevance, durationMs, {
      tier, effectiveMaxTokens, minRelevance, allZeroRelevance, tokensUsed: result.tokens_used, surfaceRate,
      totalEstimatedTokens, droppedByBudget,
    });
    return result;
  }

  async recallWithTemporalDiversity(
    bankId: string,
    query: string,
    opts?: RecallOptions & { temporalDiversityRatio?: number },
  ): Promise<RecallResult & { lowConfidence: boolean }> {
    const ratio = Math.max(0, Math.min(1, opts?.temporalDiversityRatio ?? 0.15));
    const tier = opts?.budget ?? 'mid';
    const tierCap = BUDGET_TIER_MAX_TOKENS[tier] ?? 4096;
    const totalTokens = Math.min(opts?.maxTokens ?? tierCap, tierCap);

    const primaryTokens = Math.floor(totalTokens * (1 - ratio));
    const temporalTokens = totalTokens - primaryTokens;

    const maxCandidates = opts?.maxCandidates ?? this.defaultMaxCandidates(totalTokens);

    const primaryOpts: RecallOptions = {
      ...opts,
      maxTokens: primaryTokens,
      maxCandidates,
      deduplicate: false,
    };

    const primaryPromise = this.recall(bankId, query, primaryOpts);

    const temporalPromises: Promise<RecallResult>[] = [];
    if (temporalTokens >= 200) {
      const buckets = [
        { label: 'mid-range', daysBack: 14 },
        { label: 'older', daysBack: 90 },
        { label: 'archive', daysBack: 365 },
      ];
      const perBucketTokens = Math.floor(temporalTokens / buckets.length);
      const perBucketCandidates = Math.max(5, Math.floor((maxCandidates * ratio) / buckets.length));

      for (const bucket of buckets) {
        if (perBucketTokens < 100) continue;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - bucket.daysBack);
        const temporalOpts: RecallOptions = {
          ...opts,
          maxTokens: perBucketTokens,
          maxCandidates: perBucketCandidates,
          before: cutoff.toISOString(),
          minRelevance: Math.max((opts?.minRelevance ?? 0.15) - 0.05, 0.05),
          deduplicate: false,
        };
        temporalPromises.push(
          this.recall(bankId, query, temporalOpts).catch((err) => {
            log.verbose(`Temporal diversity query (${bucket.label}) failed`, {
              bankId,
              error: err instanceof Error ? err.message : String(err),
            });
            return { results: [], tokens_used: 0 };
          }),
        );
      }
    }

    const [primary, ...temporalResults] = await Promise.all([
      primaryPromise,
      ...temporalPromises,
    ]);

    // Merge results — use trigram dedup instead of exact-match Set
    // (the old seenContents Set was redundant since deduplicateByContent
    // already handles exact matches via its trigram comparison)
    const merged = [...primary.results];
    for (const temporal of temporalResults) {
      for (const r of temporal.results) {
        merged.push(r);
      }
    }

    let totalTemporalTokens = 0;
    for (const t of temporalResults) {
      totalTemporalTokens += t.tokens_used;
    }

    const shouldDedup = opts?.deduplicate !== false;
    const dedupThreshold = opts?.deduplicationThreshold ?? 0.85;
    const final = this.applyDeduplication(merged, shouldDedup, dedupThreshold);

    // Lowered from 0.5 to 0.3 — client-side scores top out ~0.4, so 0.5
    // would flag essentially every client-scored recall as "low confidence".
    const LOW_CONFIDENCE_THRESHOLD = 0.3;
    const lowConfidence = final.length === 0 || final.every((r) => r.relevance < LOW_CONFIDENCE_THRESHOLD);

    return {
      results: final,
      tokens_used: primary.tokens_used + totalTemporalTokens,
      lowConfidence,
    };
  }

  private applyDeduplication<T extends { content: string; relevance: number }>(
    items: T[],
    shouldDedup: boolean,
    threshold: number,
  ): T[] {
    if (!shouldDedup || items.length <= 1) return items;
    items.sort((a, b) => b.relevance - a.relevance);
    return deduplicateByContent(items, threshold);
  }

  private emitRecallIO(
    bankId: string,
    query: string,
    results: Array<{ content: string; context: string; timestamp: string; relevance: number }>,
    totalFromApi: number,
    droppedByRelevance: number,
    durationMs: number,
    params: { tier: string; effectiveMaxTokens: number; minRelevance: number; allZeroRelevance: boolean; tokensUsed: number; surfaceRate?: number; totalEstimatedTokens?: number; droppedByBudget?: number },
  ): void {
    if (results.length > 0) {
      const topScore = Math.max(...results.map(r => r.relevance));
      this.onIO?.({
        op: 'recall',
        bank: bankId,
        detail: `Retrieved ${results.length}/${totalFromApi} memories (${((params.surfaceRate ?? 1) * 100).toFixed(0)}% surfaced, top: ${topScore.toFixed(2)}${params.allZeroRelevance ? ', client-scored' : ''})`,
        meta: {
          query,
          resultCount: results.length,
          totalFromApi,
          droppedByRelevance,
          topScore,
          durationMs,
          clientScored: params.allZeroRelevance,
          tokensUsed: params.tokensUsed,
          budget: params.tier,
          maxTokens: params.effectiveMaxTokens,
          minRelevance: params.minRelevance,
          surfaceRate: params.surfaceRate,
          results: results.map(r => ({
            content: r.content,
            context: r.context,
            timestamp: r.timestamp,
            relevance: r.relevance,
          })),
        },
      });
    } else {
      // F10: Differentiate "API returned no results" from "all results filtered
      // below threshold" — the old message was identical for both, making
      // diagnostics impossible.
      const detail = totalFromApi === 0
        ? 'No matching memories found (API returned 0 results)'
        : `All ${totalFromApi} results filtered below relevance threshold (min: ${params.minRelevance}, dropped: ${droppedByRelevance})`;
      this.onIO?.({
        op: 'recall',
        bank: bankId,
        detail,
        meta: {
          query,
          resultCount: 0,
          totalFromApi,
          droppedByRelevance,
          durationMs,
          budget: params.tier,
          maxTokens: params.effectiveMaxTokens,
          minRelevance: params.minRelevance,
        },
      });
    }
  }

  private defaultMaxCandidates(tokenBudget: number): number {
    if (tokenBudget <= 1024) return 50;
    if (tokenBudget <= 4096) return 100;
    return 150;
  }

  // ── Mental Models ──────────────────────────────────────────────────

  /**
   * Get a pre-synthesized mental model.
   * @param bankId - Source bank identifier.
   * @param modelId - Mental model identifier.
   */
  async getMentalModel(
    bankId: string,
    modelId: string,
  ): Promise<MentalModel> {
    return this.request<MentalModel>(
      'GET',
      `${this.bankPath(bankId)}/mental-models/${modelId}`,
    );
  }

  /**
   * Trigger a refresh of a mental model from current memories.
   * @param bankId - Source bank identifier.
   * @param modelId - Mental model identifier.
   */
  async refreshMentalModel(
    bankId: string,
    modelId: string,
  ): Promise<void> {
    await this.request<unknown>(
      'POST',
      `${this.bankPath(bankId)}/mental-models/${modelId}/refresh`,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────

  /** Build the URL path for a specific bank. */
  private bankPath(bankId: string): string {
    return `/v1/${this.namespace}/banks/${bankId}`;
  }

  /** Notify activity listeners of state change. */
  private emitActivity(): void {
    this.onActivity?.({ connected: this._connected, busy: this._activeOps > 0 });
  }

  /** Make an HTTP request to the Hindsight API. */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const endpoint = `${method} ${path}`;
    const suppressKey = this.suppressionKey(method, path);

    // Per-endpoint suppression gate. When the server has repeatedly told us
    // this endpoint isn't implemented (404/405/501), short-circuit to avoid
    // hammering it with identical requests for the suppression TTL. This
    // is the dominant source of startup-noise warnings the task targets.
    const suppressed = this._suppressedEndpoints.get(suppressKey);
    if (suppressed && suppressed.until > Date.now()) {
      const remaining = Math.ceil((suppressed.until - Date.now()) / 1000);
      // Debug only — operators can see suppression in /api/health.
      log.debug(`Suppressed Hindsight request: ${endpoint}`, {
        suppressedFor: `${remaining}s`,
        cachedStatus: suppressed.status,
        cachedMessage: suppressed.message,
      });
      throw new HindsightError(suppressed.message, suppressed.status, endpoint);
    }
    if (suppressed && suppressed.until <= Date.now()) {
      // TTL elapsed — drop the entry and let the request through to retry.
      this._suppressedEndpoints.delete(suppressKey);
    }

    // Circuit-breaker gate. When open, short-circuit until the cool-down
    // elapses, then transition to half-open and allow exactly one probe
    // request through. The transition log is emitted once per state change
    // (not on every short-circuited call) to keep the log volume bounded
    // when a downstream Hindsight service stays unreachable for a while.
    if (this._circuitState === 'open') {
      const elapsed = Date.now() - this._circuitOpenedAt;
      if (elapsed < HindsightClient.CIRCUIT_COOLDOWN_MS) {
        const remaining = Math.ceil((HindsightClient.CIRCUIT_COOLDOWN_MS - elapsed) / 1000);
        const msg = `Hindsight circuit breaker open (retry in ~${remaining}s, last error: ${this._lastError ?? 'unknown'})`;
        throw new HindsightError(msg, 0, endpoint);
      }
      this._circuitState = 'half-open';
      this._halfOpenProbeInFlight = true;
      log.info(`Hindsight circuit breaker half-open — probing with ${endpoint}`);
    } else if (this._circuitState === 'half-open') {
      // Another caller is already probing the upstream. Short-circuit so
      // we don't all hit the server simultaneously and either spam it on
      // recovery or all fail together on a still-broken backend.
      if (this._halfOpenProbeInFlight) {
        const msg = `Hindsight circuit breaker probing (last error: ${this._lastError ?? 'unknown'})`;
        throw new HindsightError(msg, 0, endpoint);
      }
      // No probe in flight (the previous one resolved without re-opening
      // or closing the breaker yet — should be rare). Take the slot.
      this._halfOpenProbeInFlight = true;
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const init: RequestInit = {
      method,
      headers,
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    log.debug(`HTTP ${method} ${path}`);

    this._activeOps++;
    this.emitActivity();

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      this._activeOps--;
      this._connected = false;
      this.emitActivity();
      const msg = err instanceof Error ? err.message : 'Network error';
      // Network failures are rare and important — keep these at warn so
      // they show up in default logs. The breaker handles repeat noise.
      log.warn(`Hindsight request failed: ${method} ${path}`, { error: msg });
      this.recordFailure(endpoint, msg, /* transport */ true, /* status */ 0);
      throw new HindsightError(msg, 0, endpoint);
    }

    if (!res.ok) {
      this._activeOps--;
      this._connected = true; // server responded, just an error status
      this.emitActivity();
      let message: string;
      try {
        const errorBody = (await res.json()) as Record<string, unknown>;
        message =
          typeof errorBody['error'] === 'string'
            ? errorBody['error']
            : typeof errorBody['message'] === 'string'
              ? errorBody['message']
              : res.statusText;
      } catch {
        message = res.statusText;
      }

      // Tiered logging: most 4xx outcomes are not operator-actionable
      // from this layer (the bridge code logs domain context separately).
      // Only auth/forbidden and 5xx need to surface at warn or higher.
      // 404/405/501 are the noisiest "endpoint not implemented" responses
      // and are also fed into the per-endpoint suppressor below so callers
      // stop hammering them.
      if (res.status === 401 || res.status === 403) {
        log.warn(`Hindsight auth error: ${method} ${path} → ${res.status}`, { message });
      } else if (res.status >= 500) {
        log.warn(`Hindsight server error: ${method} ${path} → ${res.status}`, { message });
      } else {
        log.debug(`Hindsight API rejected: ${method} ${path} → ${res.status}`, { message });
      }

      // Only 5xx responses indicate the server itself is unhealthy. 4xx means
      // the server is up and rejected the request — that's a client problem,
      // and tripping the breaker on it would mask the underlying bug.
      const isServerError = res.status >= 500;
      this.recordFailure(endpoint, `${res.status} ${message}`, isServerError, res.status);

      // If this status code looks like "endpoint not implemented", increment
      // the per-endpoint hit counter and promote it to a suppression entry
      // once it's been seen enough times in a row.
      if (HindsightClient.SUPPRESSIBLE_STATUSES.has(res.status)) {
        this.recordSuppressibleHit(suppressKey, res.status, message, endpoint);
      } else {
        // A different rejection clears any prior streak so we don't promote
        // unrelated 404s from a transient bug into a long suppression window.
        this._endpointHitCounts.delete(suppressKey);
      }

      throw new HindsightError(message, res.status, endpoint);
    }

    this._activeOps--;
    this._connected = true;
    this.emitActivity();
    this.recordSuccess(suppressKey);

    // Some endpoints return no body (204, etc.)
    const text = await res.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /**
   * Record a successful request against the circuit breaker. Closes the
   * breaker if it was half-open and resets the consecutive-failure counter.
   * Also clears any per-endpoint suppression for the recovered key — if the
   * server now responds successfully, it has clearly started implementing
   * (or fixed) the endpoint we were avoiding.
   */
  private recordSuccess(suppressKey?: string): void {
    if (this._circuitState !== 'closed') {
      log.info(`Hindsight circuit breaker closed (recovered after ${this._failureCount} failure(s))`);
    }
    this._circuitState = 'closed';
    this._failureCount = 0;
    this._circuitOpenedAt = 0;
    // Always release the half-open probe slot so the next caller is not
    // permanently locked out. If the breaker was already closed this is a
    // no-op (the flag was already false).
    this._halfOpenProbeInFlight = false;
    // Clear the last-error status so /api/health stops reporting an old
    // auth or rejection issue once a healthy request succeeds. We keep
    // `_lastError` (the message) for diagnostic context.
    this._lastErrorStatus = 0;
    if (suppressKey) {
      this._endpointHitCounts.delete(suppressKey);
      if (this._suppressedEndpoints.delete(suppressKey)) {
        log.info(`Hindsight endpoint un-suppressed after success: ${suppressKey}`);
      }
    }
  }

  /**
   * Track a 404/405/501 response and promote the endpoint to a suppression
   * entry once it has been seen `SUPPRESS_AFTER_HITS` times in a row. We
   * gate on a streak (rather than a single hit) so a one-off 404 against
   * an endpoint that only sometimes returns one — e.g. a freshly created
   * bank that hasn't propagated — doesn't disable subsequent calls.
   */
  private recordSuppressibleHit(
    suppressKey: string,
    status: number,
    message: string,
    endpoint: string,
  ): void {
    const prior = this._endpointHitCounts.get(suppressKey);
    const nextCount = prior && prior.status === status ? prior.count + 1 : 1;
    this._endpointHitCounts.set(suppressKey, { status, count: nextCount, message });

    if (nextCount >= HindsightClient.SUPPRESS_AFTER_HITS && !this._suppressedEndpoints.has(suppressKey)) {
      const until = Date.now() + HindsightClient.SUPPRESS_TTL_MS;
      this._suppressedEndpoints.set(suppressKey, { status, until, message });
      log.warn(
        `Hindsight endpoint suppressed for ${HindsightClient.SUPPRESS_TTL_MS / 60_000}m after ${nextCount} consecutive ${status} responses`,
        { endpoint, key: suppressKey, message },
      );
    }
  }

  /**
   * Record a failed request against the circuit breaker. Only counts
   * transport-level failures (network errors, 5xx). 4xx errors update
   * `_lastError` for diagnostics but do not advance the counter.
   */
  private recordFailure(
    endpoint: string,
    message: string,
    transportFailure: boolean,
    status: number,
  ): void {
    this._lastError = message;
    this._lastErrorEndpoint = endpoint;
    this._lastErrorStatus = status;

    // A non-transport failure (4xx) is a *successful probe of the server
    // itself* — the server is up, it just rejected the request. Treat it
    // the same way as a 2xx for breaker purposes: reset the consecutive-
    // failure streak so transport failures separated by 4xx don't slowly
    // accumulate into a false trip, and close the breaker if we were
    // half-open. The probe slot is released either way.
    if (!transportFailure) {
      if (this._circuitState === 'half-open') {
        this._circuitState = 'closed';
        this._circuitOpenedAt = 0;
        log.info(`Hindsight circuit breaker closed (server responded with ${message})`);
      }
      this._failureCount = 0;
      this._halfOpenProbeInFlight = false;
      return;
    }

    this._failureCount++;
    const wasHalfOpen = this._circuitState === 'half-open';

    if (wasHalfOpen) {
      // The probe failed at the transport level — re-open for another cooldown.
      this._circuitState = 'open';
      this._circuitOpenedAt = Date.now();
      this._halfOpenProbeInFlight = false;
      log.warn(`Hindsight circuit breaker re-opened after failed half-open probe`, {
        endpoint, error: message, failureCount: this._failureCount,
      });
      return;
    }

    if (this._circuitState === 'closed' && this._failureCount >= HindsightClient.CIRCUIT_FAILURE_THRESHOLD) {
      this._circuitState = 'open';
      this._circuitOpenedAt = Date.now();
      log.warn(`Hindsight circuit breaker opened after ${this._failureCount} consecutive failures — suppressing requests for ${HindsightClient.CIRCUIT_COOLDOWN_MS / 1000}s`, {
        endpoint, error: message,
      });
    }
  }
}
