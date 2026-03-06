/**
 * @module agent/main-agent
 * The conversational main agent for OrionOmega.
 *
 * The MainAgent is the single entry-point for user interaction. It classifies
 * incoming messages as either conversational or task-oriented, delegates tasks
 * to the orchestration engine (Planner → GraphExecutor), and streams responses
 * back through callbacks that the gateway wires to WebSocket clients.
 *
 * It NEVER does work itself — all real work is performed by orchestration workers.
 */

import { AnthropicClient } from '../anthropic/client.js';
import type { AnthropicMessage, AnthropicStreamEvent } from '../anthropic/client.js';
import { Planner } from '../orchestration/planner.js';
import { GraphExecutor } from '../orchestration/executor.js';
import type { ExecutorConfig } from '../orchestration/executor.js';
import { EventBus } from '../orchestration/event-bus.js';
import { OrchestratorCommands } from '../orchestration/commands.js';
import type {
  PlannerOutput,
  WorkerEvent,
  GraphState,
  ExecutionResult,
} from '../orchestration/types.js';
import { buildSystemPrompt, type PromptContext } from './prompt-builder.js';
import { createLogger } from '../logging/logger.js';

// Skills SDK
import { SkillLoader } from '@orionomega/skills-sdk';

// Memory integration
import { HindsightClient } from '@orionomega/hindsight';
import {
  BankManager,
  SessionBootstrap,
  RetentionEngine,
  MentalModelManager,
  SessionSummarizer,
  CompactionFlush,
} from '../memory/index.js';
import type { OrionOmegaConfig } from '../config/types.js';

const log = createLogger('main-agent');

// ── Configuration ──────────────────────────────────────────────────────────

/** Configuration for the main agent. */
export interface MainAgentConfig {
  /** Anthropic model to use for conversational responses. */
  model: string;
  /** Anthropic API key. */
  apiKey: string;
  /** Pre-built system prompt (if empty, prompt-builder is used on first message). */
  systemPrompt: string;
  /** Path to the workspace directory. */
  workspaceDir: string;
  /** Path to the checkpoint directory. */
  checkpointDir: string;
  /** Default worker timeout in seconds. */
  workerTimeout: number;
  /** Maximum retries per worker node. */
  maxRetries: number;
  /** Path to the skills directory (optional — skill discovery disabled when absent). */
  skillsDir?: string;
  /** Hindsight configuration (optional — memory features disabled when absent). */
  hindsight?: OrionOmegaConfig['hindsight'];
}

// ── Callbacks ──────────────────────────────────────────────────────────────

/** Callbacks through which the agent communicates outward (typically to the gateway). */
export interface MainAgentCallbacks {
  /** Streamed or complete text response. */
  onText: (text: string, streaming: boolean, done: boolean) => void;
  /** Streamed or complete thinking block. */
  onThinking: (text: string, streaming: boolean, done: boolean) => void;
  /** A new plan is ready for user review. */
  onPlan: (plan: PlannerOutput) => void;
  /** A worker event worth surfacing to the user. */
  onEvent: (event: WorkerEvent) => void;
  /** Updated graph state snapshot. */
  onGraphState: (state: GraphState) => void;
  /** Result of a slash command. */
  onCommandResult: (result: { command: string; success: boolean; message: string }) => void;
}

// ── Conversation history entry ─────────────────────────────────────────────

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

// ── Intent detection ───────────────────────────────────────────────────────

/** Phrases that signal the user wants immediate execution (no planning step). */
const IMMEDIATE_PATTERNS = [
  /\brun\s*it\b/i,
  /\bdo\s*it\b/i,
  /\bexecute\b/i,
  /\bgo\s*ahead\b/i,
  /\bbuild\s*it\b/i,
  /\bjust\s*do\s*it\b/i,
];

