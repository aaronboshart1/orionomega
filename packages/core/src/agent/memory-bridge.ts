/**
 * @module agent/memory-bridge
 * Hindsight memory integration for the main agent.
 *
 * Handles initialisation, context bootstrap, retention, compaction flush,
 * and session summaries. Separating memory concerns from the main agent
 * keeps both focused and readable.
 */

import { HindsightClient, BankManager, SessionBootstrap, MentalModelManager } from '@orionomega/hindsight';
import { AnthropicClient } from '../anthropic/client.js';
import { EventBus } from '../orchestration/event-bus.js';
import { RetentionEngine } from '../memory/retention-engine.js';
import { CompactionFlush } from '../memory/compaction-flush.js';
import { SessionSummarizer } from '../memory/session-summary.js';
import type { OrionOmegaConfig } from '../config/types.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('memory-bridge');

/** Memory subsystem configuration. */
export interface MemoryConfig {
  hindsight?: OrionOmegaConfig['hindsight'];
  model: string;
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

  private activeProjectBank: string | null = null;
  private initialised = false;

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
        this.config.model,
      );

      this.compactionFlush = new CompactionFlush(
        this.hindsightClient,
        this.anthropic,
        this.config.model,
      );

      // Bootstrap context
      const ctx = await this.sessionBootstrap.bootstrap(this.activeProjectBank ?? undefined);
      const contextBlock = this.sessionBootstrap.buildContextBlock(ctx);

      // Start listening for events
      this.retentionEngine.start();

      this.initialised = true;
      log.info('Memory subsystem initialised', { url: hsCfg.url });

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
      return this.activeProjectBank;
    } catch {
      return null;
    }
  }

  /**
   * Recall context from Hindsight for a planning operation.
   * Queries the core bank and the active project bank.
   */
  async recallForPlanning(task: string): Promise<string[]> {
    if (!this.hindsightClient) return [];
    const memories: string[] = [];

    try {
      const result = await this.hindsightClient.recall('jarvis-core', task, { maxTokens: 1024 });
      // Hindsight API returns 'results' key (not 'memories' despite typed interface)
      const items = (result as any)?.results ?? result?.memories ?? [];
      if (items.length) {
        memories.push(items.map((m: any) => m.content).join('\n\n'));
      }
    } catch { /* non-fatal */ }

    if (this.activeProjectBank) {
      try {
        const result = await this.hindsightClient.recall(this.activeProjectBank, task, { maxTokens: 2048 });
        const items = (result as any)?.results ?? result?.memories ?? [];
        if (items.length) {
          memories.push(items.map((m: any) => m.content).join('\n\n'));
        }
      } catch { /* non-fatal */ }
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
    } catch (err) {
      log.warn('Session summary failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
