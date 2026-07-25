/**
 * @module agent/memory-bridge
 * Memory lifecycle for the main agent.
 *
 * Owns the {@link MemoryStore} — a {@link RedisMemoryStore} constructed from
 * `memory.redis` in config — plus the two components built on top of it
 * (retention, session summaries). The main agent calls `init()`, `summarize()`
 * and the recall helpers; it never sees the backend.
 *
 * See docs/memory-architecture-v2.md §16. There is nothing to create or
 * register: scopes are implicit — they exist once something is written to
 * them — and the store's index spans every scope, so cross-scope recall needs
 * no discovery step.
 */

import { AnthropicClient } from '../anthropic/client.js';
import { EventBus } from '../orchestration/event-bus.js';
import { RetentionEngine } from '../memory/retention-engine.js';
import { isExternalAction } from '../memory/query-classifier.js';
import { SessionSummarizer } from '../memory/session-summary.js';
import { RedisMemoryStore } from '../memory/redis-store.js';
import { projectScopeFor } from '../memory/scope-slug.js';
import type { MemoryStore } from '../memory/store.js';
import type { OrionOmegaConfig } from '../config/types.js';
import * as memoryTelemetry from '../memory/memory-telemetry.js';
import type { MemoryEvent } from './main-agent.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('memory-bridge');

type MemoryOp = MemoryEvent['op'];

/**
 * Memory subsystem configuration.
 *
 * `memory` is the `memory:` block from config.yaml. Absent = memory disabled
 * for this process (no store is constructed and every operation no-ops).
 */
export interface MemoryConfig {
  memory?: OrionOmegaConfig['memory'];
  model: string;
  cheapModel?: string;
}

/** Token budget for the `core` scope during a planning recall. */
const PLANNING_CORE_TOKENS = 2048;
/** Token budget for the active project scope during a planning recall. */
const PLANNING_PROJECT_TOKENS = 3072;
/** Token budget for the active project scope during an architect recall. */
const ARCHITECT_PROJECT_TOKENS = 3072;
/** Token budget for the `core` scope during an architect recall. */
const ARCHITECT_CORE_TOKENS = 1024;

/** The always-present cross-project scope. */
const CORE_SCOPE = 'core';

/**
 * Manages the memory lifecycle for the main agent.
 *
 * Encapsulates the store, the retention engine, and the session summariser
 * behind a small interface so the agent need not know which of them a given
 * operation touches.
 */
export class MemoryBridge {
  private memoryStore: RedisMemoryStore | null = null;
  private retentionEngine: RetentionEngine | null = null;
  private sessionSummarizer: SessionSummarizer | null = null;

  private activeProjectScope: string | null = null;
  private initialised = false;
  /** H4: Promise mutex — prevents concurrent init() calls from racing. */
  private _initPromise: Promise<void> | null = null;

  onMemoryEvent?: (op: MemoryOp, detail: string, scope?: string, meta?: Record<string, unknown>) => void;

  constructor(
    private readonly config: MemoryConfig,
    private readonly anthropic: AnthropicClient,
    private readonly eventBus: EventBus,
  ) {}

  /** Whether the memory subsystem is ready. */
  get isInitialised(): boolean { return this.initialised; }

  /** The currently active project scope (if any). */
  get projectScope(): string | null { return this.activeProjectScope; }

  /** The backend-neutral {@link MemoryStore} (if initialised). */
  get store(): MemoryStore | null { return this.memoryStore; }

  /** The RetentionEngine (if initialised). */
  get retention(): RetentionEngine | null { return this.retentionEngine; }

  /**
   * Snapshot of session-summariser health for `/api/health`. Returns
   * `null` when memory is not configured (no summariser was constructed).
   */
  getSummarizerStatus() {
    return this.sessionSummarizer?.getStatus() ?? null;
  }

