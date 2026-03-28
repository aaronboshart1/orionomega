/**
 * @module memory/context-assembler
 * Assembles optimally-sized context for each API turn using a hot window
 * (recent messages verbatim) plus Hindsight recall (relevant prior context).
 *
 * Replaces the old "accumulate history, compact when full" model.
 * Every message is retained to Hindsight immediately; each turn queries
 * for exactly the context that fits within the token budget.
 */

import { HindsightClient } from '@orionomega/hindsight';
import { createLogger } from '../logging/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const log = createLogger('context-assembler');

/** A single conversation message. */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

/** Assembled context ready for the API call. */
export interface AssembledContext {
  /** Prior context from Hindsight, formatted as a system block. */
  priorContext: string | null;
  /** Recent messages (hot window), always included verbatim. */
  hotMessages: ConversationMessage[];
  /** Estimated total input tokens for this context. */
  estimatedTokens: number;
}

/** Configuration for the ContextAssembler. */
export interface ContextAssemblerConfig {
  hotWindowSize?: number;
  /** Max tokens to request from Hindsight recall. Default: 30000. */
  recallBudgetTokens?: number;
  /** Max total input tokens per turn. Default: 60000. */
  maxTurnTokens?: number;
  /** System prompt token estimate (subtracted from budget). Default: 4000. */
  systemPromptTokens?: number;
  /** Reserved tokens for model output. Default: 4096. */
  outputReserveTokens?: number;
  /** Hindsight bank for this conversation session. */
  conversationBank?: string;
  /** Additional banks to query (e.g. project-*, jarvis-core). */
  additionalBanks?: string[];
  /** Hindsight recall budget level. Default: 'mid'. */
  recallBudget?: 'low' | 'mid' | 'high';
  /** Path to persist hot window to disk. If set, survives gateway restarts. */
  persistPath?: string;
}

const DEFAULT_HOT_WINDOW = 20;
const DEFAULT_RECALL_BUDGET = 30_000;
const DEFAULT_MAX_TURN_TOKENS = 60_000;
const DEFAULT_SYSTEM_PROMPT_TOKENS = 4_000;
const DEFAULT_OUTPUT_RESERVE = 4_096;

/**
 * Rough token estimate: ~4 chars per token for English text.
 * Not precise, but good enough for budgeting.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Manages conversation context by combining a hot window of recent messages
 * with budget-aware Hindsight recall. Every message is retained to Hindsight
 * on arrival; each turn assembles exactly the right amount of context.
 */
export class ContextAssembler {
  /** Small recency buffer (last few messages for conversational coherence). All older context is query-built per turn via Hindsight. */
  private hotWindow: ConversationMessage[] = [];
  private readonly hotWindowSize: number;
  private readonly recallBudgetTokens: number;
  private readonly maxTurnTokens: number;
  private readonly systemPromptTokens: number;
  private readonly outputReserve: number;
  private conversationBank: string | null;
  private additionalBanks: string[];
  private readonly recallBudget: 'low' | 'mid' | 'high';
  private readonly persistPath: string | null;
  private hs: HindsightClient | null;

  /** Track total messages seen (for logging). */
  private totalMessageCount = 0;

  constructor(hs: HindsightClient | null, config: ContextAssemblerConfig = {}) {
    this.hs = hs;
    this.hotWindowSize = config.hotWindowSize ?? DEFAULT_HOT_WINDOW;
    this.recallBudgetTokens = config.recallBudgetTokens ?? DEFAULT_RECALL_BUDGET;
    this.maxTurnTokens = config.maxTurnTokens ?? DEFAULT_MAX_TURN_TOKENS;
    this.systemPromptTokens = config.systemPromptTokens ?? DEFAULT_SYSTEM_PROMPT_TOKENS;
    this.outputReserve = config.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE;
    this.conversationBank = config.conversationBank ?? null;
    this.additionalBanks = config.additionalBanks ?? [];
    this.recallBudget = config.recallBudget ?? 'mid';
    this.persistPath = config.persistPath ?? null;

    // Restore hot window from disk if available
    if (this.persistPath) {
      this.loadFromDisk();
    }

    log.info('ContextAssembler initialised', {
      hotWindowSize: this.hotWindowSize,
      recallBudgetTokens: this.recallBudgetTokens,
      maxTurnTokens: this.maxTurnTokens,
      conversationBank: this.conversationBank,
      persistPath: this.persistPath,
      restoredMessages: this.hotWindow.length,
    });
  }

