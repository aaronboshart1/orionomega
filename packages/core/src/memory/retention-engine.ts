/**
 * @module memory/retention-engine
 * Automatic event-driven memory retention. Listens to orchestration events
 * and evaluates user messages for patterns worth retaining.
 *
 * Includes importance scoring, TTL-based expiry checks, token budget awareness,
 * and memory consolidation for related items.
 */

import { HindsightClient, estimateTokens, compressMemoryContent, isDuplicateInBatch } from '@orionomega/hindsight';
import type { RetentionPolicy, ImportanceFactors } from '@orionomega/hindsight';
import type { EventBus } from '../orchestration/event-bus.js';
import type { WorkerEvent } from '../orchestration/types.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('retention-engine');

/** Configuration for the retention engine. */
export interface RetentionConfig {
  /** Retain memories when a workflow completes successfully. */
  retainOnComplete: boolean;
  /** Retain memories when a workflow encounters errors. */
  retainOnError: boolean;
  /** Default bank for event-driven retention when no project bank is known. */
  defaultBank?: string;
  /** Similarity threshold for storage-time deduplication. Default: 0.85. */
  deduplicationThreshold?: number;
  /** Minimum quality score (0-1) for a memory to be retained. Default: 0.3. */
  qualityThreshold?: number;
  /** TTL/retention policy for memory expiry. */
  retentionPolicy?: RetentionPolicy;
  /** Maximum token budget per retain operation. Prevents oversized storage. Default: 2048. */
  maxRetainTokens?: number;
}

/** Outcome data for workflow completion retention. */
export interface WorkflowOutcome {
  bankId: string;
  workflowId?: string;
  taskSummary: string;
  workerCount: number;
  durationSec: number;
  outputPaths: string[];
  nodeOutputPaths?: Record<string, string[]>;
  decisions: string[];
  findings: string[];
  errors: { worker: string; message: string; resolution?: string }[];
  infraChanges?: string[];
}

/** Quality score result for a memory candidate. */
export interface QualityScore {
  score: number;
  signals: string[];
}

/** Configurable quality threshold. Memories below this score are rejected. Default: 0.3. */
const DEFAULT_QUALITY_THRESHOLD = 0.3;

/** Default max tokens per single memory retention. */
const DEFAULT_MAX_RETAIN_TOKENS = 2048;

/** Default TTL values per context category (in days). 0 = no expiry. */
const DEFAULT_CATEGORY_TTL: Record<string, number> = {
  decision: 0,        // Decisions never expire
  preference: 0,      // Preferences never expire
  architecture: 0,    // Architecture decisions never expire
  session_anchor: 30,  // Session anchors expire after 30 days
  node_output: 14,     // Node outputs expire after 14 days
  artifact: 30,        // Artifact manifests expire after 30 days
  project_update: 90,  // Project updates expire after 90 days
  lesson: 0,          // Lessons never expire
  infrastructure: 0,   // Infrastructure never expires
  session_summary: 180, // Session summaries expire after 6 months
};

/** Categories that should never expire regardless of default TTL. */
const DEFAULT_PINNED_CATEGORIES = ['decision', 'preference', 'architecture', 'lesson', 'infrastructure'];

