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
      await this.hs.retainOne(bankId, content, context);
      log.debug('Retained memory', { bankId, context, length: content.length });
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
      // Main outcome summary
      const summary = [
        `Task: ${taskSummary}`,
        `Workers: ${workerCount} | Duration: ${durationSec.toFixed(1)}s`,
        outputPaths.length > 0 ? `Outputs: ${outputPaths.join(', ')}` : null,
        errors.length > 0 ? `Errors: ${errors.length}` : null,
      ].filter(Boolean).join('\n');

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
