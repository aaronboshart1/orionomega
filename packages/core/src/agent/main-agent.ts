/**
 * @module agent/main-agent
 * The conversational main agent for OrionOmega.
 *
 * This is a thin coordinator that wires together:
 * - conversation.ts — intent classification, conversational LLM responses
 * - orchestration-bridge.ts — plan generation and workflow execution
 * - memory-bridge.ts — Hindsight memory lifecycle
 *
 * The MainAgent itself only handles routing (which module handles this message?)
 * and shared state (history, system prompt, callbacks).
 */

import { AnthropicClient } from '../anthropic/client.js';
import type { AnthropicMessage } from '../anthropic/client.js';
import { buildSystemPrompt, type PromptContext } from './prompt-builder.js';
import { createLogger } from '../logging/logger.js';
import { SkillLoader } from '@orionomega/skills-sdk';
import type { OrionOmegaConfig } from '../config/types.js';

import type { PlannerOutput, WorkerEvent, GraphState } from '../orchestration/types.js';
import { EventBus } from '../orchestration/event-bus.js';

// Sub-modules
import {
  isFastConversational,
  isFastTask,
  isImmediateExecution,
  classifyIntent,
  streamConversation,
} from './conversation.js';
import { MemoryBridge } from './memory-bridge.js';
import { OrchestrationBridge } from './orchestration-bridge.js';

const log = createLogger('main-agent');

const MAX_HISTORY = 50;

// ── Configuration ──────────────────────────────────────────────────────────

/** Configuration for the main agent. */
export interface MainAgentConfig {
  model: string;
  apiKey: string;
  systemPrompt: string;
  workspaceDir: string;
  checkpointDir: string;
  workerTimeout: number;
  maxRetries: number;
  skillsDir?: string;
  hindsight?: OrionOmegaConfig['hindsight'];
}

// ── Callbacks ──────────────────────────────────────────────────────────────

/** Callbacks through which the agent communicates outward (typically to the gateway). */
export interface MainAgentCallbacks {
  onText: (text: string, streaming: boolean, done: boolean) => void;
  onThinking: (text: string, streaming: boolean, done: boolean) => void;
  onPlan: (plan: PlannerOutput) => void;
  onEvent: (event: WorkerEvent) => void;
  onGraphState: (state: GraphState) => void;
  onCommandResult: (result: { command: string; success: boolean; message: string }) => void;
}

// ── History ────────────────────────────────────────────────────────────────

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

// ── MainAgent ──────────────────────────────────────────────────────────────

/**
 * The main conversational agent for OrionOmega.
 *
 * Routes user messages to conversation, orchestration, or command handlers.
 * Manages shared state (history, system prompt, skill discovery).
 * All complex logic is delegated to sub-modules.
 */
export class MainAgent {
  private readonly config: MainAgentConfig;
  private readonly callbacks: MainAgentCallbacks;
  private readonly anthropic: AnthropicClient;

  private readonly memory: MemoryBridge;
  private readonly orchestration: OrchestrationBridge;

  private history: HistoryEntry[] = [];
  private cachedSystemPrompt: string | null = null;
  private availableSkills: string[] = [];

  constructor(config: MainAgentConfig, callbacks: MainAgentCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.anthropic = new AnthropicClient(config.apiKey);

    // Create the memory bridge
    this.memory = new MemoryBridge(
      { hindsight: config.hindsight, model: config.model },
      this.anthropic,
      new EventBus(), // shared event bus — orchestration bridge will use the same one
    );

    // We'll initialise orchestration in init() after skills are discovered
    this.orchestration = null!; // set in init()

    log.info('MainAgent initialised', { model: config.model });
  }

