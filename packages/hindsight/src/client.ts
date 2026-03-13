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
