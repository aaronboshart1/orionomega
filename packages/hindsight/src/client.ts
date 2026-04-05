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

export class HindsightClient {
  private readonly baseUrl: string;
  private readonly namespace: string;
  private readonly apiKey?: string;
  private _activeOps = 0;
  private _connected = false;

  private _banksCache: BankInfo[] | null = null;
  private _banksCacheTime = 0;
  private static readonly BANKS_CACHE_TTL_MS = 60_000;

  /** Callback invoked when I/O activity state changes (busy/idle or connected/disconnected). */
  onActivity?: (status: { connected: boolean; busy: boolean }) => void;

  /** Callback invoked for every retain/recall I/O operation with details. */
  onIO?: (event: { op: 'retain' | 'recall'; bank: string; detail: string; meta?: Record<string, unknown> }) => void;

  /** Number of in-flight API requests. */
  get activeOps(): number { return this._activeOps; }

  /** Whether the last request succeeded (connection is alive). */
  get connected(): boolean { return this._connected; }

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
   */
  async retainOne(
    bankId: string,
    content: string,
    context: string,
  ): Promise<RetainResult> {
    return this.retain(bankId, [
      { content, context, timestamp: new Date().toISOString() },
    ]);
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
      log.error(`Hindsight request failed: ${method} ${path}`, { error: msg });
      throw new HindsightError(msg, 0, `${method} ${path}`);
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
      log.error(`Hindsight API error: ${method} ${path} → ${res.status}`, { message });
      throw new HindsightError(message, res.status, `${method} ${path}`);
    }

    this._activeOps--;
    this._connected = true;
    this.emitActivity();

    // Some endpoints return no body (204, etc.)
    const text = await res.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }
}