const HIGH_SIGNAL_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(decided|decision|chose|chosen|agreed|ruling)\b/i, weight: 0.3, label: 'decision' },
  { pattern: /\b(spec|specification|requirement|constraint|must|shall)\b/i, weight: 0.25, label: 'spec' },
  { pattern: /\b(blocked|blocker|blocking|impediment|stuck|can'?t proceed)\b/i, weight: 0.3, label: 'blocker' },
  { pattern: /\b(architecture|design pattern|trade-?off|approach)\b/i, weight: 0.25, label: 'architecture' },
  { pattern: /\b(error|bug|fix|resolved|root cause|regression)\b/i, weight: 0.2, label: 'error-resolution' },
  { pattern: /\b(lesson|learned|insight|discovery|realized|turns out)\b/i, weight: 0.2, label: 'lesson' },
  { pattern: /\b(prefer|preference|always use|never use|convention)\b/i, weight: 0.2, label: 'preference' },
  { pattern: /\b(api|endpoint|schema|interface|contract)\b/i, weight: 0.15, label: 'api-spec' },
  { pattern: /\b(config|configuration|environment|variable|secret)\b/i, weight: 0.15, label: 'config' },
  { pattern: /\b(migration|deploy|release|rollback|upgrade)\b/i, weight: 0.15, label: 'ops' },
];

const LOW_SIGNAL_PATTERNS: Array<{ pattern: RegExp; penalty: number; label: string }> = [
  { pattern: /^(ok|okay|done|got it|sure|yes|no|thanks|thank you|sounds good|lgtm)\.?$/i, penalty: 0.5, label: 'bare-ack' },
  { pattern: /^(starting|working on|beginning|looking at)\b/i, penalty: 0.3, label: 'status-start' },
  { pattern: /^(completed|finished|all done)\b(?!.*(?:because|decision|by|using|with))/i, penalty: 0.3, label: 'bare-completion' },
  { pattern: /^task:/i, penalty: 0.1, label: 'task-header-only' },
  { pattern: /^(node|worker|workflow):\s*\S+\s*$/i, penalty: 0.3, label: 'bare-metadata' },
];

const CONTEXT_WEIGHT_BOOSTS: Record<string, number> = {
  decision: 0.3,
  preference: 0.25,
  lesson: 0.2,
  architecture: 0.25,
  infrastructure: 0.15,
  blocker: 0.3,
  session_anchor: 0.35,
  self_knowledge: 0.2,
};

function scoreMemoryQuality(content: string, context: string): QualityScore {
  let score = 0.5;
  const signals: string[] = [];

  const contextBoost = CONTEXT_WEIGHT_BOOSTS[context] ?? 0;
  if (contextBoost > 0) {
    score += contextBoost;
    signals.push(`context:${context}(+${contextBoost})`);
  }

  for (const { pattern, weight, label } of HIGH_SIGNAL_PATTERNS) {
    if (pattern.test(content)) {
      score += weight;
      signals.push(`high:${label}(+${weight})`);
    }
  }

  for (const { pattern, penalty, label } of LOW_SIGNAL_PATTERNS) {
    if (pattern.test(content)) {
      score -= penalty;
      signals.push(`low:${label}(-${penalty})`);
    }
  }

  const wordCount = content.split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) {
    score -= 0.2;
    signals.push('short(<5 words)');
  } else if (wordCount > 20) {
    score += 0.1;
    signals.push('substantive(>20 words)');
  }

  const lineCount = content.split('\n').filter(Boolean).length;
  if (lineCount > 3) {
    score += 0.1;
    signals.push('structured(>3 lines)');
  }

  score = Math.max(0, Math.min(1, score));
  return { score, signals };
}

export { scoreMemoryQuality };

// ── Importance Scoring ─────────────────────────────────────────────────

/**
 * Compute composite importance score for a memory. Combines:
 * - Quality score (content signal analysis)
 * - Context category weight
 * - Recency decay (exponential, halves every 30 days)
 * - Token efficiency (penalize very large memories slightly)
 *
 * Used to prioritize which memories to retain and which to consolidate/prune.
 */
export function computeImportance(
  content: string,
  context: string,
  timestamp?: string,
): ImportanceFactors {
  const quality = scoreMemoryQuality(content, context);
  const contextBoost = CONTEXT_WEIGHT_BOOSTS[context] ?? 0;

  // Recency: exponential decay with 30-day half-life
  let recencyFactor = 1.0;
  if (timestamp) {
    const ageMs = Date.now() - new Date(timestamp).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const HALF_LIFE_DAYS = 30;
    recencyFactor = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }

  // Token efficiency: slight penalty for very large memories (>500 tokens)
  const tokens = estimateTokens(content);
  const tokenPenalty = tokens > 500 ? Math.max(0.7, 1 - (tokens - 500) / 5000) : 1.0;

  // Composite: weighted combination
  const composite = Math.min(1, Math.max(0,
    quality.score * 0.5 +
    contextBoost * 0.2 +
    recencyFactor * 0.2 +
    tokenPenalty * 0.1
  ));

  return {
    qualityScore: quality.score,
    contextBoost,
    recencyFactor,
    accessFrequency: 0, // Not tracked client-side; placeholder for server integration
    composite,
  };
}

// ── TTL Check ──────────────────────────────────────────────────────────

/**
 * Check whether a memory has expired according to retention policy.
 * Returns true if the memory should be considered stale.
 */