/** Quick-match conversational patterns (no LLM call needed). */
const CONVERSATIONAL_FAST = [
  /^(hi|hello|hey|yo|sup|howdy|greetings)\b/i,
  /^(thanks|thank\s*you|cheers|ta)\b/i,
  /^(good\s*(morning|afternoon|evening|night))\b/i,
  /^who\s+are\s+you/i,
  /^how\s+are\s+you/i,
  /^help\b/i,
  /^(ok|okay|sure|alright|got\s*it|understood)\b/i,
  /^(yes|no|yep|nope|yeah|nah)\b/i,
];

/** Quick-match patterns that almost certainly need orchestration. */
const TASK_FAST = [
  /\b(research|investigate|analyze|compare|build|create|write|generate|deploy|set\s*up|install|configure)\b.*\b(and|then|also|plus|save|output|file)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bmulti[- ]?step\b/i,
];

const MAX_HISTORY = 50;

/** The LLM-based intent classification prompt. */
const CLASSIFY_PROMPT = `You are an intent classifier for an AI orchestration system.
Given a user message, classify it as one of:
- CHAT: Conversational, simple questions, greetings, opinions, single-step answers the assistant can give directly. Examples: "what is 2+2?", "explain quantum computing", "what's the weather?", "tell me a joke", "what do you think about X?"
- TASK: Multi-step work requiring research, file operations, code generation, comparisons, or coordinated effort. Examples: "research X and write a report", "build a landing page", "compare A, B, and C with benchmarks", "deploy X to production"

Bias: When in doubt, prefer CHAT. Only classify as TASK when the request clearly needs multiple coordinated steps, external research, file creation, or multi-agent work.

Respond with ONLY the word CHAT or TASK.`;

/**
 * Determines if a message should be treated as immediate execution.
 */
function isImmediateExecution(content: string): boolean {
  return IMMEDIATE_PATTERNS.some((p) => p.test(content));
}

/**
 * Fast-path conversational check (no LLM needed).
 * Returns true for obvious greetings/acks, false otherwise.
 */
function isFastConversational(content: string): boolean {
  const trimmed = content.trim();
  const wordCount = trimmed.split(/\s+/).length;
  // Very short messages (1-3 words) that match greeting patterns
  if (wordCount <= 3 && CONVERSATIONAL_FAST.some((p) => p.test(trimmed))) return true;
  // Any fast-match pattern with <=8 words
  if (wordCount <= 8 && CONVERSATIONAL_FAST.some((p) => p.test(trimmed))) return true;
  return false;
}

/**
 * Fast-path task check (no LLM needed).
 * Returns true for messages that obviously need orchestration.
 */
function isFastTask(content: string): boolean {
  return TASK_FAST.some((p) => p.test(content.trim()));
}

// ── MainAgent ──────────────────────────────────────────────────────────────

/**
 * The main conversational agent for OrionOmega.
 *
 * Classifies user messages, delegates tasks to the orchestration engine,
 * and streams responses back through callbacks. Stateful — holds the
 * current pending plan, active executor, and conversation history.
 */
export class MainAgent {
  private readonly config: MainAgentConfig;
  private readonly callbacks: MainAgentCallbacks;
  private readonly anthropic: AnthropicClient;
  private readonly planner: Planner;
  private readonly eventBus: EventBus;
  private readonly commands: OrchestratorCommands;

  /** Conversation history (most recent messages, capped at MAX_HISTORY). */
  private history: HistoryEntry[] = [];

  /** Cached system prompt (built lazily on first message). */
  private cachedSystemPrompt: string | null = null;

  // ── Memory integration ─────────────────────────────────────────────────
  private hindsightClient: HindsightClient | null = null;
  private bankManager: BankManager | null = null;
  private sessionBootstrap: SessionBootstrap | null = null;
  private retentionEngine: RetentionEngine | null = null;
  private mentalModelManager: MentalModelManager | null = null;
  private sessionSummarizer: SessionSummarizer | null = null;
  private compactionFlush: CompactionFlush | null = null;
  /** Active project bank for the current session. */
  private activeProjectBank: string | null = null;
  /** Whether memory subsystem has been initialised. */
  private memoryInitialised = false;

  /** Skills loader for discovering available skills. */
  private skillLoader: SkillLoader | null = null;
  /** Discovered skills (name: description) passed to the planner. */
  private availableSkills: string[] = [];