  /**
   * Initialise memory, skills, and orchestration.
   * Must be called before handling messages.
   */
  async init(): Promise<void> {
    // 1. Initialise memory — get bootstrap context for system prompt
    const contextBlock = await this.memory.init();
    if (contextBlock) {
      if (this.config.systemPrompt) {
        this.config.systemPrompt += contextBlock;
      } else {
        this.config.systemPrompt = contextBlock;
      }
      this.cachedSystemPrompt = null;
    }

    // 2. Discover skills
    if (this.config.skillsDir) {
      try {
        const skillLoader = new SkillLoader(this.config.skillsDir);
        const manifests = await skillLoader.discoverAll();
        this.availableSkills = manifests.map((m) => `${m.name}: ${m.description}`);
        log.info('Skills discovered', { count: manifests.length });
      } catch (err) {
        log.warn('Skills discovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Create orchestration bridge (needs skills list and memory bridge)
    (this as unknown as { orchestration: OrchestrationBridge }).orchestration = new OrchestrationBridge(
      {
        workspaceDir: this.config.workspaceDir,
        checkpointDir: this.config.checkpointDir,
        workerTimeout: this.config.workerTimeout,
        maxRetries: this.config.maxRetries,
      },
      this.callbacks,
      this.memory,
      this.availableSkills,
      this.config.model,
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Handle an incoming user message.
   *
   * Routes to: conversation, immediate execution, plan generation, or command.
   */
  async handleMessage(content: string): Promise<void> {
    if (!content?.trim()) {
      this.callbacks.onText('I didn\'t catch that. Could you say that again?', false, true);
      return;
    }

    const trimmed = content.trim();
    this.pushHistory({ role: 'user', content: trimmed });

    // Evaluate for preference patterns (fire-and-forget)
    if (this.memory.retention) {
      this.memory.retention.evaluateUserMessage(trimmed, this.memory.projectBank ?? undefined).catch(() => {});
    }

    try {
      // 1. Slash command
      if (trimmed.startsWith('/')) {
        await this.handleCommand(trimmed);
        return;
      }

      // 2. Fast-path conversational
      if (isFastConversational(trimmed)) {
        await this.respondConversationally(trimmed);
        return;
      }

      // 3. Pending plan + "do it"
      if (this.orchestration.hasPendingPlan && this.orchestration.pendingId && isImmediateExecution(trimmed)) {
        await this.orchestration.handlePlanResponse(
          this.orchestration.pendingId, 'approve',
          (e) => this.pushHistory(e as HistoryEntry),
        );
        return;
      }

      // 4. Immediate execution
      if (isImmediateExecution(trimmed)) {
        await this.orchestration.planAndExecute(trimmed, (e) => this.pushHistory(e as HistoryEntry));
        return;
      }

      // 5. Fast-path task
      if (isFastTask(trimmed)) {
        await this.orchestration.planOnly(trimmed, (e) => this.pushHistory(e as HistoryEntry));
        return;
      }

      // 6. Ambiguous — LLM classifier
      const intent = await classifyIntent(this.anthropic, this.config.model, trimmed);
      if (intent === 'TASK') {
        await this.orchestration.planOnly(trimmed, (e) => this.pushHistory(e as HistoryEntry));
      } else {
        await this.respondConversationally(trimmed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleMessage error', { error: msg });
      this.callbacks.onText(`Something went wrong: ${msg}`, false, true);
    }
  }

  /** Handle a plan response (approve, modify, reject). */
  async handlePlanResponse(planId: string, action: string, modification?: string): Promise<void> {
    try {
      await this.orchestration.handlePlanResponse(
        planId, action,
        (e) => this.pushHistory(e as HistoryEntry),
        modification,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handlePlanResponse error', { error: msg });
      this.callbacks.onText(`Error handling plan response: ${msg}`, false, true);
    }
  }

  /** Handle a slash command. */
  async handleCommand(command: string): Promise<void> {
    try {
      // Normalize: commands may arrive with or without the leading slash
      const raw = command.trim().toLowerCase();
      const cmd = raw.startsWith('/') ? raw : `/${raw}`;

      // Client-side commands that should never reach the server
      if (cmd === '/exit' || cmd === '/quit' || cmd === '/q') {
        this.callbacks.onCommandResult({
          command: cmd, success: true,
          message: 'Goodbye.',
        });
        return;
      }

      if (cmd === '/help') {
        this.callbacks.onCommandResult({
          command: '/help', success: true,
          message: [
            'Available commands:',
            '  /status  — Current workflow status',
            '  /stop    — Stop the active workflow',
            '  /pause   — Pause before next layer',
            '  /resume  — Resume a paused workflow',
            '  /plan    — Show the current plan',
            '  /workers — List active workers',
            '  /reset   — Clear pending plans and history',
            '  /help    — This message',
          ].join('\n'),
        });
        return;
      }

      if (cmd === '/reset') {
        this.orchestration.clearPendingPlan();
        this.orchestration.stop();
        this.history = [];
        this.cachedSystemPrompt = null;
        this.callbacks.onCommandResult({
          command: '/reset', success: true,
          message: 'Reset complete. Pending plans cleared, history wiped, executor stopped.',
        });
        return;
      }

      if (!this.orchestration?.commands) {
        this.callbacks.onCommandResult({
          command: cmd, success: false,
          message: 'Agent not fully initialised. Try again in a moment.',
        });
        return;
      }
      const result = await this.orchestration.commands.handle(cmd);
      this.callbacks.onCommandResult({ command: cmd, success: result.success, message: result.message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onCommandResult({ command, success: false, message: `Command failed: ${msg}` });
    }
  }

  /** Flush memory before compaction. */
  async flushMemory(): Promise<void> {
    await this.memory.flush(this.history);
  }

  /** Summarize the session to Hindsight. */
  async summarizeSession(): Promise<void> {
    await this.memory.summarize(this.history);
  }

  /** Get the shared event bus. */
  getEventBus(): EventBus {
    return this.orchestration.eventBus;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private async respondConversationally(userMessage: string): Promise<void> {
    const systemPrompt = await this.getSystemPrompt();
    const messages = this.buildAnthropicMessages();

    try {
      const fullText = await streamConversation({
        client: this.anthropic,
        model: this.config.model,
        systemPrompt,
        messages,
        workspaceDir: this.config.workspaceDir,
        onText: this.callbacks.onText,
      });
      this.pushHistory({ role: 'assistant', content: fullText });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Conversational response error', { error: msg });
      const fallback = 'I seem to be having trouble reaching my language centre. Give me a moment.';
      this.callbacks.onText(fallback, false, true);
      this.pushHistory({ role: 'assistant', content: fallback });
    }
  }

  private async getSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt) return this.cachedSystemPrompt;
    if (this.config.systemPrompt) {
      this.cachedSystemPrompt = this.config.systemPrompt;
      return this.cachedSystemPrompt;
    }
    const context: PromptContext = {
      workspaceDir: this.config.workspaceDir,
      activeWorkflow: this.orchestration.executor !== null,
    };
    this.cachedSystemPrompt = await buildSystemPrompt(context);
    return this.cachedSystemPrompt;
  }

  private buildAnthropicMessages(): AnthropicMessage[] {
    return this.history.map((entry) => ({ role: entry.role, content: entry.content }));
  }

  private pushHistory(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }
}
