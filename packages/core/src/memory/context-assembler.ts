/**
 * @module memory/context-assembler
 * Rebuilds the model's context from memory on every turn, within a token budget.
 *
 * ── THE PROPERTY THIS FILE EXISTS TO PRESERVE ─────────────────────────────
 *
 *   Context is rebuilt from memory each turn within an explicit token budget.
 *   There is no conversation compaction and no naive sliding window.
 *
 * That property is about fifteen lines of arithmetic. The previous revision of
 * this file was ~899 lines, because retrieval machinery accreted around it and
 * was mistaken for the requirement itself. docs/memory-architecture-v2.md
 * §12 lists what was deleted rather than ported, and why:
 *
 *   scope federation          — auto-discovered every populated scope and issued
 *                               up to 4 recalls each. Superseded by explicit
 *                               scopes (§10); the store's index spans them all.
 *   dynamic-summary fallback  — fired on every cold turn, issued 3 extra recalls
 *                               per scope, and REPLACED detailed recall instead
 *                               of augmenting it.
 *   buildCausalChain          — reordered and rewrote recalled text before the
 *                               model saw it.
 *   query classifier + strategy table — 5-way classification driving per-type
 *                               budget ratios. `isExternalAction` survives; the
 *                               rest did not earn its ~200 lines.
 *   confidence summaries      — display-only, pinned byte-for-byte by tests.
 *   temporal-diversity buckets — a multi-bucket recall mode with no analogue
 *                               here; recall is lexical and single-pass.
 *
 * ── WHAT IS PINNED ────────────────────────────────────────────────────────
 *
 *   1. `assemble()` NEVER drops hot-window messages. Only `push()` trims.
 *   2. Recall is skipped when the computed budget is <= 500 tokens.
 *   3. `estimatedTokens = systemPromptTokens + recalledTokens + mapTokens + hotTokens`
 *      — deliberately excludes `outputReserve`, which is headroom, not input.
 *   4. `isExternalAction(query)` short-circuits recall entirely.
 *
 * ── THE BUDGET BUG THIS FIXES ─────────────────────────────────────────────
 *
 * Production asked for 30 000 recall tokens and received <= ~8 192, because the
 * old transport silently clamped to a per-tier cap. Removing that cap without
 * adding overflow handling would have swung the other way, so recall output is
 * now explicitly fitted to the budget and re-measured (§6.2).
 */

import { estimateTokens, smartTruncate } from '@orionomega/shared/similarity';
import { createLogger } from '../logging/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isExternalAction } from './query-classifier.js';
import { isMemoryExpired } from './retention-engine.js';
import type { ContentBlock } from '../anthropic/client.js';
import { contentToText } from '../utils/content.js';
import type { MemoryStore, MemoryWrite, RecalledRecord } from './store.js';

const log = createLogger('context-assembler');

/** A single conversation message. */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  /**
   * Plain text or an Anthropic multimodal content-block array. The hot window,
   * persistence and retention layers all preserve non-string content; helpers
   * in `utils/content.ts` flatten it where text is needed.
   */
  content: string | ContentBlock[];
  timestamp?: string;
}

/** Assembled context ready for the API call. */
export interface AssembledContext {
  /** Recalled prior context, formatted as a system block. */
  priorContext: string | null;
  /** The Memory Map — what exists beyond the verbatim window (§9). */
  memoryMap: string | null;
  /** Recent messages, always included verbatim. */
  hotMessages: ConversationMessage[];
  /** Estimated input tokens for this turn. */
  estimatedTokens: number;
}

export interface ContextAssemblerConfig {
  hotWindowSize?: number;
  /** Max tokens to spend on recall. Default 16 384. */
  recallBudgetTokens?: number;
  /** Max total input tokens per turn. Default 128 000. */
  maxTurnTokens?: number;
  /** System prompt allowance, subtracted from the budget. Default 15 000. */
  systemPromptTokens?: number;
  /** Reserved for model output. Default 4 096. */
  outputReserveTokens?: number;
  /** Scope holding this conversation's messages. */
  conversationScope?: string;
  /**
   * Additional scopes to recall from, e.g. `['core']`.
   *
   * Explicit and small — NOT the deleted federation, which discovered every
   * populated bank at runtime. One cheap recall per named scope.
   */
  additionalScopes?: string[];
  /** Tag retained messages with this session for provenance. */
  sessionId?: string;
  /** Persist the hot window here so it survives a gateway restart. */
  persistPath?: string;
  /** Relevance floor for recalled records. Default 0.15. */
  minRelevance?: number;
  /** Token ceiling for the Memory Map block. Default 600. */
  memoryMapTokens?: number;
}