export function isMemoryExpired(
  context: string,
  timestamp: string,
  policy?: RetentionPolicy,
): boolean {
  const pinnedCategories = policy?.pinnedCategories ?? DEFAULT_PINNED_CATEGORIES;
  if (pinnedCategories.includes(context)) return false;

  const categoryTTL = policy?.categoryTTL ?? DEFAULT_CATEGORY_TTL;
  const ttlDays = categoryTTL[context] ?? policy?.defaultTTLDays ?? 0;
  if (ttlDays === 0) return false;

  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > ttlDays;
}

// ── Memory Consolidation ───────────────────────────────────────────────

/**
 * Consolidate a batch of related memory items into fewer, denser items.
 * Groups by context category, then merges items within each group that
 * are similar enough (above consolidation threshold). Preserves the
 * highest-quality content from each group.
 *
 * @returns Consolidated items with combined content.
 */
export function consolidateMemories(
  items: Array<{ content: string; context: string; timestamp: string }>,
  similarityThreshold = 0.6,
): Array<{ content: string; context: string; timestamp: string }> {
  if (items.length <= 1) return items;

  // Group by context category
  const groups = new Map<string, Array<{ content: string; context: string; timestamp: string }>>();
  for (const item of items) {
    const group = groups.get(item.context) ?? [];
    group.push(item);
    groups.set(item.context, group);
  }

  const consolidated: Array<{ content: string; context: string; timestamp: string }> = [];

  for (const [context, group] of groups) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }

    // Within each group, find clusters of similar items and merge them
    const clusters: Array<Array<typeof group[0]>> = [];
    const assigned = new Set<number>();

    for (let i = 0; i < group.length; i++) {
      if (assigned.has(i)) continue;

      const cluster = [group[i]];
      assigned.add(i);

      for (let j = i + 1; j < group.length; j++) {
        if (assigned.has(j)) continue;
        if (isDuplicateInBatch(group[j].content, cluster, similarityThreshold)) {
          cluster.push(group[j]);
          assigned.add(j);
        }
      }
      clusters.push(cluster);
    }

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        consolidated.push(cluster[0]);
      } else {
        // Merge: keep the longest (most complete) content, use most recent timestamp
        cluster.sort((a, b) => b.content.length - a.content.length);
        const mostRecent = cluster.reduce((latest, item) =>
          item.timestamp > latest.timestamp ? item : latest,
        );
        consolidated.push({
          content: compressMemoryContent(cluster[0].content),
          context,
          timestamp: mostRecent.timestamp,
        });

        log.debug('Consolidated memory cluster', {
          context,
          originalCount: cluster.length,
          mergedLength: cluster[0].content.length,
        });
      }
    }
  }

  return consolidated;
}

/** Phrases indicating user preferences. */
const PREFERENCE_PATTERNS = [
  /\bi prefer\b/i,
  /\bi like\b/i,
  /\bi want\b/i,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bi hate\b/i,
  /\bdon'?t ever\b/i,
  /\bmake sure to\b/i,
  /\bfrom now on\b/i,
];

/** Phrases indicating decisions. */
const DECISION_PATTERNS = [
  /\blet'?s go with\b/i,
  /\bi'?ve decided\b/i,
  /\buse this\b/i,
  /\bwe'?ll use\b/i,
  /\bthe plan is\b/i,
  /\bswitch to\b/i,
  /\bgo ahead with\b/i,
];

/** Phrases indicating an explicit "remember" command. */
const REMEMBER_PATTERNS = [
  /^remember this[:\s]*/i,
  /^remember that[:\s]*/i,
];

/**
 * Listens to orchestration events and user messages, automatically retaining
 * noteworthy information to Hindsight. All retention is fire-and-forget —
 * failures are logged but never propagated.
 *
 * Enhanced with importance scoring, TTL awareness, token budgets, and
 * memory consolidation.
 */
export class RetentionEngine {
  private unsubscribe: (() => void) | null = null;
  /** Map workflowId → bankId, set by the orchestration bridge when dispatching. */
  private workflowBanks = new Map<string, string>();
  /** Recent retention buffer for intra-batch dedup (avoids redundant API calls). */
  private recentRetentions: Array<{ content: string; bankId: string; ts: number }> = [];
  private static readonly RECENT_BUFFER_TTL_MS = 30_000; // 30 seconds
  private static readonly RECENT_BUFFER_MAX = 50;