  /** The plan currently awaiting user approval. */
  private pendingPlan: PlannerOutput | null = null;
  /** ID of the pending plan (workflow graph ID). */
  private pendingPlanId: string | null = null;
  /** Original task text that generated the pending plan. */
  private pendingPlanTask: string | null = null;

  /** The currently running executor. */
  private activeExecutor: GraphExecutor | null = null;
  /** Unsubscribe callback for event bus during execution. */
  private eventUnsubscribe: (() => void) | null = null;
  /** Timer for periodic graph state snapshots. */
  private stateSnapshotTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Creates a new MainAgent instance.
   *
   * @param config - Agent configuration (model, keys, paths).
   * @param callbacks - Output callbacks (text, plans, events → gateway).
   */
  constructor(config: MainAgentConfig, callbacks: MainAgentCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.anthropic = new AnthropicClient(config.apiKey);
    this.planner = new Planner({ model: config.model });
    this.eventBus = new EventBus();
    this.commands = new OrchestratorCommands(null);

    log.info('MainAgent initialised', { model: config.model });
  }

  // ── Memory lifecycle ───────────────────────────────────────────────────

  /**
   * Initialise the Hindsight memory subsystem.
   *
   * Creates all memory components, bootstraps context from Hindsight,
   * appends it to the system prompt, and starts the retention engine.
   * Safe to call multiple times — subsequent calls are no-ops.
   * If hindsight config is absent, this is a no-op.
   */
  async init(): Promise<void> {
    if (this.memoryInitialised) return;

    const hsCfg = this.config.hindsight;
    if (!hsCfg?.url) {
      log.info('Hindsight not configured — memory features disabled');
      return;
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
        },
      );

      this.sessionSummarizer = new SessionSummarizer(
        this.hindsightClient,
        this.anthropic,
        this.config.model,
      );

      this.compactionFlush = new CompactionFlush(
        this.hindsightClient,
        this.anthropic,
        this.config.model, // ideally a cheap model; caller can set to haiku
      );

      // Bootstrap context
      const ctx = await this.sessionBootstrap.bootstrap(this.activeProjectBank ?? undefined);
      const contextBlock = this.sessionBootstrap.buildContextBlock(ctx);
      if (contextBlock) {
        // Append to existing system prompt or set it
        if (this.config.systemPrompt) {
          this.config.systemPrompt += contextBlock;
        } else {
          this.config.systemPrompt = contextBlock;
        }
        // Invalidate cached prompt so it picks up the new content
        this.cachedSystemPrompt = null;
      }

      // Start listening for events
      this.retentionEngine.start();

