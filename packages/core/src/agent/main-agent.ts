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

import { spawn } from 'node:child_process';
import { AnthropicClient } from '../anthropic/client.js';
import type { AnthropicMessage } from '../anthropic/client.js';
import { buildSystemPrompt, type PromptContext } from './prompt-builder.js';
import { createLogger } from '../logging/logger.js';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { OrionOmegaConfig } from '../config/types.js';
import { CommandFileLoader } from '../commands/command-file-loader.js';

import type {
  PlannerOutput, WorkerEvent, GraphState, WorkflowCheckpoint,
  DAGDispatchInfo, DAGProgressInfo, DAGCompleteInfo, DAGConfirmInfo, DirectCompleteInfo,
} from '../orchestration/types.js';
import { EventBus } from '../orchestration/event-bus.js';

// Sub-modules
import {
  isFastConversational,
  isImmediateExecution,
  isOrchestrateRequest,
  isGuardedRequest,
  classifyIntent,
  streamConversation,
} from './conversation.js';
import { MemoryBridge } from './memory-bridge.js';
import { OrchestrationBridge } from './orchestration-bridge.js';
import { ContextAssembler } from '../memory/context-assembler.js';

const log = createLogger('main-agent');

// ── Configuration ──────────────────────────────────────────────────────────

/** Configuration for the main agent. */
export interface MainAgentConfig {
  model: string;
  cheapModel?: string;
  apiKey: string;
  systemPrompt: string;
  workspaceDir: string;
  checkpointDir: string;
  workerTimeout: number;
  maxRetries: number;
  skillsDir?: string;
  commandsDir?: string;
  hindsight?: OrionOmegaConfig['hindsight'];
  autoResume?: boolean;
  /** Path to the source repo for coding mode. */
  codingRepoDir?: string;
}

// ── Callbacks ──────────────────────────────────────────────────────────────

/** Callbacks through which the agent communicates outward (typically to the gateway). */
export type ThinkingStepStatus = 'pending' | 'active' | 'done';

export interface ThinkingStep {
  id: string;
  name: string;
  status: ThinkingStepStatus;
  startedAt?: number;
  completedAt?: number;
  elapsedMs?: number;
  detail?: string;
}

export interface MainAgentCallbacks {
  onText: (text: string, streaming: boolean, done: boolean, workflowId?: string) => void;
  onThinking: (text: string, streaming: boolean, done: boolean, workflowId?: string) => void;
  onThinkingStep?: (step: ThinkingStep, workflowId?: string) => void;
  /** @deprecated Use onDAGConfirm for guarded plans. Kept for backward compat during migration. */
  onPlan: (plan: PlannerOutput) => void;
  onEvent: (event: WorkerEvent) => void;
  onGraphState: (state: GraphState) => void;
  onCommandResult: (result: { command: string; success: boolean; message: string }) => void;
  onSessionStatus?: (status: { model: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; maxContextTokens: number; sessionCostUsd: number }) => void;
  onWorkflowStart?: (workflowId: string, workflowName: string) => void;
  onWorkflowEnd?: (workflowId: string) => void;

  // New DAG lifecycle callbacks
  onDAGDispatched?: (dispatch: DAGDispatchInfo) => void;
  onDAGProgress?: (progress: DAGProgressInfo) => void;
  onDAGComplete?: (result: DAGCompleteInfo) => void;
  onDAGConfirm?: (confirm: DAGConfirmInfo) => void;
  /** Emitted when a direct (non-DAG) conversation turn completes with per-run stats. */
  onDirectComplete?: (info: DirectCompleteInfo) => void;

  /** Hindsight I/O activity state change (connected/busy). */
  onHindsightActivity?: (status: { connected: boolean; busy: boolean }) => void;

  /** Granular memory operation event for live activity feed. */
  onMemoryEvent?: (event: MemoryEvent) => void;
}

export interface MemoryEvent {
  id: string;
  timestamp: string;
  op: 'retain' | 'recall' | 'dedup' | 'quality' | 'bootstrap' | 'flush' | 'session_anchor' | 'summary' | 'self_knowledge';
  detail: string;
  bank?: string;
  meta?: Record<string, unknown>;
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
  private initPromise: Promise<void> | null = null;

  private context: ContextAssembler;
  private cachedSystemPrompt: string | null = null;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private cumulativeCacheCreationTokens = 0;
  private cumulativeCacheReadTokens = 0;
  private sessionCostUsd = 0;
  private availableSkills: string[] = [];
  private interruptedWorkflows: WorkflowCheckpoint[] = [];
  private activeAbort: AbortController | null = null;
  private foregroundRunId: string | null = null;
  private foregroundUserMessage: string = '';
  private isActiveConversation: boolean = false;
  private readonly backgroundConversations = new Map<string, {
    id: string;
    abortController: AbortController;
    startedAt: number;
    userMessage: string;
  }>();
  private commandFileLoader: CommandFileLoader | null = null;