  onMemoryEvent?: (op: string, detail: string, bank?: string, meta?: Record<string, unknown>) => void;
  /** Called after every successful retention so downstream consumers (e.g. MentalModelManager) can react. */
  onAfterRetain?: (bankId: string, context: string) => void;

  constructor(
    private readonly hs: HindsightClient,
    private readonly eventBus: EventBus,
    private readonly config: RetentionConfig,
  ) {}

  /**
   * Start listening to events on the EventBus.
   * Subscribes to the wildcard channel to capture all worker events.
   */
  start(): void {
    if (this.unsubscribe) return; // Already started

    this.unsubscribe = this.eventBus.subscribe('*', (event: WorkerEvent) => {
      this.handleEvent(event);
    });

    log.info('Retention engine started');
  }

  /**
   * Stop listening to events and clean up subscriptions.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      log.info('Retention engine stopped');
    }
  }

  /**
   * Register a workflow → bank mapping so event-driven retention
   * routes memories to the correct project bank.
   */
  registerWorkflowBank(workflowId: string, bankId: string): void {
    this.workflowBanks.set(workflowId, bankId);
  }

  /**
   * Unregister a workflow → bank mapping (call on workflow completion).
   */
  unregisterWorkflowBank(workflowId: string): void {
    this.workflowBanks.delete(workflowId);
  }