      this.memoryInitialised = true;
      log.info('Memory subsystem initialised', { url: hsCfg.url });
    } catch (err) {
      log.warn('Memory subsystem init failed — continuing without memory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Initialise skills loader and discover available skills
    if (this.config.skillsDir) {
      try {
        this.skillLoader = new SkillLoader(this.config.skillsDir);
        const manifests = await this.skillLoader.discoverAll();
        this.availableSkills = manifests.map((m) => `${m.name}: ${m.description}`);
        log.info('Skills discovered', { count: manifests.length });
      } catch (err) {
        log.warn('Skills discovery failed — continuing without skills', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Flush conversation context to Hindsight before compaction.
   * Extracts all noteworthy information from the current conversation.
   */
  async flushMemory(): Promise<void> {
    if (!this.compactionFlush) return;

    const bankId = this.activeProjectBank ?? this.config.hindsight?.defaultBank ?? 'core';
    const messages = this.history.map((h) => ({ role: h.role, content: h.content }));

    try {
      const result = await this.compactionFlush.flush(messages, bankId);
      log.info('Memory flushed before compaction', { itemsRetained: result.itemsRetained });
    } catch (err) {
      log.warn('Memory flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Summarize the current session and retain the summary to Hindsight.
   */
  async summarizeSession(): Promise<void> {
    if (!this.sessionSummarizer) return;

    const messages = this.history.map((h) => ({ role: h.role, content: h.content }));

    try {
      await this.sessionSummarizer.summarize(messages, this.activeProjectBank ?? undefined);
      log.info('Session summarised');
    } catch (err) {
      log.warn('Session summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Handle an incoming user message.
   *
   * Routes to one of three paths:
   * 1. **Conversational** — short greetings / status queries → LLM response
   * 2. **Immediate execution** — user said "do it" / "run it" → plan + execute
   * 3. **Plan first** (default) — plan and present for approval
   *
   * @param content - The user's message text.
   */
  async handleMessage(content: string): Promise<void> {
    if (!content || !content.trim()) {
      this.callbacks.onText('I didn\'t catch that. Could you say that again?', false, true);
      return;
    }

    const trimmed = content.trim();

    // Record in history
    this.pushHistory({ role: 'user', content: trimmed });

    // Evaluate user message for preference/decision patterns (fire-and-forget)
    if (this.retentionEngine) {
      this.retentionEngine
        .evaluateUserMessage(trimmed, this.activeProjectBank ?? undefined)
        .catch(() => {});
    }

    try {
      // 1. Slash command?
      if (trimmed.startsWith('/')) {
        await this.handleCommand(trimmed);
        return;
      }

      // 2. Fast-path conversational (greetings, acks — no LLM call needed)
      if (isFastConversational(trimmed)) {
        await this.respondConversationally(trimmed);
        return;
      }

      // 3. Immediate execution or plan approval shortcut?
      //    If there's a pending plan and user says "do it", approve it.
      if (this.pendingPlan && this.pendingPlanId && isImmediateExecution(trimmed)) {
        await this.handlePlanResponse(this.pendingPlanId, 'approve');
        return;
      }

      // 4. Immediate execution with new task
      if (isImmediateExecution(trimmed)) {
        await this.planAndExecute(trimmed);
        return;
      }

      // 5. Fast-path task detection (obviously multi-step requests)
      if (isFastTask(trimmed)) {
        await this.planOnly(trimmed);
        return;
      }

      // 6. Ambiguous — use LLM classifier to decide
      const intent = await this.classifyIntent(trimmed);
      if (intent === 'TASK') {
        await this.planOnly(trimmed);
      } else {
        await this.respondConversationally(trimmed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleMessage error', { error: msg });
      this.callbacks.onText(
        `Something went wrong while processing your request: ${msg}`,
        false,
        true,
      );
    }
  }

  /**
   * Handle a plan response (approve, modify, or reject).
   *
   * @param planId - The workflow graph ID of the plan being responded to.
   * @param action - One of 'approve', 'modify', or 'reject'.
   * @param modification - Additional instruction when action is 'modify'.
   */
  async handlePlanResponse(
    planId: string,
    action: string,
    modification?: string,
  ): Promise<void> {
    try {
      if (!this.pendingPlan || this.pendingPlanId !== planId) {
        this.callbacks.onText(
          'That plan is no longer available. It may have expired or been superseded.',
          false,
          true,
        );
        return;
      }

      switch (action) {
        case 'approve':
          // Ensure project bank exists for this task
          if (this.bankManager && this.pendingPlanTask) {
            try {
              this.activeProjectBank = await this.bankManager.ensureProjectBank(this.pendingPlanTask);
            } catch {
              // Non-fatal — continue without project bank
            }
          }
          await this.executePlan(this.pendingPlan);
          break;

        case 'modify': {
          const originalTask = this.pendingPlanTask ?? '';
          const modifiedTask = modification
            ? `${originalTask}\n\nModification: ${modification}`
            : originalTask;
          this.clearPendingPlan();
          this.callbacks.onText('Re-planning with your modifications…', true, true);
          await this.planOnly(modifiedTask);
          break;
        }

        case 'reject':
          this.clearPendingPlan();
          this.callbacks.onText(
            'Plan rejected. What would you like instead?',
            false,
            true,
          );
          break;

        default:
          this.callbacks.onText(
            `Unknown plan action: '${action}'. Use approve, modify, or reject.`,
            false,
            true,
          );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handlePlanResponse error', { error: msg });
      this.callbacks.onText(`Error handling plan response: ${msg}`, false, true);
    }
  }

  /**
   * Handle a slash command (e.g. /status, /stop, /workers).
   *
   * @param command - The full command string including the leading slash.
   */
  async handleCommand(command: string): Promise<void> {
    try {
      const cmd = command.trim().toLowerCase();

      // Commands that don't need an active executor
      if (cmd === '/help') {
        this.callbacks.onCommandResult({
          command: '/help',
          success: true,
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
        this.clearPendingPlan();
        this.stopExecution();
        this.history = [];
        this.cachedSystemPrompt = null;
        this.callbacks.onCommandResult({
          command: '/reset',
          success: true,
          message: 'Reset complete. Pending plans cleared, history wiped, executor stopped.',
        });
        return;
      }

      // Delegate to OrchestratorCommands
      const result = await this.commands.handle(cmd);
      this.callbacks.onCommandResult({
        command: cmd,
        success: result.success,
        message: result.message,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleCommand error', { error: msg });
      this.callbacks.onCommandResult({
        command,
        success: false,
        message: `Command failed: ${msg}`,
      });
    }
  }

  /**
   * Returns the shared EventBus for external subscribers (e.g. the gateway).
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  // ── Internal: Conversational response ────────────────────────────────────

  /**
   * Generates a streaming conversational response via the Anthropic API.
   */
  private async respondConversationally(userMessage: string): Promise<void> {
    const systemPrompt = await this.getSystemPrompt();
    const messages: AnthropicMessage[] = this.buildAnthropicMessages();

    let fullText = '';

    try {
      const stream = this.anthropic.streamMessage({
        model: this.config.model,
        system: systemPrompt,
        messages,
        maxTokens: 1024,
        temperature: 0.7,
      });

      for await (const event of stream) {
        const text = this.extractTextDelta(event);
        if (text) {
          fullText += text;
          this.callbacks.onText(text, true, false);
        }
      }

      // Signal done
      this.callbacks.onText('', true, true);
      this.pushHistory({ role: 'assistant', content: fullText });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Conversational response error', { error: msg });
      const fallback = 'I seem to be having trouble reaching my language centre. Give me a moment.';
      this.callbacks.onText(fallback, false, true);
      this.pushHistory({ role: 'assistant', content: fallback });
    }
  }

  // ── Internal: Intent classification ───────────────────────────────────────

  /**
   * Uses a fast LLM call to classify ambiguous messages as CHAT or TASK.
   * Falls back to CHAT on error (conversational is the safe default).
   */
  private async classifyIntent(message: string): Promise<'CHAT' | 'TASK'> {
    try {
      const response = await this.anthropic.createMessage({
        model: this.config.model,
        system: CLASSIFY_PROMPT,
        messages: [{ role: 'user', content: message }],
        maxTokens: 8,
        temperature: 0,
      });

      const text = response.content?.[0]?.text?.trim().toUpperCase() ?? 'CHAT';
      log.info('Intent classified', { message: message.slice(0, 80), intent: text });

      if (text.includes('TASK')) return 'TASK';
      return 'CHAT';
    } catch (err) {
      log.warn('Intent classification failed, defaulting to CHAT', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 'CHAT';
    }
  }

    // ── Internal: Planning ───────────────────────────────────────────────────

  /**
   * Creates a plan and presents it to the user without executing.
   */
  private async planOnly(task: string): Promise<void> {
    this.callbacks.onThinking('Analysing your request and building an execution plan…', true, false);

    try {
    // Recall relevant context from Hindsight before planning
    const memories: string[] = [];
    if (this.hindsightClient) {
      try {
        const result = await this.hindsightClient.recall('jarvis-core', task, { maxTokens: 1024 });
        if (result?.memories?.length) {
          memories.push(result.memories.map((m) => m.content).join('\n\n'));
        }
      } catch {}
      if (this.activeProjectBank) {
        try {
          const result = await this.hindsightClient.recall(this.activeProjectBank, task, { maxTokens: 2048 });
          if (result?.memories?.length) {
            memories.push(result.memories.map((m) => m.content).join('\n\n'));
          }
        } catch {}
      }
    }
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      });

      this.pendingPlan = plan;
      this.pendingPlanId = plan.graph.id;
      this.pendingPlanTask = task;

      this.callbacks.onThinking('', true, true);
      this.callbacks.onPlan(plan);
      this.pushHistory({
        role: 'assistant',
        content: `[Plan presented] ${plan.summary}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Planning error', { error: msg });
      this.callbacks.onText(`Failed to generate a plan: ${msg}`, false, true);
    }
  }

  /**
   * Creates a plan and immediately executes it (for "do it" / "run it" messages).
   */
  private async planAndExecute(task: string): Promise<void> {
    this.callbacks.onThinking('Planning and executing immediately…', true, false);

    try {
    // Recall relevant context from Hindsight before planning
    const memories: string[] = [];
    if (this.hindsightClient) {
      try {
        const result = await this.hindsightClient.recall('jarvis-core', task, { maxTokens: 1024 });
        if (result?.memories?.length) {
          memories.push(result.memories.map((m) => m.content).join('\n\n'));
        }
      } catch {}
      if (this.activeProjectBank) {
        try {
          const result = await this.hindsightClient.recall(this.activeProjectBank, task, { maxTokens: 2048 });
          if (result?.memories?.length) {
            memories.push(result.memories.map((m) => m.content).join('\n\n'));
          }
        } catch {}
      }
    }
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      });
      this.callbacks.onThinking('', true, true);
      this.callbacks.onPlan(plan);
      this.pushHistory({
        role: 'assistant',
        content: `[Plan auto-approved] ${plan.summary}`,
      });
      await this.executePlan(plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Plan-and-execute error', { error: msg });
      this.callbacks.onText(`Failed to plan or execute: ${msg}`, false, true);
    }
  }

  // ── Internal: Execution ──────────────────────────────────────────────────

  /**
   * Starts executing a plan via the GraphExecutor.
   */
  private async executePlan(plan: PlannerOutput): Promise<void> {
    this.clearPendingPlan();

    const executorConfig: ExecutorConfig = {
      workspaceDir: this.config.workspaceDir,
      checkpointDir: this.config.checkpointDir,
      workerTimeout: this.config.workerTimeout,
      maxRetries: this.config.maxRetries,
      checkpointInterval: 1,
    };

    const executor = new GraphExecutor(plan.graph, this.eventBus, executorConfig);
    this.activeExecutor = executor;
    this.commands.setExecutor(executor);

    // Subscribe to events for relay
    this.eventUnsubscribe = this.eventBus.subscribe('*', (event) => {
      this.handleWorkerEvent(event);
    });

    // Start periodic graph state snapshots
    this.stateSnapshotTimer = setInterval(() => {
      if (this.activeExecutor) {
        this.callbacks.onGraphState(this.activeExecutor.getState());
      }
    }, 2_000);

    this.callbacks.onText('Workflow started. I\'ll keep you posted on progress.', false, true);
    this.pushHistory({ role: 'assistant', content: '[Workflow execution started]' });

    try {
      const result = await executor.execute();
      this.onExecutionComplete(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Execution error', { error: msg });
      this.callbacks.onText(`Workflow failed: ${msg}`, false, true);
    } finally {
      this.cleanupExecution();
    }
  }

  /**
   * Handles worker events during execution, filtering for user-relevant ones.
   */
  private handleWorkerEvent(event: WorkerEvent): void {
    // Relay all worker events to the UI for real-time streaming visibility.
    // The TUI and Web UI filter what they display — let them decide.
    this.callbacks.onEvent(event);

    // Push graph state on significant events for immediate UI updates
    if (event.type === 'done' || event.type === 'error' || event.type === 'status') {
      if (this.activeExecutor) {
        this.callbacks.onGraphState(this.activeExecutor.getState());
      }
    }
  }

  /**
   * Called when the executor finishes (success, error, or stopped).
   */
  private onExecutionComplete(result: ExecutionResult): void {
    // Retain workflow outcome to Hindsight (fire-and-forget)
    if (this.retentionEngine && this.activeProjectBank) {
      this.retentionEngine.retainWorkflowOutcome({
        bankId: this.activeProjectBank,
        taskSummary: result.taskSummary,
        workerCount: result.workerCount,
        durationSec: result.durationSec,
        outputPaths: result.outputPaths,
        decisions: result.decisions,
        findings: result.findings,
        errors: result.errors,
        infraChanges: result.infraChanges,
      }).catch(() => {});
    }

    const {
      status, durationSec, workerCount, findings, errors,
      taskSummary, outputPaths, decisions,
    } = result;

    const lines: string[] = [];

    if (status === 'complete') {
      lines.push('✅ Workflow complete.');
    } else if (status === 'error') {
      lines.push('⚠️ Workflow finished with errors.');
    } else {
      lines.push('🛑 Workflow stopped.');
    }

    // Task summary
    if (taskSummary) {
      lines.push('');
      lines.push(taskSummary);
    }

    // Key findings
    if (findings.length > 0) {
      lines.push('');
      lines.push('Key findings:');
      for (const f of findings.slice(0, 8)) {
        lines.push(`  • ${f}`);
      }
    }

    // Key decisions
    if (decisions.length > 0) {
      lines.push('');
      lines.push('Decisions:');
      for (const d of decisions.slice(0, 5)) {
        lines.push(`  • ${d}`);
      }
    }

    // Output files
    if (outputPaths.length > 0) {
      lines.push('');
      lines.push('Output files:');
      for (const p of outputPaths) {
        lines.push(`  📄 ${p}`);
      }
    }

    // Errors
    if (errors.length > 0) {
      lines.push('');
      lines.push('Errors:');
      for (const e of errors.slice(0, 5)) {
        lines.push(`  ❌ ${e.worker}: ${e.message}`);
      }
    }

    // Stats line
    lines.push('');
    lines.push(`⏱️ ${durationSec.toFixed(1)}s | ${workerCount} workers`);

    const summary = lines.join('\n');
    this.callbacks.onText(summary, false, true);
    this.pushHistory({ role: 'assistant', content: `[Workflow result] ${summary}` });

    // Send final graph state
    if (this.activeExecutor) {
      this.callbacks.onGraphState(this.activeExecutor.getState());
    }
  }

  // ── Internal: Cleanup & helpers ──────────────────────────────────────────

  private clearPendingPlan(): void {
    this.pendingPlan = null;
    this.pendingPlanId = null;
    this.pendingPlanTask = null;
  }

  private stopExecution(): void {
    if (this.activeExecutor) {
      this.activeExecutor.stop();
    }
    this.cleanupExecution();
  }

  private cleanupExecution(): void {
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }
    if (this.stateSnapshotTimer) {
      clearInterval(this.stateSnapshotTimer);
      this.stateSnapshotTimer = null;
    }
    this.activeExecutor = null;
    this.commands.setExecutor(null as unknown as GraphExecutor);
  }

  /**
   * Lazily builds and caches the system prompt.
   */
  private async getSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt) return this.cachedSystemPrompt;

    if (this.config.systemPrompt) {
      this.cachedSystemPrompt = this.config.systemPrompt;
      return this.cachedSystemPrompt;
    }

    const context: PromptContext = {
      workspaceDir: this.config.workspaceDir,
      activeWorkflow: this.activeExecutor !== null,
    };

    this.cachedSystemPrompt = await buildSystemPrompt(context);
    return this.cachedSystemPrompt;
  }

  /**
   * Builds the Anthropic messages array from conversation history.
   */
  private buildAnthropicMessages(): AnthropicMessage[] {
    return this.history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
  }

  /**
   * Pushes an entry to conversation history, trimming to MAX_HISTORY.
   */
  private pushHistory(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  /**
   * Extracts text delta from an Anthropic stream event.
   */
  private extractTextDelta(event: AnthropicStreamEvent): string | null {
    // content_block_delta with text delta
    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return delta.text;
      }
    }
    return null;
  }
}