  constructor(config: MainAgentConfig, callbacks: MainAgentCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.anthropic = new AnthropicClient(config.apiKey);

    // Create the memory bridge
    this.memory = new MemoryBridge(
      { hindsight: config.hindsight, model: config.model, cheapModel: config.cheapModel },
      this.anthropic,
      new EventBus(),
    );

    // Context assembler — replaces raw history array with hot window + Hindsight recall
    // Note: memory.client may be null until init() runs; we pass null initially
    // and the assembler handles it gracefully
    const hsClient = this.memory.client;
    // Derive config directory for session persistence
    const configPath = process.env.CONFIG_PATH || '';
    const configDir = configPath
      ? configPath.replace(/\/[^/]+$/, '')  // parent of config.yaml
      : `${process.env.HOME || '/root'}/.orionomega`;

    this.context = new ContextAssembler(hsClient, {
      hotWindowSize: 20,
      recallBudgetTokens: 30_000,
      maxTurnTokens: 60_000,
      conversationBank: config.hindsight?.url
        ? `conversation-${Date.now().toString(36)}`
        : undefined,
      additionalBanks: config.hindsight?.url
        ? ['core']
        : [],
      persistPath: `${configDir}/sessions/hot-window.json`,
    });

    // We'll initialise orchestration in init() after skills are discovered
    this.orchestration = null!; // set in init()
    this.initPromise = null;

    log.info('MainAgent initialised', { model: config.model });
  }

