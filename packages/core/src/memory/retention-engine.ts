/**
 * @module memory/retention-engine
 * Automatic event-driven memory retention. Listens to orchestration events
 * and evaluates user messages for patterns worth retaining.
 */

import { HindsightClient } from '@orionomega/hindsight';
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
 */
export class RetentionEngine {
  private unsubscribe: (() => void) | null = null;
  /** Map workflowId → bankId, set by the orchestration bridge when dispatching. */
  private workflowBanks = new Map<string, string>();
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
   *
   * @param bankId - Target Hindsight bank.
   * @param content - The information to retain.
   * @param context - Category (e.g. 'preference', 'decision', 'lesson').
   */
  async retain(bankId: string, content: string, context: string): Promise<void> {
    try {
      const quality = scoreMemoryQuality(content, context);
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
          contentPreview: content.slice(0, 200),
          wordCount: content.split(/\s+/).filter(Boolean).length,
        });
        return;
      }

      const dedupThreshold = this.config.deduplicationThreshold ?? 0.85;
      const isDup = await this.hs.isDuplicateContent(bankId, content, dedupThreshold);
      if (isDup) {
        log.debug('Skipped duplicate memory retention', { bankId, context, length: content.length });
        this.onMemoryEvent?.('dedup', `Skipped duplicate memory (${context})`, bankId, {
          context,
          contentPreview: content.slice(0, 200),
          bankId,
          similarityThreshold: dedupThreshold,
        });
        return;
      }
      await this.hs.retainOne(bankId, content, context);
      log.debug('Retained memory', {
        bankId, context, length: content.length,
        qualityScore: quality.score, signals: quality.signals,
      });
      this.onMemoryEvent?.('retain', `Retained ${context} memory (quality: ${quality.score.toFixed(2)})`, bankId, {
        context,
        score: quality.score,
        signals: quality.signals,
        contentPreview: content.slice(0, 200),
        contentLength: content.length,
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

      // Retain decisions individually
      for (const decision of decisions) {
        this.retain(bankId, decision, 'decision').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
      }

      // Retain findings individually
      for (const finding of findings) {
        this.retain(bankId, finding, 'lesson').catch((err) => { log.debug('Fire-and-forget retain failed', { error: err instanceof Error ? err.message : String(err) }); });
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
   *
   * Previously this used event.nodeId as the bank ID — that was a bug since
   * node IDs are UUIDs like "micro-65262f46c5268f8e", not valid bank names.
   * Now resolves the bank via workflow → bank mapping or falls back to 'default'.
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
