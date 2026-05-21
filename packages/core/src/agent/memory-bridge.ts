/**
 * @module agent/memory-bridge
 * Hindsight memory integration for the main agent.
 *
 * Handles initialisation, context bootstrap, retention, compaction flush,
 * and session summaries. Separating memory concerns from the main agent
 * keeps both focused and readable.
 */

import { HindsightClient, BankManager, SessionBootstrap, MentalModelManager, SelfKnowledge } from '@orionomega/hindsight';
import type { SessionAnchor } from '@orionomega/hindsight';
import { AnthropicClient } from '../anthropic/client.js';
import { EventBus } from '../orchestration/event-bus.js';
import { RetentionEngine } from '../memory/retention-engine.js';
import { CompactionFlush } from '../memory/compaction-flush.js';
import { isExternalAction } from '../memory/query-classifier.js';
import { SessionSummarizer } from '../memory/session-summary.js';
import type { OrionOmegaConfig } from '../config/types.js';
import type { MemoryEvent } from './main-agent.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('memory-bridge');

type MemoryOp = MemoryEvent['op'];

/** Memory subsystem configuration. */
export interface MemoryConfig {
  hindsight?: OrionOmegaConfig['hindsight'];
  model: string;
  cheapModel?: string;
}

/** Thresholds and seed content for self-knowledge bootstrap. */
export interface MemoryBootstrapConfig {
  apiEndpoint: string;
  deduplicationThreshold: number;
  relevanceFloor: number;
  qualityThreshold: number;
  budgetTiers: { low: number; mid: number; high: number };
  architecturalDecisions: string[];
}

const DEFAULT_BOOTSTRAP: Omit<MemoryBootstrapConfig, 'apiEndpoint'> = {
  deduplicationThreshold: 0.85,
  relevanceFloor: 0.15,
  qualityThreshold: 0.3,
  budgetTiers: { low: 1024, mid: 4096, high: 8192 },
  architecturalDecisions: [
    'Hindsight stores memories in isolated banks with namespace separation',
    'Mental models are pre-synthesized context documents refreshed on retention triggers',
    'Session anchors capture continuity state at session boundaries',
    'Memory quality scoring filters low-signal content before storage',
    'Causal chain retrieval formats decision → action → outcome narratives in recall',
  ],
};

/**
 * Manages the full Hindsight memory lifecycle for the main agent.
 *
 * Encapsulates 7 memory components (HindsightClient, BankManager, SessionBootstrap,
 * MentalModelManager, RetentionEngine, SessionSummarizer, CompactionFlush) behind
 * a clean interface. The main agent calls init(), flush(), summarize() — no need
 * to know about individual memory components.
 */
export class MemoryBridge {
  private hindsightClient: HindsightClient | null = null;
  private bankManager: BankManager | null = null;
  private sessionBootstrap: SessionBootstrap | null = null;
  private mentalModelManager: MentalModelManager | null = null;
  private retentionEngine: RetentionEngine | null = null;
  private sessionSummarizer: SessionSummarizer | null = null;
  private compactionFlush: CompactionFlush | null = null;
  private selfKnowledge: SelfKnowledge | null = null;

  private activeProjectBank: string | null = null;
  private initialised = false;

  private reflectCache = new Map<string, { result: string; ts: number }>();
  private static readonly REFLECT_CACHE_TTL_MS = 120_000; // 2 minutes

  onMemoryEvent?: (op: MemoryOp, detail: string, bank?: string, meta?: Record<string, unknown>) => void;

  constructor(
    private readonly config: MemoryConfig,
    private readonly anthropic: AnthropicClient,
    private readonly eventBus: EventBus,
  ) {}

  /** Whether the memory subsystem is ready. */
  get isInitialised(): boolean { return this.initialised; }

  /** The currently active project bank (if any). */
  get projectBank(): string | null { return this.activeProjectBank; }

  /** The HindsightClient (if initialised). */
  get client(): HindsightClient | null { return this.hindsightClient; }

