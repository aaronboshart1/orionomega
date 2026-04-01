/**
 * @module memory/context-assembler
 * Assembles optimally-sized context for each API turn using a hot window
 * (recent messages verbatim) plus Hindsight recall (relevant prior context).
 *
 * Replaces the old "accumulate history, compact when full" model.
 * Every message is retained to Hindsight immediately; each turn queries
 * for exactly the context that fits within the token budget.
 *
 * Phase 4 additions:
 * - Adaptive context assembly via query classification
 * - Dynamic project summary generation as fallback
 * - Full confidence score propagation with per-section summaries
 */

import { HindsightClient } from '@orionomega/hindsight';
import { createLogger } from '../logging/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyQuery, getRecallStrategy } from './query-classifier.js';
import type { QueryType, RecallStrategy } from './query-classifier.js';
import { DynamicSummaryGenerator } from './dynamic-summary.js';

const log = createLogger('context-assembler');

/** A single conversation message. */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

/** Per-section confidence breakdown included in assembled context. */
export interface ConfidenceSummary {
  high: number;
  moderate: number;
  low: number;
  total: number;
}

/** Assembled context ready for the API call. */
export interface AssembledContext {
  /** Prior context from Hindsight, formatted as a system block. */
  priorContext: string | null;
  /** Recent messages (hot window), always included verbatim. */
  hotMessages: ConversationMessage[];
  /** Estimated total input tokens for this context. */
  estimatedTokens: number;
  /** Classified query type that drove the recall strategy. */
  queryType?: QueryType;
  /** Aggregate confidence summary across all recalled memories. */
  confidenceSummary?: ConfidenceSummary;
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
  /** Enable cross-bank federation: discover and query all populated banks. Default: true. */
  federateBanks?: boolean;
  /** Minimum relevance score for recalled memories. Default: 0.3. */
  minRelevance?: number;
  /** Similarity threshold for storage-time deduplication. Default: 0.85. */
  storageDeduplicationThreshold?: number;
  /** Fraction of per-bank recall budget reserved for temporal diversity sampling (0–1). Default: 0.15. */
  temporalDiversityRatio?: number;
  /** Enable adaptive query classification for recall strategy. Default: true. */
  adaptiveRecall?: boolean;
  /** Enable dynamic summary fallback when detailed recall exceeds budget. Default: true. */
  dynamicSummaryFallback?: boolean;
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

function computeConfidenceSummary(
  items: Array<{ relevance: number }>,
): ConfidenceSummary {
  let high = 0;
  let moderate = 0;
  let low = 0;
  for (const item of items) {
    if (item.relevance >= 0.7) high++;
    else if (item.relevance >= 0.4) moderate++;
    else low++;
  }
  return { high, moderate, low, total: items.length };
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
  private readonly federateBanks: boolean;
  private readonly minRelevance: number;
  private readonly storageDeduplicationThreshold: number;
  private readonly temporalDiversityRatio: number;
  private readonly adaptiveRecall: boolean;
  private readonly dynamicSummaryFallback: boolean;
  private dynamicSummary: DynamicSummaryGenerator | null = null;

  /** Track total messages seen (for logging). */
  private totalMessageCount = 0;

  onMemoryEvent?: (op: 'retain' | 'recall' | 'dedup' | 'quality' | 'bootstrap' | 'flush' | 'session_anchor' | 'summary' | 'self_knowledge', detail: string, bank?: string, meta?: Record<string, unknown>) => void;

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
    this.federateBanks = config.federateBanks !== false;
    this.minRelevance = config.minRelevance ?? 0.3;
    this.storageDeduplicationThreshold = config.storageDeduplicationThreshold ?? 0.85;
    this.temporalDiversityRatio = config.temporalDiversityRatio ?? 0.15;
    this.adaptiveRecall = config.adaptiveRecall !== false;
    this.dynamicSummaryFallback = config.dynamicSummaryFallback !== false;

    if (hs) {
      this.dynamicSummary = new DynamicSummaryGenerator(hs);
    }

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
      adaptiveRecall: this.adaptiveRecall,
      dynamicSummaryFallback: this.dynamicSummaryFallback,
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
   * Uses adaptive query classification to select the optimal recall strategy.
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
    let queryType: QueryType | undefined;
    let confidenceSummary: ConfidenceSummary | undefined;

    if (this.hs && recallTokens > 500) {
      try {
        const classification = this.adaptiveRecall
          ? classifyQuery(currentQuery)
          : { type: 'task_continuation' as QueryType, confidence: 1 };

        queryType = classification.type;
        const strategy = this.adaptiveRecall
          ? getRecallStrategy(classification)
          : undefined;

        if (queryType === 'external_action') {
          this.onMemoryEvent?.('recall', `Skipping recall for external action query`, undefined, { queryType, recallTokens: 0 });
        }

        if (queryType !== 'external_action') {

        this.onMemoryEvent?.('recall', `Assembling context (${queryType}, budget: ${recallTokens} tokens)`, undefined, { queryType, recallTokens });

        const isShort = this.isShortReply(currentQuery);
        const recallQuery = isShort
          ? this.augmentQueryWithRecentContext(currentQuery)
          : currentQuery;

        const recallResult = await this.recallFromBanks(
          recallQuery,
          recallTokens,
          currentQuery,
          strategy,
        );

        if (recallResult) {
          priorContext = recallResult.formatted;
          recalledTokens = estimateTokens(recallResult.formatted);
          confidenceSummary = recallResult.confidenceSummary;
          this.onMemoryEvent?.('recall', `Recalled ${recalledTokens} tokens of prior context`, undefined, { recalledTokens, confidenceSummary });
        }

        const shouldFallbackToSummary =
          this.dynamicSummaryFallback &&
          this.dynamicSummary &&
          (!priorContext || recalledTokens > recallTokens);

        if (shouldFallbackToSummary) {
          const summaryBudget = Math.min(recallTokens, 4096);
          const summaryBanks = [
            ...(this.conversationBank ? [this.conversationBank] : []),
            ...this.additionalBanks,
          ];
          for (const bank of summaryBanks) {
            const summaryResult = await this.dynamicSummary!.generateProjectSummary(bank, {
              maxTokens: summaryBudget,
            });
            if (summaryResult) {
              const reason = !priorContext
                ? 'no detailed recall available'
                : 'detailed recall exceeded budget, compressed to summary';
              priorContext = `[PRIOR CONTEXT — dynamic summary (${reason})]\n\n${summaryResult.formatted}`;
              recalledTokens = estimateTokens(priorContext);
              confidenceSummary = summaryResult.confidenceSummary;
              break;
            }
          }
        }
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
      queryType,
      confidenceSummary,
    });

    return {
      priorContext,
      hotMessages: [...this.hotWindow],
      estimatedTokens,
      queryType,
      confidenceSummary,
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
    this.dynamicSummary = new DynamicSummaryGenerator(hs);
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

    const formattedContent = `[${msg.role}] ${msg.content}`;

    const isDup = await this.hs.isDuplicateContent(
      this.conversationBank,
      formattedContent,
      this.storageDeduplicationThreshold,
    );
    if (isDup) {
      log.debug('Skipped duplicate message retention', {
        bank: this.conversationBank,
        role: msg.role,
        contentLength: msg.content.length,
      });
      this.onMemoryEvent?.('dedup', `Skipped duplicate ${msg.role} message (${msg.content.length} chars)`, this.conversationBank, { role: msg.role, chars: msg.content.length });
      return;
    }

    await this.hs.retain(this.conversationBank, [
      {
        content: formattedContent,
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
   * Discover additional banks from Hindsight for cross-bank federation.
   */
  private async discoverFederatedBanks(): Promise<string[]> {
    if (!this.hs || !this.federateBanks) return [];
    try {
      const allBanks = await this.hs.listBanksCached();
      const knownSet = new Set([
        ...(this.conversationBank ? [this.conversationBank] : []),
        ...this.additionalBanks,
      ]);
      return allBanks
        .filter((b) => !knownSet.has(b.bank_id) && (b.memory_count ?? 0) > 0)
        .map((b) => b.bank_id);
    } catch (err) {
      log.debug('Bank federation discovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Recall relevant context from conversation bank + additional banks.
   * Results are merged and formatted as a single context block.
   *
   * When a RecallStrategy is provided (from query classification), the
   * strategy overrides default budget splits, temporal diversity, and
   * relevance thresholds to optimize for the query type.
   */
  private async recallFromBanks(
    query: string,
    maxTokens: number,
    rawQuery: string,
    strategy?: RecallStrategy,
  ): Promise<{ formatted: string; confidenceSummary: ConfidenceSummary } | null> {
    if (!this.hs) return null;

    const federatedBanks = await this.discoverFederatedBanks();

    const banks = [
      ...(this.conversationBank ? [this.conversationBank] : []),
      ...this.additionalBanks,
      ...federatedBanks,
    ];

    if (banks.length === 0) return null;

    const convShareRatio = strategy
      ? strategy.convBudgetRatio
      : (this.isShortReply(rawQuery) ? 0.85 : 0.6);

    const effectiveTemporalRatio = strategy
      ? strategy.temporalDiversityRatio
      : this.temporalDiversityRatio;

    const effectiveMinRelevance = strategy
      ? strategy.minRelevance
      : this.minRelevance;

    const effectiveRecallBudget = strategy
      ? strategy.recallBudget
      : this.recallBudget;

    log.debug('Recall budget allocation', {
      convShareRatio,
      rawQueryLength: rawQuery.length,
      totalBanks: banks.length,
      federatedBanks: federatedBanks.length,
      strategy: strategy ? 'adaptive' : 'default',
      temporalDiversityRatio: effectiveTemporalRatio,
      minRelevance: effectiveMinRelevance,
      recallBudget: effectiveRecallBudget,
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

      return this.hs!.recallWithTemporalDiversity(bank, query, {
        maxTokens: budget,
        budget: effectiveRecallBudget,
        minRelevance: effectiveMinRelevance,
        temporalDiversityRatio: effectiveTemporalRatio,
      })
        .then((response) => {
          if (!response.results || response.results.length === 0) return null;
          const items = response.results.map((r) => ({
            content: r.content,
            context: r.context,
            timestamp: r.timestamp || '',
            relevance: r.relevance,
          }));
          items.sort((a, b) => {
            if (!a.timestamp && !b.timestamp) return 0;
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;
            return b.timestamp.localeCompare(a.timestamp);
          });
          return {
            bank,
            items,
            lowConfidence: response.lowConfidence,
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
      Array<{
        bank: string;
        items: Array<{ content: string; context: string; timestamp: string; relevance: number }>;
        lowConfidence: boolean;
      }>;

    if (results.length === 0) return null;

    results.sort((a, b) => {
      const aIsConv = a.bank === this.conversationBank ? 0 : 1;
      const bIsConv = b.bank === this.conversationBank ? 0 : 1;
      return aIsConv - bIsConv;
    });

    const preferredCategories = strategy?.preferredContextCategories ?? [];
    const temporalBias = strategy?.temporalBias ?? 'recent';

    for (const r of results) {
      if (preferredCategories.length > 0) {
        const prefSet = new Set(preferredCategories);
        r.items.sort((a, b) => {
          const aPreferred = prefSet.has(a.context) ? 0 : 1;
          const bPreferred = prefSet.has(b.context) ? 0 : 1;
          if (aPreferred !== bPreferred) return aPreferred - bPreferred;
          return b.relevance - a.relevance;
        });
      }

      if (temporalBias === 'broad') {
        r.items.sort((a, b) => b.relevance - a.relevance);
      } else if (temporalBias === 'recent') {
        r.items.sort((a, b) => {
          if (!a.timestamp && !b.timestamp) return b.relevance - a.relevance;
          if (!a.timestamp) return 1;
          if (!b.timestamp) return -1;
          return b.timestamp.localeCompare(a.timestamp);
        });
      }
    }

    const allItems = results.flatMap((r) => r.items);
    const confidenceSummary = computeConfidenceSummary(allItems);
    const allLowConfidence = results.every((r) => r.lowConfidence);

    const sections = results.map((r) => {
      const header = r.bank === this.conversationBank
        ? '## Earlier in this conversation'
        : `## Context from ${r.bank}`;

      const sectionConf = computeConfidenceSummary(r.items);
      const confLine = `_Confidence: ${sectionConf.high} high, ${sectionConf.moderate} moderate, ${sectionConf.low} low (${sectionConf.total} memories)_`;

      const formattedItems = r.items.map((i) => {
        const score = i.relevance.toFixed(2);
        const ctx = i.context ? ` [${i.context}]` : '';
        const enriched = this.buildCausalChain(i.content);
        return `[confidence: ${score}]${ctx} ${enriched}`;
      });
      return `${header}\n${confLine}\n${formattedItems.join('\n\n')}`;
    });

    const overallConfLine = `**Overall confidence: ${confidenceSummary.high} high, ${confidenceSummary.moderate} moderate, ${confidenceSummary.low} low — ${confidenceSummary.total} memories total**`;

    let output = `[PRIOR CONTEXT — recalled from memory]\n${overallConfLine}\n\n${sections.join('\n\n---\n\n')}`;

    if (allLowConfidence) {
      output = `⚠ Low-confidence recall — results below confidence threshold; treat with caution.\n\n${output}`;
    }

    return { formatted: output, confidenceSummary };
  }

  // ── Causal Chain ────────────────────────────────────────────

  /** Classifies a single line into a causal chain category. */
  private static readonly MarkerClassifier = {
    DECISION: /\b(decided|decision|chose|agreed|ruling|went with|settled on)\b/i,
    ACTION:   /\b(implemented|built|created|deployed|migrated|configured|refactored)\b/i,
    OUTCOME:  /\b(result|outcome|because|resolved|fixed|caused|led to|broke|improved)\b/i,
    categorize(line: string): 'decision' | 'action' | 'outcome' | 'other' {
      if (this.DECISION.test(line)) return 'decision';
      if (this.OUTCOME.test(line)) return 'outcome';
      if (this.ACTION.test(line)) return 'action';
      return 'other';
    },
  } as const;

  private buildCausalChain(content: string): string {
    const lines = content.split('\n').filter(Boolean);
    if (lines.length < 2) return content;

    const decision: string[] = [];
    const action: string[] = [];
    const outcome: string[] = [];
    const other: string[] = [];

    for (const line of lines) {
      switch (ContextAssembler.MarkerClassifier.categorize(line)) {
        case 'decision': decision.push(line); break;
        case 'outcome':  outcome.push(line);  break;
        case 'action':   action.push(line);   break;
        default:         other.push(line);
      }
    }

    if (decision.length === 0 && action.length === 0 && outcome.length === 0) {
      return content;
    }

    const chain: string[] = [];
    if (decision.length > 0) chain.push(`Decision: ${decision.join('; ')}`);
    if (action.length > 0) chain.push(`Action: ${action.join('; ')}`);
    if (outcome.length > 0) chain.push(`Outcome: ${outcome.join('; ')}`);
    if (other.length > 0) chain.push(other.join('\n'));

    return chain.join(' → ');
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
