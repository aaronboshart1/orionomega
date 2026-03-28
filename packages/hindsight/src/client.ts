import { HindsightError } from './errors.js';
import { createLogger } from './logger.js';
import { computeClientRelevance, deduplicateByContent, trigramSimilarity } from './similarity.js';
import type {
  BankConfig,
  BankInfo,
  HealthStatus,
  MemoryItem,
  MentalModel,
  RecallOptions,
  RecallResult,
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
   */
  constructor(baseUrl: string, namespace: string = 'default') {
    // Strip trailing slash for consistent URL building
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.namespace = namespace;
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
    log.verbose(`Retain → ${bankId}`, {
      itemCount: items.length,
      contexts: items.map(i => i.context),
      totalChars: items.reduce((sum, i) => sum + (i.content?.length ?? 0), 0),
    });
    const result = await this.request<RetainResult>(
      'POST',
      `${this.bankPath(bankId)}/memories`,
      { items },
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

    log.verbose(`Recall → ${bankId}`, {
      queryPreview: query.slice(0, 200),
      maxTokens: effectiveMaxTokens,
      budget: tier,
      tierCap,
    });
    const body: Record<string, unknown> = {
      query,
      max_tokens: effectiveMaxTokens,
      budget: tier,
    };
    if (opts?.maxCandidates) {
      body.max_candidates = opts.maxCandidates;
    }
    if (opts?.before) {
      body.before = opts.before;
    }

    const raw = await this.request<{ results: Array<Record<string, unknown>> }>(
      'POST',
      `${this.bankPath(bankId)}/memories/recall`,
      body,
    );

    const minRelevance = opts?.minRelevance ?? 0.3;
    const shouldDedup = opts?.deduplicate !== false;
    const dedupThreshold = opts?.deduplicationThreshold ?? 0.85;

    let allResults = (raw.results ?? []).map((r) => ({
      content: (r.text as string) ?? (r.content as string) ?? '',
      context: (r.context as string) ?? '',
      timestamp: (r.mentioned_at as string) ?? (r.timestamp as string) ?? '',
      relevance: (r.relevance as number) ?? 0,
    }));

    // ── Fix 1: Client-side relevance when API returns all zeros ──
    // The Hindsight API sometimes returns relevance=0 for all results.
    // When this happens, compute client-side relevance scores so that
    // the minRelevance filter and confidence propagation still work.
    const allZeroRelevance = allResults.length > 0 &&
      allResults.every((r) => r.relevance === 0);

    if (allZeroRelevance) {
      log.verbose('API returned all-zero relevance scores, computing client-side relevance', {
        bankId,
        resultCount: allResults.length,
      });
      allResults = allResults.map((r) => ({
        ...r,
        relevance: computeClientRelevance(query, r.content),
      }));
    }

    let filtered = allResults.filter((r) => r.relevance >= minRelevance);

    log.verbose(`Recall relevance filter`, {
      bankId,
      totalFromApi: allResults.length,
      aboveThreshold: filtered.length,
      minRelevance,
      usedClientRelevance: allZeroRelevance,
    });

    if (shouldDedup && filtered.length > 1) {
      filtered.sort((a, b) => b.relevance - a.relevance);
      filtered = deduplicateByContent(filtered, dedupThreshold);
    }

    const result: RecallResult = {
      results: filtered,
      tokens_used: (raw as unknown as Record<string, unknown>).tokens_used as number ?? 0,
    };

    const durationMs = Date.now() - start;
    log.verbose(`Recall ← ${bankId}`, {
      durationMs,
      resultCount: result.results.length,
      droppedByRelevance: allResults.length - filtered.length,
    });

    if (result.results.length > 0) {
      const topScore = Math.max(...result.results.map(r => r.relevance));
      this.onIO?.({
        op: 'recall',
        bank: bankId,
        detail: `Retrieved ${result.results.length} memories (top relevance: ${topScore.toFixed(2)}${allZeroRelevance ? ', client-scored' : ''})`,
        meta: {
          query,
          resultCount: result.results.length,
          totalFromApi: allResults.length,
          droppedByRelevance: allResults.length - filtered.length,
          topScore,
          durationMs,
          clientScored: allZeroRelevance,
          tokensUsed: result.tokens_used,
          budget: tier,
          maxTokens: effectiveMaxTokens,
          minRelevance,
          results: result.results.map(r => ({
            content: r.content,
            context: r.context,
            timestamp: r.timestamp,
            relevance: r.relevance,
          })),
        },
      });
    } else {
      this.onIO?.({
        op: 'recall',
        bank: bankId,
        detail: 'No matching memories found',
        meta: {
          query,
          resultCount: 0,
          totalFromApi: allResults.length,
          droppedByRelevance: allResults.length,
          durationMs,
          budget: tier,
          maxTokens: effectiveMaxTokens,
          minRelevance,
        },
      });
    }
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
          minRelevance: Math.max((opts?.minRelevance ?? 0.3) - 0.1, 0.1),
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
    let final = merged;
    if (shouldDedup && final.length > 1) {
      final.sort((a, b) => b.relevance - a.relevance);
      final = deduplicateByContent(final, dedupThreshold);
    }

    const LOW_CONFIDENCE_THRESHOLD = 0.5;
    const lowConfidence = final.length === 0 || final.every((r) => r.relevance < LOW_CONFIDENCE_THRESHOLD);

    return {
      results: final,
      tokens_used: primary.tokens_used + totalTemporalTokens,
      lowConfidence,
    };
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
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
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
      const wasConnected = this._connected;
      this._connected = false;
      if (wasConnected) this.emitActivity();
      else this.emitActivity();
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