  /**
   * Add a message to the hot window and retain to Hindsight.
   * Call this for every user message, assistant response, and system event.
   */
  async push(message: ConversationMessage): Promise<void> {
    const msg = { ...message, timestamp: message.timestamp ?? new Date().toISOString() };

    // Add to hot window ring buffer
    this.hotWindow.push(msg);
    if (this.hotWindow.length > this.hotWindowSize) {
      this.hotWindow = this.hotWindow.slice(-this.hotWindowSize);
    }
    this.totalMessageCount++;

    // Persist to disk (sync — fast for 20 messages)
    this.saveToDisk();

    // Retain to Hindsight (fire-and-forget)
    if (this.hs && this.conversationBank) {
      this.retainMessage(msg).catch((err) => {
        log.warn('Failed to retain message to Hindsight', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Assemble context for the next API call.
   * Returns prior context from Hindsight + hot window messages.
   *
   * @param currentQuery - The user's current message (used as recall query).
   * @returns Assembled context ready for the API call.
   */
  async assemble(currentQuery: string): Promise<AssembledContext> {
    const hotTokens = this.hotWindow.reduce(
      (sum, m) => sum + estimateTokens(m.content), 0,
    );

    const availableForRecall = Math.max(
      0,
      this.maxTurnTokens - this.systemPromptTokens - this.outputReserve - hotTokens,
    );
    const recallTokens = Math.min(availableForRecall, this.recallBudgetTokens);

    let priorContext: string | null = null;
    let recalledTokens = 0;

    if (this.hs && recallTokens > 500) {
      try {
        const isShort = this.isShortReply(currentQuery);
        const recallQuery = isShort
          ? this.augmentQueryWithRecentContext(currentQuery)
          : currentQuery;
        const recalled = await this.recallFromBanks(recallQuery, recallTokens, currentQuery);
        if (recalled) {
          priorContext = recalled;
          recalledTokens = estimateTokens(recalled);
        }
      } catch (err) {
        log.warn('Hindsight recall failed, continuing with hot window only', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const estimatedTokens = this.systemPromptTokens + recalledTokens + hotTokens;

    log.debug('Context assembled', {
      hotMessages: this.hotWindow.length,
      hotTokens,
      recalledTokens,
      totalEstimated: estimatedTokens,
      totalMessagesSeen: this.totalMessageCount,
    });

    return {
      priorContext,
      hotMessages: [...this.hotWindow],
      estimatedTokens,
    };
  }

  /**
   * Get the hot window messages (for direct access, e.g. compaction flush).
   */
  getHotWindow(): ConversationMessage[] {
    return [...this.hotWindow];
  }

  /**
   * Get all messages as a simple history array (backward compat).
   */
  getHistory(): { role: string; content: string }[] {
    return this.hotWindow.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Clear the hot window (e.g. on /reset).
   */
  clear(): void {
    this.hotWindow = [];
    this.totalMessageCount = 0;
    this.saveToDisk();
    log.info('Context assembler cleared');
  }

  /** Total messages processed in this session. */
  get messageCount(): number {
    return this.totalMessageCount;
  }

  /**
   * Update the Hindsight client reference (e.g. after deferred init).
   */
  setHindsightClient(hs: HindsightClient): void {
    this.hs = hs;
    log.info('Hindsight client attached to context assembler');
  }

  /**
   * Update the conversation bank (e.g. after project bank is resolved).
   */
  setConversationBank(bank: string): void {
    this.conversationBank = bank;
    log.info('Conversation bank set', { bank });
  }

  /**
   * Add an additional recall bank.
   */
  addBank(bank: string): void {
    if (!this.additionalBanks.includes(bank)) {
      this.additionalBanks.push(bank);
    }
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * Retain a single message to the conversation bank in Hindsight.
   */
  private async retainMessage(msg: ConversationMessage): Promise<void> {
    if (!this.hs || !this.conversationBank) return;

    await this.hs.retain(this.conversationBank, [
      {
        content: `[${msg.role}] ${msg.content}`,
        context: `conversation_${msg.role}`,
        timestamp: msg.timestamp ?? new Date().toISOString(),
      },
    ]);
  }

  /**
   * Detect whether a user message is a short conversational reply
   * (e.g. "fix all but #7", "yes", "do the second one").
   * Short replies should bias heavily toward the conversation bank.
   */
  private isShortReply(rawQuery: string): boolean {
    const trimmed = rawQuery.trim();
    const tokenEstimate = estimateTokens(trimmed);

    const crossSessionPattern = /\b(last (week|month|time|session)|earlier|previous(ly)?|we (decided|discussed|agreed|talked)|yesterday|ago|history|before)\b/i;
    if (crossSessionPattern.test(trimmed)) return false;

    const directRefPattern = /(?:^|\s)(#\d+|number \d+|\b(first|second|third|fourth|fifth|last|that|those|this|these) (one|option|item|change|suggestion)\b)/i;
    const shortReplyPattern = /^(yes|no|ok|sure|do it|go ahead|that one|fix|skip|all|fix all|do all|do \w+ but)/i;

    if (tokenEstimate < 15 && (directRefPattern.test(trimmed) || shortReplyPattern.test(trimmed))) return true;
    if (tokenEstimate < 8) return true;
    if (tokenEstimate < 50 && (directRefPattern.test(trimmed) || shortReplyPattern.test(trimmed))) return true;
    return false;
  }

  /**
   * Augment the raw user query with context from the most recent
   * assistant message in the hot window. This gives semantic search
   * enough signal to match the right conversation memories.
   */
  private augmentQueryWithRecentContext(rawQuery: string): string {
    const MAX_CONTEXT_CHARS = 500;

    const lastAssistant = [...this.hotWindow]
      .reverse()
      .find((m) => m.role === 'assistant');

    if (!lastAssistant) return rawQuery;

    const snippet = lastAssistant.content.length > MAX_CONTEXT_CHARS
      ? '…' + lastAssistant.content.slice(-MAX_CONTEXT_CHARS)
      : lastAssistant.content;

    return `${rawQuery}\n\n[Recent assistant context]: ${snippet}`;
  }

  /**
   * Recall relevant context from conversation bank + additional banks.
   * Results are merged and formatted as a single context block.
   *
   * Applies recency-first bias: conversation bank results appear before
   * additional banks, and within each bank results are sorted newest-first.
   * Short/conversational messages shift budget heavily toward conversation bank.
   */
  private async recallFromBanks(
    query: string,
    maxTokens: number,
    rawQuery: string,
  ): Promise<string | null> {
    if (!this.hs) return null;

    const banks = [
      ...(this.conversationBank ? [this.conversationBank] : []),
      ...this.additionalBanks,
    ];

    if (banks.length === 0) return null;

    const shortReply = this.isShortReply(rawQuery);
    const convShareRatio = shortReply ? 0.85 : 0.6;

    log.debug('Recall budget allocation', {
      shortReply,
      convShareRatio,
      rawQueryLength: rawQuery.length,
    });

    const otherBankCount = banks.length - (this.conversationBank ? 1 : 0);
    const convShare = this.conversationBank
      ? (otherBankCount > 0 ? Math.floor(maxTokens * convShareRatio) : maxTokens)
      : 0;
    const otherShare = otherBankCount > 0
      ? Math.floor((maxTokens - convShare) / otherBankCount)
      : 0;

    const recallPromises = banks.map((bank) => {
      const budget = bank === this.conversationBank ? convShare : otherShare;
      if (budget < 200) return Promise.resolve(null);

      return this.hs!.recall(bank, query, { maxTokens: budget, budget: this.recallBudget })
        .then((response) => {
          if (!response.results || response.results.length === 0) return null;
          const items = response.results.map((r) => ({
            content: r.content,
            timestamp: r.timestamp || '',
          }));
          items.sort((a, b) => {
            if (!a.timestamp && !b.timestamp) return 0;
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;
            return b.timestamp.localeCompare(a.timestamp);
          });
          return {
            bank,
            items: items.map((i) => i.content),
          };
        })
        .catch((err) => {
          log.debug('Recall failed for bank', {
            bank,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
    });

    const results = (await Promise.all(recallPromises)).filter(Boolean) as
      Array<{ bank: string; items: string[] }>;

    if (results.length === 0) return null;

    results.sort((a, b) => {
      const aIsConv = a.bank === this.conversationBank ? 0 : 1;
      const bIsConv = b.bank === this.conversationBank ? 0 : 1;
      return aIsConv - bIsConv;
    });

    const sections = results.map((r) => {
      const header = r.bank === this.conversationBank
        ? '## Earlier in this conversation'
        : `## Context from ${r.bank}`;
      return `${header}\n${r.items.join('\n\n')}`;
    });

    return `[PRIOR CONTEXT — recalled from memory]\n\n${sections.join('\n\n---\n\n')}`;
  }

  // ── Disk Persistence ─────────────────────────────────────────

  /**
   * Save hot window to disk as JSON. Synchronous — 20 messages is tiny.
   */
  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.hotWindow), 'utf-8');
    } catch (err) {
      log.warn('Failed to persist hot window to disk', {
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load hot window from disk. Called once during construction.
   */
  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Validate and take only the last hotWindowSize messages
        this.hotWindow = parsed
          .filter((m: unknown) =>
            typeof m === 'object' && m !== null &&
            'role' in m && 'content' in m &&
            typeof (m as Record<string, unknown>).role === 'string' &&
            typeof (m as Record<string, unknown>).content === 'string'
          )
          .slice(-this.hotWindowSize) as ConversationMessage[];
        this.totalMessageCount = this.hotWindow.length;
        log.info('Hot window restored from disk', {
          path: this.persistPath,
          messageCount: this.hotWindow.length,
        });
      }
    } catch (err) {
      log.warn('Failed to load hot window from disk, starting fresh', {
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
