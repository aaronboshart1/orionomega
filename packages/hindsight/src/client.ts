import { HindsightError } from './errors.js';
import { createLogger } from './logger.js';
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

// ── Retry configuration ────────────────────────────────────────────────────
const HINDSIGHT_MAX_RETRIES = 3;
const HINDSIGHT_RETRY_DELAYS = [500, 1000, 2000]; // ms, exponential backoff

// ── Circuit breaker configuration ─────────────────────────────────────────
const CB_FAILURE_THRESHOLD = 5;    // open after N consecutive failures
const CB_RESET_TIMEOUT_MS = 30_000; // try half-open after 30s
const CB_SUCCESS_THRESHOLD = 2;    // close after N consecutive successes in half-open

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Fetch with a timeout via AbortController.
 */
function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = 10_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  fetchOptions.signal = controller.signal;
  return fetch(url, fetchOptions).finally(() => clearTimeout(timer));
}

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
export class HindsightClient {
  private readonly baseUrl: string;
  private readonly namespace: string;
  private _activeOps = 0;
  private _connected = false;

  // ── Circuit breaker state ──────────────────────────────────────────────
  private _circuitState: CircuitState = 'closed';
  private _failureCount = 0;
  private _successCount = 0;
  private _circuitOpenedAt = 0;

  /** Callback invoked when I/O activity state changes (busy/idle or connected/disconnected). */
  onActivity?: (status: { connected: boolean; busy: boolean }) => void;

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

  /** Check API health and version. Uses a shorter 5s timeout. */
  async health(): Promise<HealthStatus> {
    return this.request<HealthStatus>('GET', '/health', undefined, 5_000);
  }

  // ── Banks ──────────────────────────────────────────────────────────