const DEFAULT_HOT_WINDOW = 20;
const DEFAULT_RECALL_BUDGET = 16_384;
const DEFAULT_MAX_TURN_TOKENS = 128_000;
const DEFAULT_SYSTEM_PROMPT_TOKENS = 15_000;
const DEFAULT_OUTPUT_RESERVE = 4_096;
const DEFAULT_MIN_RELEVANCE = 0.15;
const DEFAULT_MEMORY_MAP_TOKENS = 600;
/** Hot window token ceiling before oldest messages are evicted. */
const HOT_WINDOW_TOKEN_BUDGET = 30_000;
/** Recall queries are clamped to this, so a long paste cannot become the query. */
const MAX_QUERY_TOKENS = 450;
/** Below this the recall block is not worth its own overhead. */
const MIN_RECALL_TOKENS = 500;

export class ContextAssembler {
  private store: MemoryStore | null;
  private hotWindow: ConversationMessage[] = [];
  private totalMessageCount = 0;

  private readonly hotWindowSize: number;
  private readonly recallBudgetTokens: number;
  private readonly maxTurnTokens: number;
  private readonly systemPromptTokens: number;
  private readonly outputReserve: number;
  private readonly minRelevance: number;
  private readonly memoryMapTokens: number;
  private readonly persistPath: string | null;
  private readonly sessionId: string | null;
  private conversationScope: string | null;
  private additionalScopes: string[];

  private retainBuffer: MemoryWrite[] = [];
  private retainFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RETAIN_FLUSH_SIZE = 3;
  private static readonly RETAIN_FLUSH_INTERVAL_MS = 5_000;

  onMemoryEvent?: (
    op: 'retain' | 'recall' | 'dedup' | 'quality' | 'bootstrap' | 'flush' | 'summary' | 'tool',
    detail: string,
    scope?: string,
    meta?: Record<string, unknown>,
  ) => void;

