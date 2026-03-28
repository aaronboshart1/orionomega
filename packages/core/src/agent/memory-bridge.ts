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
        { retainOnComplete: hsCfg.retainOnComplete, retainOnError: hsCfg.retainOnError },
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

      if (this.onMemoryEvent) {
        this.retentionEngine.onMemoryEvent = (op, detail, bank, meta) => {
          this.onMemoryEvent?.(op as MemoryOp, detail, bank, meta);
        };

        this.hindsightClient.onIO = (event) => {
          this.onMemoryEvent?.(event.op as MemoryOp, event.detail, event.bank, event.meta);
        };
      }

      this.retentionEngine.start();

      this.initialised = true;
      log.info('Memory subsystem initialised', { url: hsCfg.url });
      this.onMemoryEvent?.('bootstrap', 'Memory subsystem initialised', undefined, { url: hsCfg.url });

      this.selfKnowledge.bootstrap({
        apiEndpoint: hsCfg.url,
        deduplicationThreshold: 0.85,
        relevanceFloor: 0.3,
        qualityThreshold: 0.3,
        budgetTiers: { low: 1024, mid: 4096, high: 8192 },
        architecturalDecisions: [
          'Hindsight stores memories in isolated banks with namespace separation',
          'Mental models are pre-synthesized context documents refreshed on retention triggers',
          'Session anchors capture continuity state at session boundaries',
          'Memory quality scoring filters low-signal content before storage',
          'Causal chain retrieval formats decision → action → outcome narratives in recall',
        ],
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
      this.onMemoryEvent?.('bootstrap', `Project bank ready: ${this.activeProjectBank}`, this.activeProjectBank);
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
   */
  async recallForPlanning(task: string): Promise<string[]> {
    if (!this.hindsightClient) return [];

    if (isExternalAction(task)) {
      log.debug('Skipping Hindsight recall for external action task');
      return [];
    }

    const memories: string[] = [];

    try {
      const result = await this.hindsightClient.recall('core', task, { maxTokens: 1024 });
      if (result.results.length) {
        memories.push(result.results.map((m) => m.content).join('\n\n'));
      }
    } catch (err) {
      log.warn('Core bank recall failed for planning', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (this.activeProjectBank) {
      try {
        const result = await this.hindsightClient.recall(this.activeProjectBank, task, { maxTokens: 2048 });
        if (result.results.length) {
          memories.push(result.results.map((m) => m.content).join('\n\n'));
        }
      } catch (err) {
        log.warn('Project bank recall failed for planning', {
          bank: this.activeProjectBank,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return memories;
  }

  /**
   * Flush conversation context to Hindsight before compaction.
   */
  async flush(history: Array<{ role: string; content: string }>): Promise<void> {
    if (!this.compactionFlush) return;

    const bankId = this.activeProjectBank ?? this.config.hindsight?.defaultBank ?? 'core';
    try {
      const result = await this.compactionFlush.flush(history, bankId);
      log.info('Memory flushed before compaction', { itemsRetained: result.itemsRetained });
      this.onMemoryEvent?.('flush', `Flushed ${result.itemsRetained} items to memory`, bankId, { itemsRetained: result.itemsRetained });
    } catch (err) {
      log.warn('Memory flush failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Summarize the current session and retain to Hindsight.
   */
  async summarize(history: Array<{ role: string; content: string }>): Promise<void> {
    if (!this.sessionSummarizer) return;

    try {
      await this.sessionSummarizer.summarize(history, this.activeProjectBank ?? undefined);
      log.info('Session summarised');
      this.onMemoryEvent?.('summary', 'Session summary retained', this.activeProjectBank ?? undefined);
    } catch (err) {
      log.warn('Session summary failed', { error: err instanceof Error ? err.message : String(err) });
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