  /**
   * Create a new memory bank.
   * @param bankId - Unique identifier for the bank.
   * @param config - Bank configuration (name, tuning parameters).
   */
  async createBank(bankId: string, config: BankConfig): Promise<void> {
    await this.request<unknown>('PUT', this.bankPath(bankId), config);
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

  /**
   * Check whether a bank exists.
   * Uses the list endpoint since the API does not support GET on individual banks.
   * @param bankId - The bank identifier.
   * @returns `true` if the bank exists, `false` otherwise.
   */
  async bankExists(bankId: string): Promise<boolean> {
    try {
      const banks = await this.listBanks();
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
    log.verbose(`Retain ← ${bankId}`, { durationMs: Date.now() - start });
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
    log.verbose(`Recall → ${bankId}`, {
      queryPreview: query.slice(0, 200),
      maxTokens: opts?.maxTokens ?? 4096,
      budget: opts?.budget ?? 'mid',
    });
    const raw = await this.request<{ results: Array<Record<string, unknown>> }>(
      'POST',
      `${this.bankPath(bankId)}/memories/recall`,
      {
        query,
        max_tokens: opts?.maxTokens ?? 4096,
        budget: opts?.budget ?? 'mid',
      },
    );

    // Normalize API response: the API returns `text` but our types use `content`
    const result: RecallResult = {
      results: (raw.results ?? []).map((r) => ({
        content: (r.text as string) ?? (r.content as string) ?? '',
        context: (r.context as string) ?? '',
        timestamp: (r.mentioned_at as string) ?? (r.timestamp as string) ?? '',
        relevance: (r.relevance as number) ?? 0,
      })),
      tokens_used: (raw as unknown as Record<string, unknown>).tokens_used as number ?? 0,
    };

    log.verbose(`Recall ← ${bankId}`, {
      durationMs: Date.now() - start,
      resultCount: result.results.length,
    });
    return result;
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

  // ── Circuit breaker helpers ────────────────────────────────────────

  /** Whether the circuit breaker currently allows requests. */
  private circuitAllows(): boolean {
    if (this._circuitState === 'closed') return true;
    if (this._circuitState === 'open') {
      if (Date.now() - this._circuitOpenedAt >= CB_RESET_TIMEOUT_MS) {
        this._circuitState = 'half-open';
        this._successCount = 0;
        log.info('Circuit breaker: half-open — probing Hindsight');
        return true;
      }
      return false;
    }
    // half-open: allow through
    return true;
  }

  /** Record a successful request for circuit breaker state. */
  private circuitRecordSuccess(): void {
    this._failureCount = 0;
    if (this._circuitState === 'half-open') {
      this._successCount++;
      if (this._successCount >= CB_SUCCESS_THRESHOLD) {
        this._circuitState = 'closed';
        log.info('Circuit breaker: closed — Hindsight is healthy');
      }
    }
  }

  /** Record a failed request for circuit breaker state. */
  private circuitRecordFailure(): void {
    this._failureCount++;
    this._successCount = 0;
    if (this._circuitState === 'half-open') {
      this._circuitState = 'open';
      this._circuitOpenedAt = Date.now();
      log.warn('Circuit breaker: re-opened — Hindsight probe failed');
    } else if (this._circuitState === 'closed' && this._failureCount >= CB_FAILURE_THRESHOLD) {
      this._circuitState = 'open';
      this._circuitOpenedAt = Date.now();
      log.warn('Circuit breaker: opened — Hindsight unreachable', { failures: this._failureCount });
    }
  }

  /** Make an HTTP request to the Hindsight API with timeout, retry, and circuit breaker. */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = 10_000,
  ): Promise<T> {
    // Circuit breaker: fail fast when Hindsight is known to be down
    if (!this.circuitAllows()) {
      throw new HindsightError(
        'Hindsight circuit breaker open — service temporarily unavailable',
        503,
        `${method} ${path}`,
      );
    }

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

    let lastError: HindsightError | undefined;

    for (let attempt = 0; attempt <= HINDSIGHT_MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetchWithTimeout(url, { ...init, timeout: timeoutMs });
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const msg = isAbort ? `Request timed out after ${timeoutMs}ms` : (err instanceof Error ? err.message : 'Network error');
        log.warn(`Hindsight request failed: ${method} ${path} (attempt ${attempt + 1})`, { error: msg });
        lastError = new HindsightError(msg, 0, `${method} ${path}`);

        // Retry on network/timeout errors (but not on last attempt)
        if (attempt < HINDSIGHT_MAX_RETRIES) {
          const delay = HINDSIGHT_RETRY_DELAYS[attempt] ?? 2000;
          await new Promise<void>((r) => setTimeout(r, delay));
          continue;
        }

        this._activeOps--;
        this._connected = false;
        this.emitActivity(); // emit once: both _activeOps and _connected may have changed
        this.circuitRecordFailure();
        log.error(`Hindsight request failed after ${HINDSIGHT_MAX_RETRIES} retries: ${method} ${path}`, { error: msg });
        throw lastError;
      }

      if (!res.ok) {
        // Retry on 503/429/5xx (but not on last attempt, and not on 4xx)
        const isRetryable = res.status === 429 || res.status === 503 || res.status >= 500;
        if (isRetryable && attempt < HINDSIGHT_MAX_RETRIES) {
          const delay = HINDSIGHT_RETRY_DELAYS[attempt] ?? 2000;
          log.warn(`Hindsight ${res.status} on ${method} ${path} — retrying in ${delay}ms (attempt ${attempt + 1})`);
          await new Promise<void>((r) => setTimeout(r, delay));
          continue;
        }

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
        if (isRetryable) this.circuitRecordFailure();
        else this.circuitRecordSuccess(); // 4xx is server healthy, bad request
        throw new HindsightError(message, res.status, `${method} ${path}`);
      }

      // Success path
      this._activeOps--;
      this._connected = true;
      this.emitActivity();
      this.circuitRecordSuccess();

      // Some endpoints return no body (204, etc.)
      const text = await res.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    }

    // Should not reach here, but TypeScript requires a return
    this._activeOps--;
    this.emitActivity();
    throw lastError ?? new HindsightError('Request failed after retries', 0, `${method} ${path}`);
  }

}