  constructor(store: MemoryStore | null, config: ContextAssemblerConfig = {}) {
    this.store = store;
    this.hotWindowSize = config.hotWindowSize ?? DEFAULT_HOT_WINDOW;
    this.recallBudgetTokens = config.recallBudgetTokens ?? DEFAULT_RECALL_BUDGET;
    this.maxTurnTokens = config.maxTurnTokens ?? DEFAULT_MAX_TURN_TOKENS;
    this.systemPromptTokens = config.systemPromptTokens ?? DEFAULT_SYSTEM_PROMPT_TOKENS;
    this.outputReserve = config.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE;
    this.minRelevance = config.minRelevance ?? DEFAULT_MIN_RELEVANCE;
    this.memoryMapTokens = config.memoryMapTokens ?? DEFAULT_MEMORY_MAP_TOKENS;
    this.conversationScope = config.conversationScope ?? null;
    this.additionalScopes = config.additionalScopes ?? [];
    this.persistPath = config.persistPath ?? null;
    this.sessionId = config.sessionId ?? null;

    if (this.persistPath) this.loadFromDisk();

    log.info('ContextAssembler initialised', {
      hotWindowSize: this.hotWindowSize,
      recallBudgetTokens: this.recallBudgetTokens,
      maxTurnTokens: this.maxTurnTokens,
      conversationScope: this.conversationScope,
      additionalScopes: this.additionalScopes,
      restoredMessages: this.hotWindow.length,
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Append a message. Trims the hot window; never blocks on the store. */
  async push(message: ConversationMessage): Promise<void> {
    const msg: ConversationMessage = {
      ...message,
      timestamp: message.timestamp ?? new Date().toISOString(),
    };
    this.hotWindow.push(msg);

    if (this.hotWindow.length > this.hotWindowSize) {
      this.hotWindow = this.hotWindow.slice(-this.hotWindowSize);
    }
    // Token-aware eviction, floored at 2 messages so a single huge message
    // cannot empty the window.
    while (this.hotWindow.length > 2) {
      const total = this.hotWindow.reduce(
        (sum, m) => sum + estimateTokens(contentToText(m.content)),
        0,
      );
      if (total <= HOT_WINDOW_TOKEN_BUDGET) break;
      this.hotWindow.shift();
    }
    this.totalMessageCount++;

    this.saveToDisk();

    if (this.store && this.conversationScope) {
      this.retainMessage(msg).catch((err) => {
        log.debug('Failed to retain message', {
          scope: this.conversationScope,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Build the context for the next API call.
   *
   * Read-only with respect to assembler state — it does not push the query and
   * it never drops hot-window messages.
   */
  async assemble(currentQuery: string): Promise<AssembledContext> {
    const hotTokens = this.hotWindow.reduce(
      (sum, m) => sum + estimateTokens(contentToText(m.content)),
      0,
    );

    const availableForRecall = Math.max(
      0,
      this.maxTurnTokens - this.systemPromptTokens - this.outputReserve - hotTokens,
    );
    const recallTokens = Math.min(availableForRecall, this.recallBudgetTokens);

    let priorContext: string | null = null;
    let recalledTokens = 0;

    const external = isExternalAction(currentQuery);
    if (external) {
      this.onMemoryEvent?.('recall', 'Skipping recall for external action query', undefined, {
        recallTokens: 0,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      });
    }

    if (this.store && recallTokens > MIN_RECALL_TOKENS && !external) {
      try {
        this.onMemoryEvent?.('recall', `Assembling context (budget: ${recallTokens} tokens)`, undefined, {
          recallTokens,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        });

        const records = await this.recallAcrossScopes(currentQuery, recallTokens);
        if (records.length > 0) {
          priorContext = this.formatPriorContext(records, recallTokens);
          recalledTokens = estimateTokens(priorContext);
          this.onMemoryEvent?.('recall', `Recalled ${recalledTokens} tokens of prior context`, undefined, {
            recalledTokens,
            records: records.length,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          });
        }
      } catch (err) {
        log.warn('Recall failed, continuing with hot window only', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const memoryMap = await this.buildMap();
    const mapTokens = memoryMap ? estimateTokens(memoryMap) : 0;

    const estimatedTokens = this.systemPromptTokens + recalledTokens + mapTokens + hotTokens;

    log.debug('Context assembled', {
      hotMessages: this.hotWindow.length,
      hotTokens,
      recalledTokens,
      mapTokens,
      totalEstimated: estimatedTokens,
      totalMessagesSeen: this.totalMessageCount,
    });

    return { priorContext, memoryMap, hotMessages: [...this.hotWindow], estimatedTokens };
  }

  getHotWindow(): ConversationMessage[] {
    return [...this.hotWindow];
  }

  getHistory(): { role: string; content: string | ContentBlock[] }[] {
    return this.hotWindow.map((m) => ({ role: m.role, content: m.content }));
  }

  clear(): void {
    this.hotWindow = [];
    this.totalMessageCount = 0;
    this.saveToDisk();
    log.info('Context assembler cleared');
  }

  get messageCount(): number {
    return this.totalMessageCount;
  }

  setMemoryStore(store: MemoryStore): void {
    this.store = store;
  }

  setConversationScope(scope: string): void {
    this.conversationScope = scope;
  }

  addScope(scope: string): void {
    if (!this.additionalScopes.includes(scope)) this.additionalScopes.push(scope);
  }

  /** Flush buffered messages. Safe at any time; no-ops when empty. */
  async flushRetainBuffer(): Promise<void> {
    if (!this.store || !this.conversationScope || this.retainBuffer.length === 0) return;
    const items = this.retainBuffer.splice(0);
    try {
      await this.store.retain(this.conversationScope, items, { async: true });
      this.onMemoryEvent?.('flush', `Flushed ${items.length} buffered messages to memory`, this.conversationScope, {
        count: items.length,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      });
    } catch (err) {
      log.debug('Retain buffer flush failed', {
        scope: this.conversationScope,
        count: items.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Flush pending writes and release timers. Call before discarding. */
  async destroy(): Promise<void> {
    if (this.retainFlushTimer) {
      clearTimeout(this.retainFlushTimer);
      this.retainFlushTimer = null;
    }
    await this.flushRetainBuffer();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Recall from the conversation scope plus any explicitly configured extras.
   *
   * One cheap call per named scope — not the deleted federation, which
   * discovered every populated bank at runtime and issued several recalls each.
   * Results merge by descending relevance so the budget is spent on the best
   * matches regardless of which scope produced them.
   */
  private async recallAcrossScopes(query: string, budget: number): Promise<RecalledRecord[]> {
    const scopes = [
      ...(this.conversationScope ? [this.conversationScope] : []),
      ...this.additionalScopes,
    ];
    if (scopes.length === 0 || !this.store) return [];

    const recallQuery = estimateTokens(query) > MAX_QUERY_TOKENS
      ? smartTruncate(query, MAX_QUERY_TOKENS)
      : query;

    // Ask each scope for the full budget and let the merge decide — asking for
    // budget/N would starve a scope that legitimately holds everything relevant.
    const results = await Promise.all(
      scopes.map((scope) =>
        this.store!.recall(scope, recallQuery, {
          maxTokens: budget,
          minRelevance: this.minRelevance,
        }).catch((err) => {
          log.debug('Recall failed for scope', {
            scope,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }),
      ),
    );

    const merged: RecalledRecord[] = [];
    for (const r of results) {
      if (!r) continue;
      for (const rec of r.records) {
        // Expiry is advisory and filtered at read time (§15).
        if (rec.timestamp && isMemoryExpired(rec.context, rec.timestamp)) continue;
        merged.push(rec);
      }
    }
    merged.sort((a, b) => b.relevance - a.relevance);
    return merged;
  }

  /**
   * Render recalled records, fitted to the budget.
   *
   * Fitting is explicit and re-measured. `smartTruncate` cuts on a 3.5
   * chars/token assumption while `estimateTokens` uses 3.2 for code-like text,
   * so a single truncation can still measure over budget — recalled context is
   * routinely code-like (§6.2).
   */
  private formatPriorContext(records: RecalledRecord[], maxTokens: number): string {
    const lines: string[] = ['[PRIOR CONTEXT — recalled from memory]'];
    let used = estimateTokens(lines[0]!);

    for (const r of records) {
      const entry =
        `\n[relevance ${r.relevance.toFixed(2)}${r.context ? ` · ${r.context}` : ''}` +
        `${r.timestamp ? ` · ${r.timestamp.slice(0, 10)}` : ''}]\n${r.content}`;
      const cost = r.estimatedTokens ?? estimateTokens(entry);
      if (used + cost > maxTokens) continue; // smaller later records may still fit
      lines.push(entry);
      used += cost;
    }

    let out = lines.join('\n');
    // Overflow clamp: re-measure after truncating, since the truncation ratio
    // and the estimation ratio disagree on code-like text.
    for (let i = 0; i < 3 && estimateTokens(out) > maxTokens; i++) {
      out = smartTruncate(out, maxTokens);
    }
    return out;
  }

  /** The Memory Map block, when the store can produce one. */
  private async buildMap(): Promise<string | null> {
    if (!this.store || !this.conversationScope) return null;
    const builder = (this.store as { buildMemoryMap?: (scope: string, o?: unknown) => Promise<string | null> })
      .buildMemoryMap;
    if (typeof builder !== 'function') return null;
    try {
      return await builder.call(this.store, this.conversationScope, {
        maxTokens: this.memoryMapTokens,
      });
    } catch (err) {
      log.debug('Memory map unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Buffer a message for retention, flushing on size or a short timer. */
  private async retainMessage(msg: ConversationMessage): Promise<void> {
    if (!this.store || !this.conversationScope) return;

    const text = contentToText(msg.content);
    const tags: string[] = [];
    if (this.sessionId) tags.push(`session:${this.sessionId}`);

    this.retainBuffer.push({
      content: `[${msg.role}] ${text}`,
      context: `conversation_${msg.role}`,
      timestamp: msg.timestamp ?? new Date().toISOString(),
      documentId: `conv-${this.sessionId ?? 'anon'}-${this.totalMessageCount}`,
      ...(tags.length ? { tags } : {}),
    });

    this.onMemoryEvent?.('retain', `Buffered ${msg.role} message (${text.length} chars)`, this.conversationScope, {
      role: msg.role,
      chars: text.length,
      bufferSize: this.retainBuffer.length,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });

    if (this.retainBuffer.length >= ContextAssembler.RETAIN_FLUSH_SIZE) {
      if (this.retainFlushTimer) {
        clearTimeout(this.retainFlushTimer);
        this.retainFlushTimer = null;
      }
      await this.flushRetainBuffer();
    } else if (!this.retainFlushTimer) {
      this.retainFlushTimer = setTimeout(() => {
        this.retainFlushTimer = null;
        this.flushRetainBuffer().catch((err) => {
          log.debug('Timed retain flush failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, ContextAssembler.RETAIN_FLUSH_INTERVAL_MS);
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(
        this.persistPath,
        JSON.stringify({ hotWindow: this.hotWindow, totalMessageCount: this.totalMessageCount }),
        'utf-8',
      );
    } catch (err) {
      log.warn('Failed to persist hot window', {
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf-8')) as {
        hotWindow?: ConversationMessage[];
        totalMessageCount?: number;
      };
      if (Array.isArray(raw.hotWindow)) this.hotWindow = raw.hotWindow;
      if (typeof raw.totalMessageCount === 'number') this.totalMessageCount = raw.totalMessageCount;
    } catch (err) {
      log.warn('Failed to restore hot window', {
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