  /**
   * Initialise memory, skills, and orchestration.
   * Must be called before handling messages.
   */
  async init(): Promise<void> {
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
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

    // 1b. Attach Hindsight client to context assembler (now that memory is initialised)
    if (this.memory.client) {
      this.context.setHindsightClient(this.memory.client);

      // Wire hindsight I/O activity tracking to gateway callback
      if (this.callbacks.onHindsightActivity) {
        this.memory.client.onActivity = this.callbacks.onHindsightActivity;
      }

      if (this.callbacks.onMemoryEvent) {
        this.memory.onMemoryEvent = (op, detail, bank, meta) => {
          this.emitMemoryEvent(op, detail, bank, meta);
        };
        this.context.onMemoryEvent = (op, detail, bank, meta) => {
          this.emitMemoryEvent(op as MemoryEvent['op'], detail, bank, meta);
        };
      }

      // Ensure the conversation bank exists in Hindsight
      let convBank = this.context['conversationBank'] as string | null;
      if (!convBank) {
        convBank = `conversation-${Date.now().toString(36)}`;
        this.context.setConversationBank(convBank);
      }
      try {
        await this.memory.client.createBank(convBank, {
          name: `Conversation session ${new Date().toISOString().slice(0, 19)}`,
        });
        log.info('Conversation bank created in Hindsight', { bank: convBank });
      } catch (err) {
        log.warn('Failed to create conversation bank (may already exist)', {
          bank: convBank,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

    // 2b. Initialise file-based command loader
    if (this.config.commandsDir) {
      try {
        this.commandFileLoader = new CommandFileLoader(this.config.commandsDir);
        const names = this.commandFileLoader.listNames();
        if (names.length > 0) {
          const builtins = [
            'help', 'exit', 'quit', 'q', 'restart', 'update', 'skills',
            'gates', 'reset', 'stop', 'workflows', 'status', 'pause',
            'resume', 'plan', 'workers', 'focus', 'hindsight',
          ];
          for (const n of names) {
            if (builtins.includes(n)) {
              log.warn(`File command "/${n}" conflicts with built-in command — built-in takes priority`);
            }
          }
        }
      } catch (err) {
        log.warn('File command loader init failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Create orchestration bridge (needs skills list and memory bridge)
    const wrappedCallbacks: MainAgentCallbacks = {
      ...this.callbacks,
      onDAGComplete: (result) => {
        if (result.status !== 'stopped') {
          this.sessionCostUsd += result.totalCostUsd;
          this.emitSessionStatus();
        }
        this.callbacks.onDAGComplete?.(result);
      },
    };
    (this as unknown as { orchestration: OrchestrationBridge }).orchestration = new OrchestrationBridge(
      {
        workspaceDir: this.config.workspaceDir,
        checkpointDir: this.config.checkpointDir,
        workerTimeout: this.config.workerTimeout,
        maxRetries: this.config.maxRetries,
        codingRepoDir: this.config.codingRepoDir,
      },
      wrappedCallbacks,
      this.memory,
      this.availableSkills,
      this.config.model,
    );

    // 4. Check for interrupted workflows and auto-resume them (or list for manual resume)
    const interrupted = this.orchestration.checkForInterruptedWorkflows();
    if (interrupted.length > 0) {
      const autoResume = this.config.autoResume === true;
      const list = interrupted
        .map((c, i) =>
          `  ${i + 1}. ${c.task} (layer ${c.currentLayer}/${c.graph.layers.length}, ${Object.values(c.nodeOutputs).length} nodes done)`,
        )
        .join('\n');

      if (autoResume) {
        this.interruptedWorkflows = [];
        this.callbacks.onText(
          `🔄 Auto-resuming ${interrupted.length} interrupted workflow(s):\n${list}`,
          false, true,
        );

        for (const checkpoint of interrupted) {
          void this.orchestration.resumeFromCheckpoint(
            checkpoint,
            (e) => this.pushHistory(e as HistoryEntry),
          ).then(() => {
            this.callbacks.onText(
              `Auto-resume complete: ${checkpoint.task}`,
              false, true,
            );
          }).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.callbacks.onText(
              `Auto-resume failed for '${checkpoint.task}': ${msg}`,
              false, true,
            );
          });
        }
      } else {
        this.interruptedWorkflows = interrupted;
        this.callbacks.onText(
          `⏸️ ${interrupted.length} interrupted workflow(s) found (auto-resume is off):\n${list}\nUse the Resume button on each workflow to continue manually.`,
          false, true,
        );
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Handle an incoming user message.
   *
   * 2-tier routing: CHAT → direct response, ORCHESTRATE → planner DAG.
   * Fast-path check for ORCHESTRATE dispatches to full planner DAG.
   * All tool-using tasks route through orchestration.
   */
  async handleMessage(
    content: string,
    replyContext?: { messageId: string; content: string; role: string; dagId?: string; workflowId?: string },
    attachments?: { name: string; size: number; type: string; data?: string; textContent?: string }[],
    agentMode?: 'orchestrate' | 'direct' | 'code',
  ): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }

    if (!content?.trim() && (!attachments || attachments.length === 0)) {
      this.callbacks.onText('I didn\'t catch that. Could you say that again?', false, true);
      return;
    }

    const trimmed = (content || '').trim();
    log.verbose('Handling message', {
      contentLength: trimmed.length,
      contentPreview: trimmed.slice(0, 200),
      historyLength: this.context.getHistory().length,
      hasReplyContext: !!replyContext,
      replyToDagId: replyContext?.dagId,
      replyToWorkflowId: replyContext?.workflowId,
      attachmentCount: attachments?.length ?? 0,
      agentMode: agentMode ?? 'orchestrate',
    });

    const replyDagId = replyContext?.dagId || replyContext?.workflowId;
    let userContent = replyContext
      ? `[Replying to ${replyContext.role} message${replyDagId ? ` (workflow: ${replyDagId})` : ''}: "${replyContext.content.slice(0, 200)}"]\n\n${trimmed}`
      : trimmed;

    if (attachments && attachments.length > 0) {
      const attachmentDescriptions = attachments.map((att) => {
        if (att.textContent) {
          return `\n\n--- Attached file: ${att.name} (${att.type}, ${att.size} bytes) ---\n${att.textContent}\n--- End of ${att.name} ---`;
        }
        if (att.data && att.type.startsWith('image/')) {
          return `\n\n[Attached image: ${att.name} (${att.type}, ${att.size} bytes) — image data provided as base64]`;
        }
        return `\n\n[Attached file: ${att.name} (${att.type}, ${att.size} bytes)]`;
      });
      userContent += attachmentDescriptions.join('');
    }

    this.pushHistory({ role: 'user', content: userContent });

    if (trimmed.startsWith('/')) {
      log.verbose('Route: slash command (pre-detach)', { command: trimmed.slice(0, 80) });
      await this.handleCommand(trimmed);
      return;
    }

    if (this.foregroundRunId && this.activeAbort && !this.activeAbort.signal.aborted && this.isActiveConversation) {
      const detachedId = this.foregroundRunId;

      this.callbacks.onText('', true, true);

      this.backgroundConversations.set(detachedId, {
        id: detachedId,
        abortController: this.activeAbort,
        startedAt: Date.now(),
        userMessage: this.foregroundUserMessage,
      });
      log.info('Detached foreground conversation to background', { runId: detachedId });
      this.callbacks.onText(`[Background: previous conversation continues as ${detachedId.slice(0, 12)}]`, false, true);
    }

    const runId = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.foregroundRunId = runId;
    this.foregroundUserMessage = userContent;
    this.activeAbort = new AbortController();
    const signal = this.activeAbort.signal;

    if (this.memory.retention) {
      this.memory.retention.evaluateUserMessage(trimmed, this.memory.projectBank ?? undefined).catch((err) => {
        log.debug('User message evaluation failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    try {
      if (this.orchestration.hasPendingGates && /^(allow|approve|yes|y|deny|reject|no|n)$/i.test(trimmed)) {
        const gates = this.orchestration.listPendingGates();
        if (gates.length > 0) {
          const approved = /^(allow|approve|yes|y)$/i.test(trimmed);
          this.orchestration.resolveGate(gates[0].gateId, approved);
          return;
        }
      }

      if (this.orchestration.hasPendingConfirmations) {
        const confirmed = /^(allow|approve|yes|y|go|do\s*it|lgtm)$/i.test(trimmed);
        const rejected = /^(deny|reject|no|n|cancel|stop)$/i.test(trimmed);
        if (confirmed || rejected) {
          this.orchestration.resolveConfirmation(confirmed);
          return;
        }
      }

      if (this.orchestration.hasPendingPlans && this.orchestration.latestPendingPlanId && isImmediateExecution(trimmed)) {
        log.verbose('Route: approve pending plan (legacy)', { planId: this.orchestration.latestPendingPlanId });
        await this.orchestration.handlePlanResponse(
          this.orchestration.latestPendingPlanId, 'approve',
          (e) => this.pushHistory(e as HistoryEntry),
        );
        return;
      }

      if (this.interruptedWorkflows.length > 0) {
        const lower = trimmed.toLowerCase().trim();
        if (/^resume( all)?$/.test(lower)) {
          const toResume = this.interruptedWorkflows.splice(0);
          for (const checkpoint of toResume) {
            void this.orchestration.resumeFromCheckpoint(
              checkpoint,
              (e) => this.pushHistory(e as HistoryEntry),
            );
          }
          return;
        }
        if (/^discard$/.test(lower)) {
          for (const checkpoint of this.interruptedWorkflows) {
            this.orchestration.discardInterruptedWorkflow(checkpoint.workflowId);
          }
          this.interruptedWorkflows = [];
          this.callbacks.onText('Interrupted workflows discarded.', false, true);
          return;
        }
      }

      if (replyDagId && this.orchestration.isWorkflowActive(replyDagId)) {
        log.verbose('Route: reply scoped to active workflow', { dagId: replyDagId });
        await this.respondConversationally(userContent, signal, runId);
        return;
      }

      // 2. Direct mode — bypass all DAG dispatch and respond conversationally regardless of content
      if (agentMode === 'direct') {
        log.verbose('Route: CHAT (direct mode — DAG bypassed)');
        this.emitStep('route', 'Routing request', 'done', 'Direct mode');
        this.callbacks.onThinking('Thinking…', true, false);
        await this.respondConversationally(userContent, signal, runId);
        return;
      }

      // 2b. Coding mode — trigger the coding DAG workflow
      if (agentMode === 'code') {
        log.verbose('Route: CODE (coding mode — DAG workflow)');
        this.emitStep('route', 'Routing request', 'done', 'Coding mode');
        await this.orchestration.dispatchCodingWorkflow(
          userContent,
          (e) => this.pushHistory(e as HistoryEntry),
        );
        return;
      }

      // 3. Skill-match shortcut — route through orchestration so skill MCP tools are available
      if (this.matchesAvailableSkill(trimmed)) {
        log.verbose('Route: ORCHESTRATE (skill match)', { guarded: isGuardedRequest(trimmed) });
        await this.orchestration.dispatchFullDAG(
          userContent,
          (e) => this.pushHistory(e as HistoryEntry),
          { requireConfirmation: isGuardedRequest(trimmed) },
        );
        return;
      }

      // 4. CHAT fast-path
      if (isFastConversational(trimmed)) {
        log.verbose('Route: CHAT fast-path');
        this.emitStep('route', 'Routing request', 'done', 'Chat fast-path');
        this.callbacks.onThinking('Thinking…', true, false);
        await this.respondConversationally(userContent, signal, runId);
        return;
      }

      // 5. ORCHESTRATE fast-path — full planner DAG
      if (isOrchestrateRequest(trimmed)) {
        log.verbose('Route: ORCHESTRATE fast-path', { guarded: isGuardedRequest(trimmed) });
        this.emitStep('route', 'Routing request', 'done', 'Orchestration fast-path');
        const guarded = isGuardedRequest(trimmed);
        await this.orchestration.dispatchFullDAG(
          userContent,
          (e) => this.pushHistory(e as HistoryEntry),
          { requireConfirmation: guarded },
        );
        return; // Returns immediately — DAG runs async
      }

      // 6. Ambiguous — LLM 2-tier classifier
      log.verbose('Route: LLM intent classification');
      this.emitStep('classify', 'Classifying intent', 'active');
      this.callbacks.onThinking('Classifying intent…', true, false);
      const intent = await classifyIntent(this.anthropic, this.config.model, trimmed, this.config.cheapModel);
      this.emitStep('classify', 'Classifying intent', 'done', `Intent: ${intent}`);
      log.verbose(`Intent classified: ${intent}`);

      switch (intent) {
        case 'CHAT':
          await this.respondConversationally(userContent, signal, runId);
          break;
        case 'ORCHESTRATE':
        default:
          log.verbose('Route: ORCHESTRATE (LLM classified)', { guarded: isGuardedRequest(trimmed) });
          await this.orchestration.dispatchFullDAG(
            userContent,
            (e) => this.pushHistory(e as HistoryEntry),
            { requireConfirmation: isGuardedRequest(trimmed) },
          );
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleMessage error', { error: msg });
      this.callbacks.onText(`Something went wrong: ${msg}`, false, true);
    } finally {
      if (this.foregroundRunId === runId) {
        this.foregroundRunId = null;
      }
      if (this.activeAbort?.signal === signal) {
        this.activeAbort = null;
      }
    }
  }

  /**
   * Handle a DAG confirmation response (approve/reject for guarded operations).
   * Called from the gateway when a client sends a dag_response message.
   */
  async handleDAGResponse(workflowId: string, action: 'approve' | 'reject'): Promise<void> {
    try {
      if (action === 'approve') {
        this.orchestration.resolveConfirmation(true, workflowId);
      } else {
        this.orchestration.resolveConfirmation(false, workflowId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleDAGResponse error', { error: msg });
      this.callbacks.onText(`Error handling DAG response: ${msg}`, false, true);
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

  /** Handle a slash command, optionally targeting a specific workflow. */
  async handleCommand(command: string, workflowId?: string): Promise<void> {
    // Ensure init() has completed
    if (this.initPromise) await this.initPromise;

    try {
      // Normalize: commands may arrive with or without the leading slash
      const raw = command.trim().toLowerCase();
      const spaceIdx = raw.indexOf(' ');
      const cmdWord = spaceIdx > 0 ? raw.slice(0, spaceIdx) : raw;
      const args = spaceIdx > 0 ? raw.slice(spaceIdx + 1) : '';
      const cmd = cmdWord.startsWith('/') ? cmdWord : `/${cmdWord}`;

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
            '  /workflows — List all active workflows',
            '  /status    — Session and system status',
            '  /stop      — Stop the active conversation or workflow',
            '  /stop all  — Stop all conversations and workflows',
            '  /stop <id> — Stop a specific background conversation',
            '  /pause     — Pause before next layer',
            '  /resume    — Resume a paused workflow',
            '  /plan      — Show the current execution plan',
            '  /workers   — List active workers',
            '  /gates     — List pending human approval gates',
            '  /skills    — View, enable/disable, configure skills',
            '  /reset     — Clear history and detach workflow',
            '  /restart   — Restart the gateway service',
            '  /update    — Pull latest, rebuild, and restart',
            '  /help      — This message',
            '',
            'TUI-only:',
            '  /focus     — Focus a workflow by ID',
            '  /hindsight — Memory system status',
            '  /exit      — Exit the TUI (/quit, /q)',
            ...this.getFileCommandHelpLines(),
          ].join('\n'),
        });
        return;
      }

      if (cmd === '/restart') {
        this.callbacks.onCommandResult({
          command: '/restart', success: true,
          message: 'Restarting gateway...',
        });
        setTimeout(() => {
          const args = [...process.execArgv, ...process.argv.slice(1)];
          const child = spawn(process.execPath, args, {
            stdio: 'inherit',
            detached: true,
            env: { ...process.env, ORIONOMEGA_RESTART_DELAY: '1000' },
          });
          child.on('error', (err) => {
            log.error('Failed to spawn restart process', { error: err.message });
          });
          child.unref();
          process.exit(0);
        }, 500);
        return;
      }

      if (cmd === '/update') {
        this.callbacks.onCommandResult({
          command: '/update', success: true,
          message: 'Updating OrionOmega — pulling latest, rebuilding, and restarting…',
        });
        this.runUpdateAndRestart().catch((err) => {
          log.error('Update failed', { error: err instanceof Error ? err.message : String(err) });
        });
        return;
      }

      if (cmd === '/resume' && workflowId && this.interruptedWorkflows.length > 0) {
        const checkpoint = this.interruptedWorkflows.find(
          (c) => c.workflowId === workflowId || c.workflowId.startsWith(workflowId),
        );
        if (checkpoint) {
          this.callbacks.onCommandResult({
            command: '/resume', success: true,
            message: `Resuming interrupted workflow: ${checkpoint.task}`,
          });
          void this.orchestration.resumeFromCheckpoint(
            checkpoint,
            (e) => this.pushHistory(e as HistoryEntry),
          ).then(() => {
            this.interruptedWorkflows = this.interruptedWorkflows.filter((c) => c !== checkpoint);
            this.callbacks.onText(
              `Resume complete: ${checkpoint.task}`,
              false, true,
            );
          }).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.callbacks.onText(
              `Resume failed for '${checkpoint.task}': ${msg}`,
              false, true,
            );
          });
          return;
        }
      }

      if (cmd === "/skills") {
        await this.handleSkillsCommand(args ? `${cmd} ${args}` : cmd);
        return;
      }

      if (cmd === '/gates') {
        const gates = this.orchestration.listPendingGates();
        if (gates.length === 0) {
          this.callbacks.onCommandResult({ command: '/gates', success: true, message: 'No pending gates.' });
        } else {
          const lines = ['Pending gates:', ''];
          for (const g of gates) {
            lines.push(`  [${g.gateId}] ${g.workflowName}: ${g.action} — ${g.description}`);
          }
          lines.push('', 'Reply allow or deny to approve/reject the first gate.');
          this.callbacks.onCommandResult({ command: '/gates', success: true, message: lines.join('\n') });
        }
        return;
      }

      if (cmd === '/reset') {
        this.orchestration.clearPendingPlans();
        this.orchestration.stopAll();
        this.context.clear();
        this.cachedSystemPrompt = null;
        this.cumulativeInputTokens = 0;
        this.cumulativeOutputTokens = 0;
        this.cumulativeCacheCreationTokens = 0;
        this.cumulativeCacheReadTokens = 0;
        this.sessionCostUsd = 0;
        this.callbacks.onCommandResult({
          command: '/reset', success: true,
          message: 'Reset complete. Pending plans cleared, history wiped, executor stopped.',
        });
        this.emitSessionStatus();
        return;
      }

      if (cmd === '/stop') {
        const stopArg = args.trim();
        if (stopArg === 'all') {
          let stoppedCount = 0;
          if (this.activeAbort && !this.activeAbort.signal.aborted) {
            this.activeAbort.abort();
            stoppedCount++;
          }
          for (const [id, bg] of this.backgroundConversations) {
            bg.abortController.abort();
            this.backgroundConversations.delete(id);
            stoppedCount++;
          }
          this.orchestration.stopAll();
          this.callbacks.onCommandResult({
            command: '/stop all', success: true,
            message: stoppedCount > 0 ? `Stopped ${stoppedCount} conversation(s) and all workflows.` : 'Stopped all workflows.',
          });
          return;
        }
        if (workflowId && this.orchestration?.commands) {
          const orchResult = await this.orchestration.commands.handle(`/stop ${workflowId}`);
          this.callbacks.onCommandResult({ command: '/stop', success: orchResult.success, message: orchResult.message });
        } else if (stopArg) {
          const matches = Array.from(this.backgroundConversations.entries())
            .filter(([id]) => id === stopArg || id.startsWith(stopArg));
          if (matches.length === 1) {
            const [id, bg] = matches[0];
            bg.abortController.abort();
            this.backgroundConversations.delete(id);
            this.callbacks.onCommandResult({
              command: '/stop', success: true,
              message: `Stopped background conversation ${id.slice(0, 12)}.`,
            });
          } else if (matches.length > 1) {
            const list = matches.map(([id]) => `  - ${id}`).join('\n');
            this.callbacks.onCommandResult({
              command: '/stop', success: false,
              message: `Ambiguous ID "${stopArg}" matches ${matches.length} conversations:\n${list}`,
            });
          } else if (this.orchestration?.commands) {
            const orchResult = await this.orchestration.commands.handle(`/stop ${stopArg}`);
            this.callbacks.onCommandResult({ command: '/stop', success: orchResult.success, message: orchResult.message });
          } else {
            this.callbacks.onCommandResult({
              command: '/stop', success: false,
              message: `No conversation or workflow matching "${stopArg}".`,
            });
          }
        } else {
          let stopped = false;
          if (this.activeAbort && !this.activeAbort.signal.aborted) {
            this.activeAbort.abort();
            stopped = true;
          }
          if (stopped) {
            this.callbacks.onCommandResult({
              command: '/stop', success: true,
              message: 'Stopped.',
            });
          } else if (this.backgroundConversations.size > 0) {
            const bgList = Array.from(this.backgroundConversations.values())
              .map((bg) => `  - ${bg.id} (running for ${Math.round((Date.now() - bg.startedAt) / 1000)}s)`)
              .join('\n');
            this.callbacks.onCommandResult({
              command: '/stop', success: true,
              message: `No foreground conversation to stop. Background conversations:\n${bgList}\nUse /stop <id> or /stop all.`,
            });
          } else {
            this.callbacks.onCommandResult({
              command: '/stop', success: true,
              message: 'Nothing running to stop.',
            });
          }
        }
        return;
      }

      if (this.commandFileLoader) {
        const fileCmd = this.commandFileLoader.lookup(cmd);
        if (fileCmd) {
          log.info(`Executing file command: /${fileCmd.name}`, { file: fileCmd.filePath });
          this.callbacks.onCommandResult({
            command: cmd, success: true,
            message: `Running custom command /${fileCmd.name}…`,
          });
          await this.handleMessage(fileCmd.content);
          return;
        }
      }

      if (!this.orchestration?.commands) {
        this.callbacks.onCommandResult({
          command: cmd, success: false,
          message: 'Agent not fully initialised. Try again in a moment.',
        });
        return;
      }

      const orchCmd = workflowId ? `${cmd} ${workflowId}` : (args ? `${cmd} ${args}` : cmd);
      const orchResult = await this.orchestration.commands.handle(orchCmd);
      this.callbacks.onCommandResult({ command: cmd, success: orchResult.success, message: orchResult.message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onCommandResult({ command, success: false, message: `Command failed: ${msg}` });
    }
  }

  private getFileCommandHelpLines(): string[] {
    if (!this.commandFileLoader) return [];
    const cmds = this.commandFileLoader.list();
    if (cmds.length === 0) return [];
    const lines = ['', 'Custom commands:'];
    for (const c of cmds) {
      lines.push(`  /${c.name}    — ${c.filePath}`);
    }
    return lines;
  }

  getFileCommands(): Array<{ name: string; description: string }> {
    if (!this.commandFileLoader) return [];
    return this.commandFileLoader.list().map((c) => ({
      name: c.name,
      description: `Custom command (${c.filePath})`,
    }));
  }

  /** Flush memory before compaction. */
  async flushMemory(): Promise<void> {
    await this.memory.flush(this.context.getHistory());
  }

  /** Summarize the session to Hindsight. */
  async summarizeSession(): Promise<void> {
    await this.memory.summarize(this.context.getHistory());
  }

  /** Get the shared event bus. */
  getEventBus(): EventBus {
    return this.orchestration.eventBus;
  }

  private async runUpdateAndRestart(): Promise<void> {
    const { runOrchestatedUpdate } = await import('../commands/update.js');

    const result = await runOrchestatedUpdate({
      onStep: (label) => {
        this.callbacks.onCommandResult({ command: '/update', success: true, message: `⏳ ${label}` });
      },
      onStepDone: (label, detail) => {
        const msg = detail ? `✓ ${label} — ${detail}` : `✓ ${label}`;
        log.info(`Update step complete: ${label}`, { detail });
        this.callbacks.onCommandResult({ command: '/update', success: true, message: msg });
      },
      onStepFailed: (label, error) => {
        log.error(`Update step failed: ${label}`, { error });
        this.callbacks.onCommandResult({ command: '/update', success: false, message: `✗ ${label}: ${error}` });
      },
      onInfo: (message) => {
        this.callbacks.onCommandResult({ command: '/update', success: true, message });
      },
      onRollback: (message) => {
        log.warn(`Update rollback: ${message}`);
        this.callbacks.onCommandResult({ command: '/update', success: false, message: `⟳ ${message}` });
      },
    });

    if (!result.success) {
      const suffix = result.rolledBack ? ' (rolled back to previous version)' : '';
      this.callbacks.onCommandResult({
        command: '/update', success: false,
        message: `Update failed: ${result.error}${suffix} [${(result.durationMs / 1000).toFixed(1)}s]`,
      });
      return;
    }

    if (result.alreadyUpToDate) {
      // No code changes — don't restart the gateway
      return;
    }

    const shortOld = result.oldCommit ? result.oldCommit.slice(0, 7) : '?';
    const shortNew = result.newCommit || '?';
    this.callbacks.onCommandResult({
      command: '/update', success: true,
      message: `Update complete: ${shortOld} → ${shortNew} [${(result.durationMs / 1000).toFixed(1)}s] — restarting gateway…`,
    });

    // Restart gateway: spawn a replacement process and exit.
    // The supervisor (systemd) or the spawn itself will keep the service alive.
    setTimeout(() => {
      const args = [...process.execArgv, ...process.argv.slice(1)];
      const child = spawn(process.execPath, args, {
        stdio: 'inherit',
        detached: true,
        env: { ...process.env, ORIONOMEGA_RESTART_DELAY: '1000' },
      });
      child.on('error', (err) => {
        log.error('Failed to spawn restart process', { error: err.message });
      });
      child.unref();
      process.exit(0);
    }, 500);
  }

  /**
   * Handle /skills command — list, enable, disable, setup.
   * Subcommands: /skills, /skills enable <name>, /skills disable <name>, /skills setup <name>
   */
  private async handleSkillsCommand(cmd: string): Promise<void> {
    const parts = cmd.trim().split(/\s+/);
    const sub = parts[1];
    const name = parts[2];

    if (!sub || sub === "list") {
      // List all skills with status
      if (!this.config.skillsDir) {
        this.callbacks.onCommandResult({ command: "/skills", success: true, message: "No skills directory configured." });
        return;
      }
      try {
        const loader = new SkillLoader(this.config.skillsDir);
        const manifests = await loader.discoverAll();
        if (manifests.length === 0) {
          this.callbacks.onCommandResult({ command: "/skills", success: true, message: "No skills installed." });
          return;
        }
        const lines = ["Installed Skills:", ""];
        for (const m of manifests) {
          const cfg = readSkillConfig(this.config.skillsDir, m.name);
          let status = "✅ ready";
          if (!cfg.enabled) status = "❌ disabled";
          else if (m.setup?.required && !cfg.configured) status = "⚠️ needs setup";
          lines.push(
            "  " + m.name.padEnd(18) + status.padEnd(18) + (m.description ?? "")
          );
        }
        lines.push("", "Commands: /skills enable|disable|setup <name>");
        this.callbacks.onCommandResult({ command: "/skills", success: true, message: lines.join("\n") });
      } catch (err) {
        this.callbacks.onCommandResult({ command: "/skills", success: false, message: "Failed to list skills: " + (err instanceof Error ? err.message : String(err)) });
      }
      return;
    }

    if ((sub === "enable" || sub === "disable") && name) {
      const cfg = readSkillConfig(this.config.skillsDir!, name);
      cfg.enabled = sub === "enable";
      writeSkillConfig(this.config.skillsDir!, cfg);
      this.callbacks.onCommandResult({
        command: "/skills",
        success: true,
        message: "Skill \"" + name + "\" " + (sub === "enable" ? "enabled" : "disabled") + ".",
      });
      return;
    }

    if (sub === "setup" && name) {
      this.callbacks.onCommandResult({
        command: "/skills",
        success: true,
        message: "Run skill setup from the CLI: orionomega skill setup " + name,
      });
      return;
    }

    this.callbacks.onCommandResult({
      command: "/skills",
      success: false,
      message: "Usage: /skills [list|enable|disable|setup] [name]",
    });
  }

  // ── Private ────────────────────────────────────────────────────────────

  private matchesAvailableSkill(message: string): boolean {
    if (!this.availableSkills.length) return false;
    const lower = message.toLowerCase();
    return this.availableSkills.some((skill) => {
      const name = skill.split(':')[0].trim().toLowerCase();
      return name && lower.includes(name);
    });
  }

  private _stepTimers = new Map<string, number>();

  emitMemoryEvent(op: MemoryEvent['op'], detail: string, bank?: string, meta?: Record<string, unknown>): void {
    this.callbacks.onMemoryEvent?.({
      id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      op,
      detail,
      bank,
      meta,
    });
  }

  private emitStep(id: string, name: string, status: ThinkingStepStatus, detail?: string): void {
    const now = Date.now();
    if (status === 'active') {
      this._stepTimers.set(id, now);
    }
    const startedAt = this._stepTimers.get(id);
    const step: ThinkingStep = {
      id,
      name,
      status,
      startedAt,
      ...(status === 'done' ? { completedAt: now, elapsedMs: startedAt ? now - startedAt : undefined } : {}),
      ...(detail ? { detail } : {}),
    };
    if (status === 'done') {
      this._stepTimers.delete(id);
    }
    this.callbacks.onThinkingStep?.(step);
  }

  private async respondConversationally(userMessage: string, abortSignal?: AbortSignal, runId?: string): Promise<void> {
    const effectiveRunId = runId || `conv-${Date.now().toString(36)}`;
    let wasDetached = this.backgroundConversations.has(effectiveRunId);
    if (!wasDetached) {
      this.isActiveConversation = true;
    }

    const checkDetached = () => {
      if (!wasDetached && this.backgroundConversations.has(effectiveRunId)) {
        wasDetached = true;
      }
      return wasDetached;
    };

    const wrappedOnText = (text: string, streaming: boolean, done: boolean) => {
      checkDetached();
      this.callbacks.onText(text, streaming, done, wasDetached ? effectiveRunId : undefined);
    };

    const wrappedOnThinking = (text: string, streaming: boolean, done: boolean) => {
      checkDetached();
      this.callbacks.onThinking(text, streaming, done, wasDetached ? effectiveRunId : undefined);
    };

    const wrappedOnThinkingStep = this.callbacks.onThinkingStep
      ? (step: ThinkingStep) => {
          checkDetached();
          this.callbacks.onThinkingStep!(step, wasDetached ? effectiveRunId : undefined);
        }
      : undefined;

    if (!wasDetached) {
      this.emitStep('context', 'Assembling context', 'active');
    }
    wrappedOnThinking('Assembling context…', true, false);

    const [systemPrompt, assembled] = await Promise.all([
      this.getSystemPrompt(),
      this.context.assemble(userMessage),
    ]);

    const msgCount = assembled.hotMessages.length + (assembled.priorContext ? 2 : 0);
    if (!checkDetached()) {
      this.emitStep('context', 'Assembling context', 'done', `${msgCount} messages assembled`);
    }

    const messages: AnthropicMessage[] = [];
    if (assembled.priorContext) {
      messages.push({ role: 'user', content: `[PRIOR CONTEXT]\n${assembled.priorContext}` });
      messages.push({ role: 'assistant', content: 'Understood. I have the prior context.' });
    }
    messages.push(
      ...assembled.hotMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    );

    if (!checkDetached()) {
      this.emitStep('llm', 'Generating response', 'active', `Model: ${this.config.model}`);
    }
    wrappedOnThinking('Generating response…', true, false);

    try {
      const turnStartTime = Date.now();
      const result = await streamConversation({
        client: this.anthropic,
        model: this.config.model,
        systemPrompt,
        messages,
        workspaceDir: this.config.workspaceDir,
        onText: wrappedOnText,
        onThinking: wrappedOnThinking,
        onThinkingStep: wrappedOnThinkingStep ? (step) => wrappedOnThinkingStep(step as ThinkingStep) : undefined,
        maxInputTokens: 100_000,
        abortSignal,
      });
      if (!checkDetached()) {
        this.emitStep('llm', 'Generating response', 'done');
      }
      this.cumulativeInputTokens += result.inputTokens;
      this.cumulativeOutputTokens += result.outputTokens;
      this.cumulativeCacheCreationTokens += result.cacheCreationTokens;
      this.cumulativeCacheReadTokens += result.cacheReadTokens;
      this.sessionCostUsd += this.estimateConversationalCost(
        result.inputTokens, result.outputTokens,
        result.cacheCreationTokens, result.cacheReadTokens,
      );
      if (!wasDetached) {
        this.pushHistory({ role: "assistant", content: result.text });
      } else {
        log.info('Background conversation completed, appending to history', { runId: effectiveRunId, textLength: result.text.length });
        this.pushHistory({ role: "assistant", content: `[Background ${effectiveRunId.slice(0, 12)}]: ${result.text}` });
      }
      this.emitSessionStatus();

      // Emit per-run stats for direct mode (mirrors DAGCompleteInfo for orchestration runs)
      const turnDurationSec = (Date.now() - turnStartTime) / 1000;
      const turnCost = this.estimateConversationalCost(
        result.inputTokens, result.outputTokens,
        result.cacheCreationTokens, result.cacheReadTokens,
      );
      const shortModel = this.config.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      this.callbacks.onDirectComplete?.({
        runId: `direct-${effectiveRunId}`,
        model: this.config.model,
        durationSec: Math.round(turnDurationSec * 10) / 10,
        modelUsage: [{
          model: shortModel,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          workerCount: 1,
          costUsd: turnCost,
        }],
        totalCostUsd: turnCost,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Conversational response error', { error: msg, runId: effectiveRunId, isBackground: wasDetached });
      const fallback = 'I seem to be having trouble reaching my language centre. Give me a moment.';
      wrappedOnText(fallback, false, true);
      if (!wasDetached) {
        this.pushHistory({ role: 'assistant', content: fallback });
      }
    } finally {
      if (runId) {
        this.backgroundConversations.delete(runId);
      }
      if (this.foregroundRunId === effectiveRunId) {
        this.isActiveConversation = false;
      }
    }
  }

  /** Emit session status to the TUI/gateway. */
  private emitSessionStatus(): void {
    this.callbacks.onSessionStatus?.({
      model: this.config.model,
      inputTokens: this.cumulativeInputTokens,
      outputTokens: this.cumulativeOutputTokens,
      cacheCreationTokens: this.cumulativeCacheCreationTokens,
      cacheReadTokens: this.cumulativeCacheReadTokens,
      maxContextTokens: 200000,
      sessionCostUsd: this.sessionCostUsd,
    });
  }

  private estimateConversationalCost(
    inputTokens: number, outputTokens: number,
    cacheCreationTokens: number, cacheReadTokens: number,
  ): number {
    const model = this.config.model.toLowerCase();
    let inputPricePerM: number;
    let outputPricePerM: number;
    let cacheReadPricePerM: number;
    let cacheWritePricePerM: number;

    if (model.includes('opus')) {
      inputPricePerM = 15; outputPricePerM = 75;
      cacheReadPricePerM = 1.5; cacheWritePricePerM = 18.75;
    } else if (model.includes('haiku')) {
      inputPricePerM = 0.8; outputPricePerM = 4;
      cacheReadPricePerM = 0.08; cacheWritePricePerM = 1;
    } else {
      inputPricePerM = 3; outputPricePerM = 15;
      cacheReadPricePerM = 0.3; cacheWritePricePerM = 3.75;
    }

    const uncachedInput = Math.max(0, inputTokens - cacheReadTokens);
    return (
      (uncachedInput / 1_000_000) * inputPricePerM +
      (outputTokens / 1_000_000) * outputPricePerM +
      (cacheReadTokens / 1_000_000) * cacheReadPricePerM +
      (cacheCreationTokens / 1_000_000) * cacheWritePricePerM
    );
  }

  private async getSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt) return this.cachedSystemPrompt;
    if (this.config.systemPrompt) {
      this.cachedSystemPrompt = this.config.systemPrompt;
      return this.cachedSystemPrompt;
    }
    const context: PromptContext = {
      workspaceDir: this.config.workspaceDir,
      activeWorkflow: this.orchestration.hasActiveWorkflow,
    };
    this.cachedSystemPrompt = await buildSystemPrompt(context);
    return this.cachedSystemPrompt;
  }

  /** Build messages from hot window only (sync, for non-conversational paths). */
  private buildAnthropicMessages(): AnthropicMessage[] {
    return this.context.getHistory().map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
  }

  private pushHistory(entry: HistoryEntry): void {
    // Fire-and-forget: push to context assembler (retains to Hindsight + hot window)
    this.context.push({
      role: entry.role as 'user' | 'assistant' | 'system',
      content: entry.content,
    }).catch((err) => {
      log.debug('Context push failed (fire-and-forget)', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}