  /** The RetentionEngine (if initialised). */
  get retention(): RetentionEngine | null { return this.retentionEngine; }

  /** The BankManager (if initialised). */
  get banks(): BankManager | null { return this.bankManager; }

  /**
   * Snapshot of Hindsight client health (circuit state, last error, etc.)
   * for the gateway's `/api/health` endpoint. Returns `null` when memory
   * is not configured for this session.
   */
  getHindsightStatus() {
    return this.hindsightClient?.getStatus() ?? null;
  }

  /**
   * Snapshot of session-summariser health for `/api/health`. Returns
   * `null` when memory is not configured (no summariser was constructed).
   */
  getSummarizerStatus() {
    return this.sessionSummarizer?.getStatus() ?? null;
  }

  /**
   * Initialise the Hindsight memory subsystem.
   *
   * Creates all memory components, bootstraps context, and starts retention.
   * Returns the bootstrap context block (if any) for injection into the system prompt.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<string | undefined> {
    if (this.initialised) return undefined;

    const hsCfg = this.config.hindsight;
    if (!hsCfg?.url) {
      log.info('Hindsight not configured — memory features disabled');
      return undefined;
    }

    try {
      this.hindsightClient = new HindsightClient(hsCfg.url);
      this.bankManager = new BankManager(this.hindsightClient);
      this.sessionBootstrap = new SessionBootstrap(this.hindsightClient);
      this.mentalModelManager = new MentalModelManager(this.hindsightClient);

      this.retentionEngine = new RetentionEngine(
        this.hindsightClient,
        this.eventBus,
        {
          retainOnComplete: hsCfg.retainOnComplete,
          retainOnError: hsCfg.retainOnError,
          defaultBank: hsCfg.defaultBank,
        },
      );

      this.sessionSummarizer = new SessionSummarizer(
        this.hindsightClient,
        this.anthropic,
        this.config.cheapModel || this.config.model,
      );

      this.compactionFlush = new CompactionFlush(
        this.hindsightClient,
        this.anthropic,
        this.config.cheapModel || this.config.model,
      );

      // Ensure the persistent core bank exists
      try {
        const coreExists = await this.hindsightClient.bankExists('core');
        if (!coreExists) {
          await this.hindsightClient.createBank('core', {
            name: 'OrionOmega Core — cross-session persistent memory',
            retain_mission:
              `Extract user preferences, communication style, technical expertise level, ` +
              `cross-project decisions, lessons learned, infrastructure knowledge, and ` +
              `system configuration details. Focus on information that persists across sessions.`,
            observations_mission:
              `Synthesize observations about the user's working patterns, preferred ` +
              `technologies, recurring decisions, and cross-project architectural themes.`,
            reflect_mission:
              `You are OrionOmega's persistent memory. Answer questions about user preferences, ` +
              `past decisions, project history, and system knowledge using stored facts and observations.`,
            enable_observations: true,
          });
          log.info('Created persistent core bank');
        }
      } catch (err) {
        log.warn('Failed to ensure core bank exists', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Bootstrap context
      const ctx = await this.sessionBootstrap.bootstrap(this.activeProjectBank ?? undefined);
      const contextBlock = this.sessionBootstrap.buildContextBlock(ctx);

      this.selfKnowledge = new SelfKnowledge(this.hindsightClient);

      // F7: Seed mental models on first run. The refresh callback only updates
      // existing models — if they were never created, every bootstrap attempt
      // returns 404. Seed them once so subsequent refreshes work.
      // Fire-and-forget: any failure here is non-fatal. The capability probe
      // inside the seeder already handles "endpoint not supported" with a
      // single info log, so this catch only fires on truly unexpected errors
      // and is intentionally logged at debug to avoid noise.
      this.seedMentalModelsIfNeeded().catch((err) => {
        log.debug('Mental model seeding failed', {
          endpoint: 'seedMentalModelsIfNeeded',
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Always register callbacks using optional chaining so they work even when
      // onMemoryEvent is set after init() (e.g. in main-agent._init()).
      this.retentionEngine.onMemoryEvent = (op, detail, bank, meta) => {
        this.onMemoryEvent?.(op as MemoryOp, detail, bank, meta);
      };

      this.hindsightClient.onIO = (event) => {
        this.onMemoryEvent?.(event.op as MemoryOp, event.detail, event.bank, event.meta);
      };

      // Trigger mental model refresh after every successful retention.
      // Skip entirely when the capability probe disabled mental models for
      // the session — otherwise we'd issue a 404 on every successful retain.
      this.retentionEngine.onAfterRetain = (bankId: string, context: string) => {
        if (this.hindsightClient?.mentalModelsAvailable === false) return;
        this.mentalModelManager?.onRetain(bankId, context).catch((err) => {
          log.debug('Mental model refresh failed after retention', {
            bankId,
            context,
            endpoint: 'mentalModelManager.onRetain',
            error: err instanceof Error ? err.message : String(err),
          });
        });
      };

      this.retentionEngine.start();

      this.initialised = true;
      log.info('Memory subsystem initialised', { url: hsCfg.url });
      this.onMemoryEvent?.('bootstrap', 'Memory subsystem initialised', undefined, { url: hsCfg.url });

      this.selfKnowledge.bootstrap({
        apiEndpoint: hsCfg.url,
        ...DEFAULT_BOOTSTRAP,
      }).catch((err) => {
        log.warn('Self-knowledge bootstrap failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return contextBlock || undefined;
    } catch (err) {
      log.warn('Memory subsystem init failed — continuing without memory', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Ensure a project bank exists for a task.
   * Sets the active project bank on success.
   */
  async ensureProjectBank(task: string): Promise<string | null> {
    if (!this.bankManager) return null;
    try {
      this.activeProjectBank = await this.bankManager.ensureProjectBank(task);
      this.onMemoryEvent?.('bootstrap', `Project bank ready: ${this.activeProjectBank}`, this.activeProjectBank ?? undefined);
      return this.activeProjectBank;
    } catch (err) {
      log.warn('Failed to ensure project bank', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Recall context from Hindsight for a planning operation.
   * Queries the core bank and the active project bank.
   *
   * F12: Emits recall metrics for observability.
   */
  async recallForPlanning(task: string): Promise<string[]> {
    if (!this.hindsightClient) return [];

    if (isExternalAction(task)) {
      log.debug('Skipping Hindsight recall for external action task');
      return [];
    }

    const memories: string[] = [];
    const recallStart = Date.now();
    let totalResults = 0;
    let totalTokensUsed = 0;

    try {
      const result = await this.hindsightClient.recall('core', task, {
        maxTokens: 2048,
        budget: 'high',
        types: ['world', 'experience', 'observation'],
      });
      totalResults += result.results.length;
      totalTokensUsed += result.tokens_used;
      if (result.results.length) {
        memories.push(result.results.map((m) => m.content).join('\n\n'));
      }
    } catch (err) {
      // Recall is best-effort — failures are surfaced via the circuit
      // breaker and /api/health, so per-call noise is unhelpful here.
      log.debug('Core bank recall failed for planning', {
        endpoint: 'POST /v1/<ns>/banks/core/memories/recall',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (this.activeProjectBank) {
      try {
        const result = await this.hindsightClient.recall(this.activeProjectBank, task, {
          maxTokens: 3072,
          budget: 'high',
          types: ['world', 'experience', 'observation'],
        });
        totalResults += result.results.length;
        totalTokensUsed += result.tokens_used;
        if (result.results.length) {
          memories.push(result.results.map((m) => m.content).join('\n\n'));
        }
      } catch (err) {
        log.debug('Project bank recall failed for planning', {
          bank: this.activeProjectBank,
          endpoint: `POST /v1/<ns>/banks/${this.activeProjectBank}/memories/recall`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Cross-project federation: query other project banks for cross-project learnings
    try {
      const allBanks = await this.hindsightClient.listBanksCached();
      for (const bank of allBanks) {
        if (bank.bank_id === 'core' || bank.bank_id === this.activeProjectBank) continue;
        if (!bank.bank_id.startsWith('project-')) continue;
        if ((bank.memory_count ?? 0) === 0) continue;
        try {
          const result = await this.hindsightClient.recall(bank.bank_id, task, {
            maxTokens: 512,
            budget: 'low',
          });
          totalResults += result.results.length;
          totalTokensUsed += result.tokens_used;
          if (result.results.length > 0) {
            memories.push(result.results.map((m) => m.content).join('\n\n'));
          }
        } catch {
          // Per-bank federation failures are non-fatal; skip silently
        }
      }
    } catch {
      // Federation list failure is non-fatal
    }

    // F12: Emit recall metrics for observability
    const recallDurationMs = Date.now() - recallStart;
    this.onMemoryEvent?.('recall', `Planning recall: ${totalResults} memories in ${recallDurationMs}ms`, undefined, {
      totalResults,
      totalTokensUsed,
      durationMs: recallDurationMs,
      banksQueried: this.activeProjectBank ? ['core', this.activeProjectBank] : ['core'],
    });

    return memories;
  }

  /**
   * F12: Verify consistency between index and storage.
   * Checks that the core bank exists and is accessible, and that
   * the banks cache is not serving stale data.
   */
  async verifyConsistency(): Promise<{ healthy: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (!this.hindsightClient) {
      return { healthy: false, issues: ['Hindsight client not initialised'] };
    }

    // Check health
    try {
      const health = await this.hindsightClient.health();
      if (health.status !== 'ok') {
        issues.push(`Hindsight health check returned: ${health.status}`);
      }
    } catch (err) {
      issues.push(`Hindsight health check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Verify core bank exists
    try {
      const coreExists = await this.hindsightClient.bankExists('core');
      if (!coreExists) {
        issues.push('Core bank does not exist — index/storage mismatch');
      }
    } catch (err) {
      issues.push(`Core bank check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Verify active project bank if set
    if (this.activeProjectBank) {
      try {
        const projExists = await this.hindsightClient.bankExists(this.activeProjectBank);
        if (!projExists) {
          issues.push(`Active project bank "${this.activeProjectBank}" does not exist`);
          // Invalidate cache to prevent stale references
          this.hindsightClient.invalidateBanksCache();
        }
      } catch (err) {
        issues.push(`Project bank check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Check core bank stats for pending consolidation backlog
    try {
      const stats = await this.hindsightClient.getBankStats('core');
      if (stats.pending_consolidation > 100) {
        issues.push(`Core bank has ${stats.pending_consolidation} pending consolidations`);
      }
    } catch (err) {
      // getBankStats may not be available on all server versions — non-fatal
      log.debug('Core bank stats check failed', {
        endpoint: 'GET /v1/<ns>/banks/core/stats',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Force cache refresh to ensure consistency
    this.hindsightClient.invalidateBanksCache();

    const healthy = issues.length === 0;
    if (!healthy) {
      log.warn('Memory consistency check found issues', { issues });
    }

    return { healthy, issues };
  }

  /**
   * Flush conversation context to Hindsight before compaction.
   */
  async flush(history: Array<{ role: string; content: string | import('../anthropic/client.js').ContentBlock[] }>, sessionId?: string): Promise<void> {
    if (!this.compactionFlush) return;

    const bankId = this.activeProjectBank ?? this.config.hindsight?.defaultBank ?? 'core';
    try {
      const result = await this.compactionFlush.flush(history, bankId, sessionId);
      log.info('Memory flushed before compaction', { itemsRetained: result.itemsRetained });
      this.onMemoryEvent?.('flush', `Flushed ${result.itemsRetained} items to memory`, bankId, { itemsRetained: result.itemsRetained, ...(sessionId ? { sessionId } : {}) });
    } catch (err) {
      log.warn('Memory flush failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Summarize the current session and retain to Hindsight.
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
      await this.sessionSummarizer.summarize(history, this.activeProjectBank ?? undefined, sessionId);
      log.info('Session summarised', { sessionId });
      this.onMemoryEvent?.('summary', 'Session summary retained', this.activeProjectBank ?? undefined, sessionId ? { sessionId } : undefined);
    } catch (err) {
      log.warn('Session summary failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Coding-Mode-specific recall: pulls prior architecture decisions, design
   * notes, and previous coding-run records relevant to the current task from
   * the active project bank. Falls back to a regular project-bank recall when
   * the project bank is missing.
   *
   * Always returns an array of memory content strings (possibly empty). Never
   * throws — recall failures are logged and treated as "no prior decisions
   * found" so the architect step can continue.
   */
  async recallForArchitect(task: string): Promise<string[]> {
    if (!this.hindsightClient) return [];
    if (isExternalAction(task)) return [];

    // Bias the query toward design/architecture context. The Hindsight server
    // matches semantically, so we phrase the query with the kinds of memory
    // categories we expect to find (architecture, decision, plan, requirement,
    // verdict).
    const archQuery =
      `architecture decisions, design notes, prior coding plans, requirements, ` +
      `goal verdicts, retain context for: ${task}`;

    const start = Date.now();
    const memories: string[] = [];
    let totalResults = 0;

    if (this.activeProjectBank) {
      try {
        const result = await this.hindsightClient.recall(this.activeProjectBank, archQuery, {
          maxTokens: 3072,
          types: ['world', 'experience', 'observation'],
        });
        totalResults += result.results.length;
        if (result.results.length) {
          memories.push(...result.results.map((m) => m.content));
        }
      } catch (err) {
        log.debug('Architect recall: project bank failed', {
          bank: this.activeProjectBank,
          endpoint: `POST /v1/<ns>/banks/${this.activeProjectBank}/memories/recall`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Always also query core for cross-project architectural patterns.
    try {
      const result = await this.hindsightClient.recall('core', archQuery, {
        maxTokens: 1024,
        types: ['world', 'experience', 'observation'],
      });
      totalResults += result.results.length;
      if (result.results.length) {
        memories.push(...result.results.map((m) => m.content));
      }
    } catch (err) {
      log.debug('Architect recall: core bank failed', {
        endpoint: 'POST /v1/<ns>/banks/core/memories/recall',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const durationMs = Date.now() - start;
    this.onMemoryEvent?.(
      'recall',
      `Architect recall: ${totalResults} prior decisions in ${durationMs}ms`,
      this.activeProjectBank ?? 'core',
      { totalResults, durationMs, queryKind: 'architect' },
    );

    return memories;
  }

  /**
   * Use Hindsight's reflect API for complex decision-making queries.
   * Reflect performs autonomous multi-step reasoning over stored memories,
   * facts, and observations — significantly more powerful than plain recall.
   *
   * Results are cached for REFLECT_CACHE_TTL_MS (2 minutes) per bank+question pair
   * to avoid redundant LLM calls within a session.
   *
   * Falls back to null on any error (reflect endpoint not available, etc.).
   */
  async reflectForDecision(
    question: string,
    bankId?: string,
  ): Promise<string | null> {
    if (!this.hindsightClient) return null;
    if (isExternalAction(question)) return null;

    const target = bankId ?? this.activeProjectBank ?? 'core';
    const cacheKey = `${target}:${question}`;

    const cached = this.reflectCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < MemoryBridge.REFLECT_CACHE_TTL_MS) {
      return cached.result;
    }

    const start = Date.now();

    try {
      const result = await this.hindsightClient.reflect(target, question, {
        budget: 'high',
        maxTokens: 4096,
        include: { facts: {} },
      });

      const durationMs = Date.now() - start;
      this.onMemoryEvent?.(
        'recall',
        `Reflect: ${result.answer.length} chars in ${durationMs}ms`,
        target,
        {
          mode: 'reflect',
          durationMs,
          answerLength: result.answer.length,
          query: question.slice(0, 200),
        },
      );

      const answer = result.answer || null;
      if (answer) {
        this.reflectCache.set(cacheKey, { result: answer, ts: Date.now() });
      }
      return answer;
    } catch (err) {
      log.debug('Reflect failed', {
        bank: target,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Set up default directives for a bank if they don't already exist.
   * Directives are hard rules injected into all prompts for a bank, used to
   * encode project conventions, style guides, and security rules.
   *
   * Fully error-handled — failures are logged at debug and never throw.
   */
  async ensureDirectives(
    bankId: string,
    directives: Array<{ name: string; content: string; priority?: number }>,
  ): Promise<void> {
    if (!this.hindsightClient) return;
    try {
      const existing = await this.hindsightClient.listDirectives(bankId);
      const existingNames = new Set(existing.map((d) => d.name));

      for (const directive of directives) {
        if (!existingNames.has(directive.name)) {
          await this.hindsightClient.createDirective(bankId, directive);
          log.debug('Created directive', { bankId, name: directive.name });
        }
      }
    } catch (err) {
      log.debug('Directive setup failed', {
        bankId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Identify conversation banks older than maxAgeDays for potential cleanup.
   * Logs banks that would be deleted — actual deletion requires a deleteBank
   * method on the client (not yet implemented).
   *
   * Fully error-handled — failures are logged at debug and never throw.
   */
  async cleanupOldBanks(maxAgeDays = 30): Promise<void> {
    if (!this.hindsightClient) return;
    try {
      const banks = await this.hindsightClient.listBanks();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - maxAgeDays);

      for (const bank of banks) {
        if (bank.bank_id.startsWith('conversation-') && bank.updated_at) {
          if (new Date(bank.updated_at) < cutoff) {
            log.info('Old conversation bank eligible for deletion', {
              bankId: bank.bank_id,
              updatedAt: bank.updated_at,
              maxAgeDays,
            });
            // Actual deletion would call: await this.hindsightClient.deleteBank(bank.bank_id);
            // Not yet implemented on the client — this method logs candidates only.
          }
        }
      }
    } catch (err) {
      log.debug('Bank cleanup scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Persist the outcome of a coding run — task, requirements list, and
   * per-requirement verdicts — to the active project bank so subsequent
   * architect calls can recall it. No-op when memory is not initialised.
   *
   * The payload is stored as a single memory item with context
   * `coding-run` so downstream recall can filter / weight it.
   */
  async retainCodingRun(payload: {
    task: string;
    requirements: Array<{ id: string; description: string; acceptance?: string; coveredBy?: string[] }>;
    verdicts: Array<{ requirementId: string; status: string; evidence: string; confidence: number }>;
    decision: string;
    priorDecisionsCount?: number;
    /** Originating gateway/conversation session id; tagged onto the
     * stored memory as `session:<id>` so deleteSession purges per-session
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
    if (!this.hindsightClient) return;
    const bankId = this.activeProjectBank ?? this.config.hindsight?.defaultBank ?? 'core';

    // Format as a markdown-friendly block so future recalls show usefully
    // when concatenated alongside other memories.
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
      await this.hindsightClient.retain(bankId, [{
        content: lines.join('\n'),
        context: 'coding-run',
        timestamp: new Date().toISOString(),
        document_id: `coding-run-${Date.now()}`,
        ...(sessionTags ? { tags: sessionTags } : {}),
      }]);
      this.onMemoryEvent?.(
        'retain',
        `Persisted coding run (${payload.requirements.length} requirement(s), ${payload.verdicts.length} verdict(s))`,
        bankId,
        {
          requirementsCount: payload.requirements.length,
          verdictsCount: payload.verdicts.length,
          decision: payload.decision,
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        },
      );
    } catch (err) {
      log.warn('Failed to retain coding run', {
        bank: bankId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async storeSessionAnchor(anchor: SessionAnchor): Promise<void> {
    if (!this.sessionBootstrap) return;
    try {
      await this.sessionBootstrap.storeSessionAnchor(anchor);
      this.onMemoryEvent?.('session_anchor', 'Session anchor stored');
    } catch (err) {
      log.warn('Failed to store session anchor', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * F7: Seed mental models if they don't exist yet.
   *
   * Before doing anything, run a single capability probe: if the deployed
   * Hindsight server doesn't expose the mental-models endpoint at all
   * (older versions return 404 for every GET / refresh), short-circuit
   * the whole subsystem with a single info log and skip seeding entirely.
   * Otherwise iterate the known models and create them via refresh when
   * GET returns 404.
   *
   * The probe avoids the previous behaviour of issuing 6 noisy 404s on
   * every startup against a server that simply never supported the feature.
   */
  private async seedMentalModelsIfNeeded(): Promise<void> {
    if (!this.hindsightClient || !this.mentalModelManager) return;

    const models: Array<{ bankId: string; modelId: string }> = [
      { bankId: 'core', modelId: 'user-profile' },
      { bankId: 'core', modelId: 'session-context' },
      { bankId: 'infra', modelId: 'infra-map' },
    ];

    // Capability probe: try to GET the first model. If the server returns
    // 404 *and* a follow-up refresh also 404s, the endpoint isn't supported
    // — disable mental-models for the session.
    const [probe, ...rest] = models;
    if (!probe) return;

    let probeSucceeded = false;
    try {
      await this.hindsightClient.getMentalModel(probe.bankId, probe.modelId);
      probeSucceeded = true;
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode ?? 0;
      if (status === 404) {
        try {
          await this.hindsightClient.refreshMentalModel(probe.bankId, probe.modelId);
          log.info('Seeded mental model via refresh', { bankId: probe.bankId, modelId: probe.modelId });
          this.onMemoryEvent?.('bootstrap', `Seeded mental model: ${probe.modelId}`, probe.bankId);
          probeSucceeded = true;
        } catch (refreshErr) {
          const refreshStatus = (refreshErr as { statusCode?: number })?.statusCode ?? 0;
          if (refreshStatus === 404) {
            this.hindsightClient.setMentalModelsAvailable(false);
            log.info('Hindsight server does not expose mental-model endpoints — skipping seeding for this session', {
              probedEndpoint: `GET /v1/<ns>/banks/${probe.bankId}/mental-models/${probe.modelId}`,
            });
            this.onMemoryEvent?.('bootstrap', 'Mental models unavailable on this Hindsight version');
            return;
          }
          // Other failures (network, 5xx) — also disable for the session
          // rather than retry on every model below.
          this.hindsightClient.setMentalModelsAvailable(false);
          log.info('Mental-model capability probe failed — skipping seeding for this session', {
            error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
          });
          return;
        }
      } else {
        // Network or 5xx during probe — short-circuit, the breaker will
        // handle visibility and we don't want to try the remaining 2 models.
        this.hindsightClient.setMentalModelsAvailable(false);
        log.info('Mental-model capability probe failed — skipping seeding for this session', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }

    if (probeSucceeded) {
      this.hindsightClient.setMentalModelsAvailable(true);
    }

    for (const { bankId, modelId } of rest) {
      try {
        await this.hindsightClient.getMentalModel(bankId, modelId);
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode ?? 0;
        if (status !== 404) continue;
        try {
          await this.hindsightClient.refreshMentalModel(bankId, modelId);
          log.info('Seeded mental model via refresh', { bankId, modelId });
          this.onMemoryEvent?.('bootstrap', `Seeded mental model: ${modelId}`, bankId);
        } catch (refreshErr) {
          // Per-model failures after the probe succeeded are diagnostic noise
          // — log at debug so they're discoverable without flooding.
          log.debug('Failed to seed mental model', {
            bankId,
            modelId,
            endpoint: `POST /v1/<ns>/banks/${bankId}/mental-models/${modelId}/refresh`,
            error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
          });
        }
      }
    }
  }

  async retainConfigChange(description: string): Promise<void> {
    if (!this.selfKnowledge) return;
    try {
      await this.selfKnowledge.retainConfigChange(description);
      this.onMemoryEvent?.('self_knowledge', `Config change retained: ${description}`);
    } catch (err) {
      log.warn('Failed to retain config change', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