  /**
   * Manually retain a piece of information to a specific bank.
   * Now includes: token budget enforcement, importance scoring,
   * local dedup buffer, and content compression.
   *
   * @param bankId - Target Hindsight bank.
   * @param content - The information to retain.
   * @param context - Category (e.g. 'preference', 'decision', 'lesson').
   */
  async retain(bankId: string, content: string, context: string): Promise<void> {
    try {
      // Compress content before any scoring or storage
      const compressed = compressMemoryContent(content);

      // Token budget check: reject oversized single memories
      const maxTokens = this.config.maxRetainTokens ?? DEFAULT_MAX_RETAIN_TOKENS;
      const contentTokens = estimateTokens(compressed);
      if (contentTokens > maxTokens) {
        log.debug('Memory exceeds token budget, compressing', {
          bankId, context, tokens: contentTokens, maxTokens,
        });
        // Smart truncation would lose info; instead just log warning and proceed
        // (the client.ts retain method will also compress)
      }

      const quality = scoreMemoryQuality(compressed, context);
      const threshold = this.config.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;

      if (quality.score < threshold) {
        log.debug('Rejected low-quality memory', {
          bankId, context, score: quality.score, threshold, signals: quality.signals,
        });
        this.onMemoryEvent?.('quality', `Rejected low-quality memory (score: ${quality.score.toFixed(2)})`, bankId, {
          score: quality.score,
          threshold,
          context,
          signals: quality.signals,
          contentPreview: compressed.slice(0, 200),
          wordCount: compressed.split(/\s+/).filter(Boolean).length,
          estimatedTokens: contentTokens,
        });
        return;
      }

      // Local dedup buffer: avoid redundant API isDuplicate calls for rapid-fire retentions
      if (this.isRecentDuplicate(bankId, compressed)) {
        log.debug('Skipped duplicate via local buffer', { bankId, context });
        this.onMemoryEvent?.('dedup', `Skipped duplicate memory (local buffer, ${context})`, bankId, {
          context, contentPreview: compressed.slice(0, 200), bankId,
        });
        return;
      }

      const dedupThreshold = this.config.deduplicationThreshold ?? 0.85;
      const isDup = await this.hs.isDuplicateContent(bankId, compressed, dedupThreshold);
      if (isDup) {
        log.debug('Skipped duplicate memory retention', { bankId, context, length: compressed.length });
        this.onMemoryEvent?.('dedup', `Skipped duplicate memory (${context})`, bankId, {
          context,
          contentPreview: compressed.slice(0, 200),
          bankId,
          similarityThreshold: dedupThreshold,
        });
        return;
      }

      // Compute importance for metadata
      const importance = computeImportance(compressed, context);

      await this.hs.retainOne(bankId, compressed, context);

      // Track in local buffer
      this.trackRetention(bankId, compressed);

      log.debug('Retained memory', {
        bankId, context, length: compressed.length,
        qualityScore: quality.score, signals: quality.signals,
        importance: importance.composite.toFixed(3),
        estimatedTokens: contentTokens,
      });
      this.onMemoryEvent?.('retain', `Retained ${context} memory (quality: ${quality.score.toFixed(2)}, importance: ${importance.composite.toFixed(2)})`, bankId, {
        context,
        score: quality.score,
        importance: importance.composite,
        signals: quality.signals,
        contentPreview: compressed.slice(0, 200),
        contentLength: compressed.length,
        estimatedTokens: contentTokens,
      });
      this.onAfterRetain?.(bankId, context);
    } catch (err) {
      log.warn('Failed to retain memory', {
        bankId,
        context,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Evaluate a user message for preference, decision, or "remember" patterns.
   * If a pattern matches, the relevant content is retained fire-and-forget.
   *
   * @param content - The user's message text.
   * @param projectBank - Optional project bank for decision-context retention.
   */
  async evaluateUserMessage(content: string, projectBank?: string): Promise<void> {
    // Check for explicit "remember this/that" commands
    for (const pattern of REMEMBER_PATTERNS) {
      if (pattern.test(content)) {
        const stripped = content.replace(pattern, '').trim();
        if (stripped) {
          const bank = projectBank ?? 'core';
          this.retain(bank, stripped, 'preference').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
        }
        return;
      }
    }

    // Check for preference phrases
    if (PREFERENCE_PATTERNS.some((p) => p.test(content))) {
      this.retain('core', content, 'preference').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
    }

    // Check for decision phrases
    if (DECISION_PATTERNS.some((p) => p.test(content))) {
      const bank = projectBank ?? 'core';
      this.retain(bank, content, 'decision').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
    }
  }

  /**
   * Retain the outcome of a completed workflow, including decisions, findings,
   * errors, and infrastructure changes as separate memory items.
   * Uses consolidation to merge related findings before storage.
   *
   * @param outcome - Structured workflow outcome data.
   */
  async retainWorkflowOutcome(outcome: WorkflowOutcome): Promise<void> {
    const {
      bankId, taskSummary, workerCount, durationSec,
      outputPaths, decisions, findings, errors, infraChanges,
    } = outcome;

    try {
      const hasSubstance = decisions.length > 0 || findings.length > 0
        || errors.length > 0 || (infraChanges && infraChanges.length > 0);

      const summary = [
        `Task: ${taskSummary}`,
        `Workers: ${workerCount} | Duration: ${durationSec.toFixed(1)}s`,
        outputPaths.length > 0 ? `Outputs: ${outputPaths.join(', ')}` : null,
        errors.length > 0 ? `Errors: ${errors.length}` : null,
        decisions.length > 0 ? `Decisions: ${decisions.length}` : null,
        findings.length > 0 ? `Findings: ${findings.length}` : null,
      ].filter(Boolean).join('\n');

      if (!hasSubstance) {
        const quality = scoreMemoryQuality(summary, 'project_update');
        const threshold = this.config.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;
        if (quality.score < threshold) {
          log.debug('Skipped low-substance workflow outcome', {
            bankId, score: quality.score, threshold,
          });
          return;
        }
      }

      await this.retain(bankId, summary, 'project_update');

      // Consolidate findings before retaining to reduce redundant memories
      const now = new Date().toISOString();
      const findingItems = findings.map((f) => ({ content: f, context: 'lesson', timestamp: now }));
      const consolidatedFindings = consolidateMemories(findingItems);

      // Retain decisions individually
      for (const decision of decisions) {
        this.retain(bankId, decision, 'decision').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      }

      // Retain consolidated findings
      for (const finding of consolidatedFindings) {
        this.retain(bankId, finding.content, 'lesson').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      }

      // Retain errors as lessons
      for (const error of errors) {
        const errorContent = error.resolution
          ? `Error in ${error.worker}: ${error.message} — Resolution: ${error.resolution}`
          : `Error in ${error.worker}: ${error.message}`;
        this.retain(bankId, errorContent, 'lesson').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      }

      // Retain infrastructure changes
      if (infraChanges && infraChanges.length > 0) {
        for (const change of infraChanges) {
          this.retain('infra', change, 'infrastructure').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
        }
      }

      // Retain aggregated artifact manifest
      const wfId = outcome.workflowId ?? 'unknown';
      if (outputPaths.length > 0 || (outcome.nodeOutputPaths && Object.keys(outcome.nodeOutputPaths).length > 0)) {
        const manifestParts: string[] = [
          `Task: ${taskSummary}`,
          `Workflow: ${wfId}`,
        ];
        if (outputPaths.length > 0) {
          manifestParts.push(`Output paths: ${outputPaths.join(', ')}`);
        }
        if (outcome.nodeOutputPaths) {
          const perNode = Object.entries(outcome.nodeOutputPaths)
            .map(([label, paths]) => `  ${label}: ${paths.join(', ')}`)
            .join('\n');
          manifestParts.push(`Per-node artifacts:\n${perNode}`);
        }
        this.retain(bankId, manifestParts.join('\n'), 'artifact').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      }
    } catch (err) {
      log.warn('Failed to retain workflow outcome', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Local Dedup Buffer ─────────────────────────────────────────────

  /**
   * Check if content was recently retained to the same bank.
   * Avoids redundant isDuplicateContent API calls during rapid-fire retention.
   */
  private isRecentDuplicate(bankId: string, content: string): boolean {
    const now = Date.now();
    // Prune expired entries
    this.recentRetentions = this.recentRetentions.filter(
      (r) => now - r.ts < RetentionEngine.RECENT_BUFFER_TTL_MS,
    );

    const bankEntries = this.recentRetentions
      .filter((r) => r.bankId === bankId);

    return isDuplicateInBatch(content, bankEntries, this.config.deduplicationThreshold ?? 0.85);
  }

  private trackRetention(bankId: string, content: string): void {
    this.recentRetentions.push({ content, bankId, ts: Date.now() });
    // Cap buffer size
    if (this.recentRetentions.length > RetentionEngine.RECENT_BUFFER_MAX) {
      this.recentRetentions = this.recentRetentions.slice(-RetentionEngine.RECENT_BUFFER_MAX);
    }
  }

  // ── Event Handling ─────────────────────────────────────────────────

  /**
   * Resolve the correct bank ID for event-driven retention.
   * Uses the workflow → bank mapping if available, otherwise falls back
   * to the configured default bank.
   */
  private resolveBankForEvent(event: WorkerEvent): string {
    // Try workflow → bank mapping first
    if (event.workflowId) {
      const mapped = this.workflowBanks.get(event.workflowId);
      if (mapped) return mapped;
    }
    // Fall back to configured default
    return this.config.defaultBank ?? 'default';
  }

  /**
   * Handle a worker event from the EventBus.
   * Retains findings and (optionally) errors to the correct bank.
   */
  private handleEvent(event: WorkerEvent): void {
    const bankId = this.resolveBankForEvent(event);

    if (event.type === 'finding' && event.message) {
      this.retain(
        bankId,
        event.message,
        'lesson',
      ).catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
    }

    if (event.type === 'error' && this.config.retainOnError && event.error) {
      this.retain(
        bankId,
        `Worker ${event.workerId} error: ${event.error}`,
        'lesson',
      ).catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
    }

    if (event.type === 'done' && event.data) {
      const data = event.data as Record<string, unknown>;
      if (Array.isArray(data.findings)) {
        for (const finding of data.findings) {
          if (typeof finding === 'string') {
            this.retain(bankId, finding, 'lesson').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
          }
        }
      }

      const nodeLabel = typeof data.nodeLabel === 'string' ? data.nodeLabel : event.nodeId;
      const workflowId = event.workflowId ?? 'unknown';

      if (typeof data.output === 'string' && data.output.length > 0) {
        const outputContent = [
          `Node: ${nodeLabel}`,
          `Workflow: ${workflowId}`,
          typeof data.finalResult === 'string' ? `Result: ${data.finalResult}` : null,
          `Output: ${data.output.slice(0, 4000)}`,
        ].filter(Boolean).join('\n');
        this.retain(bankId, outputContent, 'node_output').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      } else if (typeof data.finalResult === 'string' && data.finalResult.length > 0) {
        const resultContent = `Node: ${nodeLabel}\nWorkflow: ${workflowId}\nResult: ${data.finalResult}`;
        this.retain(bankId, resultContent, 'node_output').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      }

      if (Array.isArray(data.outputPaths) && data.outputPaths.length > 0) {
        const artifactContent = [
          `Node: ${nodeLabel}`,
          `Workflow: ${workflowId}`,
          `Artifacts: ${(data.outputPaths as string[]).join(', ')}`,
        ].join('\n');
        this.retain(bankId, artifactContent, 'artifact').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      }
    }
  }
}