  /**
   * Initialise the memory subsystem: construct the store and start retention.
   * Safe to call multiple times — concurrent calls await the same promise (H4 mutex).
   */
  init(): Promise<void> {
    if (this.initialised) return Promise.resolve();
    // H4: Return the in-flight promise if init is already running, preventing
    // concurrent callers from racing through setup and double-initialising.
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  /** Internal init implementation — called exactly once via the H4 promise mutex. */
  private async _doInit(): Promise<void> {
    const memCfg = this.config.memory;
    if (!memCfg) {
      log.info('Memory not configured — memory features disabled');
      return;
    }

    try {
      // `gc: true` starts the background collector. Without it nothing ever
      // calls collectGarbage() and expired records accumulate behind the
      // read-time TTL filter forever.
      this.memoryStore = new RedisMemoryStore({ redis: memCfg.redis, gc: true });

      this.retentionEngine = new RetentionEngine(
        this.memoryStore,
        this.eventBus,
        {
          retainOnComplete: memCfg.retainOnComplete,
          retainOnError: memCfg.retainOnError,
          // Event-driven retention with no active project scope lands in core.
          defaultBank: CORE_SCOPE,
          deduplicationThreshold: memCfg.deduplicationThreshold,
        },
      );

      this.sessionSummarizer = new SessionSummarizer(
        this.memoryStore,
        this.anthropic,
        this.config.cheapModel || this.config.model,
      );

      // Registered with optional chaining so it works even when onMemoryEvent
      // is assigned after init() (e.g. in main-agent._init()).
      this.retentionEngine.onMemoryEvent = (op, detail, scope, meta) => {
        this.onMemoryEvent?.(op as MemoryOp, detail, scope, meta);
      };

      this.retentionEngine.start();

      this.initialised = true;
      log.info('Memory subsystem initialised');
      this.onMemoryEvent?.('bootstrap', 'Memory subsystem initialised');
    } catch (err) {
      log.warn('Memory subsystem init failed — continuing without memory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Derive and activate the project scope for a task.
   *
   * There is nothing to create: a scope exists once a record is written to it.
   * The slug is deterministic, so a follow-up task rejoins the scope its
   * predecessor wrote to.
   */
  ensureProjectScope(task: string): string {
    this.activeProjectScope = projectScopeFor(task);
    this.onMemoryEvent?.('bootstrap', `Project scope: ${this.activeProjectScope}`, this.activeProjectScope);
    return this.activeProjectScope;
  }

  /**
   * Recall context for a planning operation from `core` plus the active
   * project scope.
   *
   * F12: Emits recall metrics for observability.
   */
  async recallForPlanning(task: string): Promise<string[]> {
    const store = this.memoryStore;
    if (!store) return [];

    if (isExternalAction(task)) {
      log.debug('Skipping recall for external action task');
      return [];
    }

    const targets: Array<{ scope: string; maxTokens: number }> = [
      { scope: CORE_SCOPE, maxTokens: PLANNING_CORE_TOKENS },
    ];
    if (this.activeProjectScope) {
      targets.push({ scope: this.activeProjectScope, maxTokens: PLANNING_PROJECT_TOKENS });
    }

    const memories: string[] = [];
    const recallStart = Date.now();
    let totalRecords = 0;
    let totalTokensUsed = 0;

    for (const { scope, maxTokens } of targets) {
      const start = Date.now();
      try {
        const result = await store.recall(scope, task, { maxTokens });
        memoryTelemetry.recordRecall(
          scope,
          result.records.length,
          result.records.length,
          Date.now() - start,
          result.tokensUsed,
        );
        totalRecords += result.records.length;
        totalTokensUsed += result.tokensUsed;
        if (result.records.length) {
          memories.push(result.records.map((r) => r.content).join('\n\n'));
        }
      } catch (err) {
        // Recall is best-effort — a failure means "no prior context", and the
        // store surfaces its own health via /api/health, so per-call noise is
        // unhelpful here.
        log.debug('Planning recall failed', {
          scope,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const recallDurationMs = Date.now() - recallStart;
    this.onMemoryEvent?.('recall', `Planning recall: ${totalRecords} records in ${recallDurationMs}ms`, undefined, {
      totalResults: totalRecords,
      totalTokensUsed,
      durationMs: recallDurationMs,
      scopesQueried: targets.map((t) => t.scope),
    });

    return memories;
  }

  /**
   * Coding-mode recall: prior architecture decisions, design notes, and
   * previous coding-run records relevant to the current task, from the active
   * project scope plus `core`.
   *
   * Always returns an array of record contents (possibly empty). Never throws
   * — failures are logged and treated as "no prior decisions found" so the
   * architect step can continue.
   */
  async recallForArchitect(task: string): Promise<string[]> {
    const store = this.memoryStore;
    if (!store) return [];
    if (isExternalAction(task)) return [];

    // Bias the query toward design/architecture context: the store matches on
    // content, so we phrase the query with the memory categories we expect to
    // find (architecture, decision, plan, requirement, verdict).
    const archQuery =
      `architecture decisions, design notes, prior coding plans, requirements, ` +
      `goal verdicts, retain context for: ${task}`;

    const targets: Array<{ scope: string; maxTokens: number }> = [];
    if (this.activeProjectScope) {
      targets.push({ scope: this.activeProjectScope, maxTokens: ARCHITECT_PROJECT_TOKENS });
    }
    // Always also query core for cross-project architectural patterns.
    targets.push({ scope: CORE_SCOPE, maxTokens: ARCHITECT_CORE_TOKENS });

    const start = Date.now();
    const memories: string[] = [];
    let totalRecords = 0;

    for (const { scope, maxTokens } of targets) {
      try {
        const result = await store.recall(scope, archQuery, { maxTokens });
        totalRecords += result.records.length;
        if (result.records.length) {
          memories.push(...result.records.map((r) => r.content));
        }
      } catch (err) {
        log.debug('Architect recall failed', {
          scope,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const durationMs = Date.now() - start;
    this.onMemoryEvent?.(
      'recall',
      `Architect recall: ${totalRecords} prior decisions in ${durationMs}ms`,
      this.activeProjectScope ?? CORE_SCOPE,
      { totalResults: totalRecords, durationMs, queryKind: 'architect' },
    );

    return memories;
  }

  /**
   * F12: Liveness check on the memory backend, surfaced to operators.
   */
  async verifyConsistency(): Promise<{ healthy: boolean; issues: string[] }> {
    const store = this.memoryStore;
    if (!store) {
      return { healthy: false, issues: ['Memory store not initialised'] };
    }

    const issues: string[] = [];
    try {
      const health = await store.health();
      if (!health.healthy) {
        issues.push('Memory store reported unhealthy');
      }
    } catch (err) {
      // health() is contractually non-throwing; a throw here is itself the finding.
      issues.push(`Memory store health check threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    const healthy = issues.length === 0;
    if (!healthy) {
      log.warn('Memory consistency check found issues', { issues });
    }

    return { healthy, issues };
  }

  /**
   * Summarize the current session and retain it.
   *
   * @param sessionId - Originating gateway session id. When set, the
   *   resulting `session_summary` (and `project_update` mirror) are
   *   tagged `session:<sessionId>` so provenance is preserved while
   *   recall remains cross-session.
   */
  async summarize(
    history: Array<{ role: string; content: string | import('../anthropic/client.js').ContentBlock[] }>,
    sessionId?: string,
  ): Promise<void> {
    if (!this.sessionSummarizer) return;

    try {
      await this.sessionSummarizer.summarize(history, this.activeProjectScope ?? undefined, sessionId);
      log.info('Session summarised', { sessionId });
      this.onMemoryEvent?.('summary', 'Session summary retained', this.activeProjectScope ?? undefined, sessionId ? { sessionId } : undefined);
    } catch (err) {
      log.warn('Session summary failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Persist the outcome of a coding run — task, requirements list, and
   * per-requirement verdicts — to the active project scope so subsequent
   * architect calls can recall it. No-op when memory is not initialised.
   *
   * The payload is stored as a single record with context `coding-run` so
   * downstream recall can filter / weight it.
   */
  async retainCodingRun(payload: {
    task: string;
    requirements: Array<{ id: string; description: string; acceptance?: string; coveredBy?: string[] }>;
    verdicts: Array<{ requirementId: string; status: string; evidence: string; confidence: number }>;
    decision: string;
    priorDecisionsCount?: number;
    /** Originating gateway/conversation session id; tagged onto the
     * stored record as `session:<id>` so deleteSession purges per-session
     * data correctly and recall can filter by source session. */
    sessionId?: string;
    /**
     * Full architect plan for the run. Persisting the structured plan
     * (approach, file changes, fan-out, requirement→chunk mapping)
     * lets future architect calls recall not only what was decided but
     * how the work was decomposed — needed by the linear and DAG paths
     * to avoid re-deriving the same plan on related follow-up tasks.
     */
    plan?: {
      approach?: string;
      template?: string;
      nodes?: Array<{ id: string; type: string; label?: string }>;
      fileChanges?: Array<{ path: string; action: string; description?: string; cluster?: number }>;
      fanOut?: { chunks?: Array<{ id: string; label?: string; fileCluster?: string[]; task?: string }>; maxParallelism?: number };
      filesModified?: string[];
      filesCreated?: string[];
      budgetEstimateUsd?: number;
    };
  }): Promise<void> {
    const store = this.memoryStore;
    if (!store) return;
    const scope = this.activeProjectScope ?? CORE_SCOPE;

    // Format as a markdown-friendly block so future recalls show usefully
    // when concatenated alongside other records.
    const lines: string[] = [];
    lines.push('## Coding-mode run');
    lines.push(`Task: ${payload.task.slice(0, 800)}`);
    lines.push(`Decision: ${payload.decision}`);
    if (typeof payload.priorDecisionsCount === 'number') {
      lines.push(`Prior decisions consulted: ${payload.priorDecisionsCount}`);
    }

    if (payload.plan) {
      lines.push('');
      lines.push('### Plan');
      if (payload.plan.template) lines.push(`Template: ${payload.plan.template}`);
      if (payload.plan.approach) lines.push(`Approach: ${payload.plan.approach.slice(0, 1200)}`);
      if (typeof payload.plan.budgetEstimateUsd === 'number') {
        lines.push(`Estimated budget: $${payload.plan.budgetEstimateUsd.toFixed(2)}`);
      }
      if (payload.plan.nodes && payload.plan.nodes.length > 0) {
        lines.push(`Nodes (${payload.plan.nodes.length}): ` +
          payload.plan.nodes.map((n) => `${n.id}[${n.type}]`).join(', '));
      }
      if (payload.plan.fileChanges && payload.plan.fileChanges.length > 0) {
        lines.push('File changes:');
        for (const fc of payload.plan.fileChanges.slice(0, 60)) {
          const desc = fc.description ? ` — ${fc.description.slice(0, 160)}` : '';
          const cluster = typeof fc.cluster === 'number' ? ` (cluster ${fc.cluster})` : '';
          lines.push(`  - ${fc.action} ${fc.path}${cluster}${desc}`);
        }
        if (payload.plan.fileChanges.length > 60) {
          lines.push(`  ... (+${payload.plan.fileChanges.length - 60} more file changes)`);
        }
      }
      if (payload.plan.fanOut?.chunks && payload.plan.fanOut.chunks.length > 0) {
        lines.push(`Fan-out (parallelism=${payload.plan.fanOut.maxParallelism ?? 1}):`);
        for (const c of payload.plan.fanOut.chunks.slice(0, 12)) {
          const files = c.fileCluster && c.fileCluster.length > 0
            ? ` files=${c.fileCluster.slice(0, 8).join(',')}${c.fileCluster.length > 8 ? '…' : ''}`
            : '';
          lines.push(`  - ${c.id}: ${c.label ?? ''}${files}`);
        }
      }
      if (payload.plan.filesModified && payload.plan.filesModified.length > 0) {
        lines.push(`Files modified (${payload.plan.filesModified.length}): ` +
          payload.plan.filesModified.slice(0, 30).join(', ') +
          (payload.plan.filesModified.length > 30 ? `, +${payload.plan.filesModified.length - 30} more` : ''));
      }
      if (payload.plan.filesCreated && payload.plan.filesCreated.length > 0) {
        lines.push(`Files created (${payload.plan.filesCreated.length}): ` +
          payload.plan.filesCreated.slice(0, 30).join(', ') +
          (payload.plan.filesCreated.length > 30 ? `, +${payload.plan.filesCreated.length - 30} more` : ''));
      }
    }

    if (payload.requirements.length > 0) {
      lines.push('');
      lines.push('### Requirements');
      for (const r of payload.requirements) {
        const cover = r.coveredBy && r.coveredBy.length > 0
          ? ` (coveredBy: ${r.coveredBy.slice(0, 10).join(', ')})`
          : '';
        lines.push(`- [${r.id}] ${r.description}${r.acceptance ? ` (acceptance: ${r.acceptance})` : ''}${cover}`);
      }
    }
    if (payload.verdicts.length > 0) {
      lines.push('');
      lines.push('### Verdicts');
      for (const v of payload.verdicts) {
        lines.push(`- [${v.requirementId}] status=${v.status} confidence=${v.confidence.toFixed(2)} — ${v.evidence.slice(0, 240)}`);
      }
    }

    try {
      const sessionTags = payload.sessionId ? [`session:${payload.sessionId}`] : undefined;
      await store.retain(scope, [{
        content: lines.join('\n'),
        context: 'coding-run',
        timestamp: new Date().toISOString(),
        documentId: `coding-run-${Date.now()}`,
        ...(sessionTags ? { tags: sessionTags } : {}),
      }]);
      this.onMemoryEvent?.(
        'retain',
        `Persisted coding run (${payload.requirements.length} requirement(s), ${payload.verdicts.length} verdict(s))`,
        scope,
        {
          requirementsCount: payload.requirements.length,
          verdictsCount: payload.verdicts.length,
          decision: payload.decision,
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        },
      );
    } catch (err) {
      log.warn('Failed to retain coding run', {
        scope,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Release the store's connection and background GC loop.
   *
   * Stops retention first so no write is issued against a closing client.
   */
  async shutdown(): Promise<void> {
    this.retentionEngine?.stop();
    const store = this.memoryStore;
    this.memoryStore = null;
    this.initialised = false;
    this._initPromise = null;
    if (!store) return;
    try {
      await store.close();
    } catch (err) {
      log.debug('Memory store close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
