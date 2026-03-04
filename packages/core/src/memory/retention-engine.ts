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
}

/** Outcome data for workflow completion retention. */
export interface WorkflowOutcome {
  bankId: string;
  taskSummary: string;
  workerCount: number;
  durationSec: number;
  outputPaths: string[];
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
          this.retain(bank, stripped, 'preference').catch(() => {});
        }
        return;
      }
    }

    // Check for preference phrases
    if (PREFERENCE_PATTERNS.some((p) => p.test(content))) {
      this.retain('core', content, 'preference').catch(() => {});
    }

    // Check for decision phrases
    if (DECISION_PATTERNS.some((p) => p.test(content))) {
      const bank = projectBank ?? 'core';
      this.retain(bank, content, 'decision').catch(() => {});
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
        this.retain(bankId, decision, 'decision').catch(() => {});
      }

      // Retain findings individually
      for (const finding of findings) {
        this.retain(bankId, finding, 'lesson').catch(() => {});
      }

      // Retain errors as lessons
      for (const error of errors) {
        const errorContent = error.resolution
          ? `Error in ${error.worker}: ${error.message} — Resolution: ${error.resolution}`
          : `Error in ${error.worker}: ${error.message}`;
        this.retain(bankId, errorContent, 'lesson').catch(() => {});
      }

      // Retain infrastructure changes
      if (infraChanges && infraChanges.length > 0) {
        for (const change of infraChanges) {
          this.retain('infra', change, 'infrastructure').catch(() => {});
        }
      }
    } catch (err) {
      log.warn('Failed to retain workflow outcome', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle a worker event from the EventBus.
   * Retains findings and (optionally) errors.
   */
  private handleEvent(event: WorkerEvent): void {
    if (event.type === 'finding' && event.message) {
      this.retain(
        event.nodeId,
        event.message,
        'lesson',
      ).catch(() => {});
    }

    if (event.type === 'error' && this.config.retainOnError && event.error) {
      this.retain(
        event.nodeId,
        `Worker ${event.workerId} error: ${event.error}`,
        'lesson',
      ).catch(() => {});
    }

    if (event.type === 'done' && event.data) {
      const data = event.data as Record<string, unknown>;
      if (Array.isArray(data.findings)) {
        for (const finding of data.findings) {
          if (typeof finding === 'string') {
            this.retain(event.nodeId, finding, 'lesson').catch(() => {});
          }
        }
      }
    }
  }
}
