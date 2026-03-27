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

import { execSync, spawn } from 'node:child_process';
import { AnthropicClient } from '../anthropic/client.js';
import type { AnthropicMessage } from '../anthropic/client.js';
import { buildSystemPrompt, type PromptContext } from './prompt-builder.js';
import { createLogger } from '../logging/logger.js';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { OrionOmegaConfig } from '../config/types.js';

import type {
  PlannerOutput, WorkerEvent, GraphState, WorkflowCheckpoint,
  DAGDispatchInfo, DAGProgressInfo, DAGCompleteInfo, DAGConfirmInfo,
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
  hindsight?: OrionOmegaConfig['hindsight'];
}

// ── Callbacks ──────────────────────────────────────────────────────────────

/** Callbacks through which the agent communicates outward (typically to the gateway). */
export interface MainAgentCallbacks {
  onText: (text: string, streaming: boolean, done: boolean, workflowId?: string) => void;
  onThinking: (text: string, streaming: boolean, done: boolean) => void;
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

  /** Hindsight I/O activity state change (connected/busy). */
  onHindsightActivity?: (status: { connected: boolean; busy: boolean }) => void;
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
      hotWindowSize: 6,
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
      },
      wrappedCallbacks,
      this.memory,
      this.availableSkills,
      this.config.model,
    );

    // 4. Check for interrupted workflows from previous sessions
    const interrupted = this.orchestration.checkForInterruptedWorkflows();
    if (interrupted.length > 0) {
      this.interruptedWorkflows = interrupted;
      const list = interrupted
        .map((c, i) =>
          `  ${i + 1}. ${c.task} (layer ${c.currentLayer}/${c.graph.layers.length}, ${Object.values(c.nodeOutputs).length} nodes done)`,
        )
        .join('\n');
      this.callbacks.onText(
        `🔄 Found ${interrupted.length} interrupted workflow(s):\n${list}\n\nSay resume or resume all to continue, or discard to clear.`,
        false, true,
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Handle an incoming user message.
   *
   * 2-tier routing: CHAT → direct response (blocking), CHAT_ASYNC → fire-and-forget.
   * Fast-path check for ORCHESTRATE still dispatches to full planner DAG.
   * handleMessage() returns quickly in all cases.
   */
  async handleMessage(content: string): Promise<void> {
    // Ensure init() has completed before processing any message
    if (this.initPromise) {
      await this.initPromise;
    }

    if (!content?.trim()) {
      this.callbacks.onText('I didn\'t catch that. Could you say that again?', false, true);
      return;
    }

    const trimmed = content.trim();
    log.verbose('Handling message', {
      contentLength: trimmed.length,
      contentPreview: trimmed.slice(0, 200),
      historyLength: this.context.getHistory().length,
    });
    this.pushHistory({ role: 'user', content: trimmed });

    this.activeAbort?.abort();
    this.activeAbort = new AbortController();
    const signal = this.activeAbort.signal;
    let asyncFired = false;

    // Evaluate for preference patterns (fire-and-forget)
    if (this.memory.retention) {
      this.memory.retention.evaluateUserMessage(trimmed, this.memory.projectBank ?? undefined).catch((err) => {
        log.debug('User message evaluation failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    try {
      // 0a. Human gate / DAG confirmation resolution
      if (this.orchestration.hasPendingGates && /^(allow|approve|yes|y|deny|reject|no|n)$/i.test(trimmed)) {
        const gates = this.orchestration.listPendingGates();
        if (gates.length > 0) {
          const approved = /^(allow|approve|yes|y)$/i.test(trimmed);
          this.orchestration.resolveGate(gates[0].gateId, approved);
          return;
        }
      }

      // 0a'. DAG confirmation resolution (guarded operations)
      if (this.orchestration.hasPendingConfirmations) {
        const confirmed = /^(allow|approve|yes|y|go|do\s*it|lgtm)$/i.test(trimmed);
        const rejected = /^(deny|reject|no|n|cancel|stop)$/i.test(trimmed);
        if (confirmed || rejected) {
          this.orchestration.resolveConfirmation(confirmed);
          return;
        }
      }

      // 0b. Pending plan + "do it" (backward compat for old plan approval flow)
      if (this.orchestration.hasPendingPlans && this.orchestration.latestPendingPlanId && isImmediateExecution(trimmed)) {
        log.verbose('Route: approve pending plan (legacy)', { planId: this.orchestration.latestPendingPlanId });
        await this.orchestration.handlePlanResponse(
          this.orchestration.latestPendingPlanId, 'approve',
          (e) => this.pushHistory(e as HistoryEntry),
        );
        return;
      }

      // 0c. Checkpoint resume / discard
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

      // 1. Slash command
      if (trimmed.startsWith('/')) {
        log.verbose('Route: slash command', { command: trimmed.slice(0, 80) });
        await this.handleCommand(trimmed);
        return;
      }

      // 2. Skill-match shortcut — route through orchestration so skill MCP tools are available
      if (this.matchesAvailableSkill(trimmed)) {
        log.verbose('Route: ORCHESTRATE (skill match)', { guarded: isGuardedRequest(trimmed) });
        await this.orchestration.dispatchFullDAG(
          trimmed,
          (e) => this.pushHistory(e as HistoryEntry),
          { requireConfirmation: isGuardedRequest(trimmed) },
        );
        return;
      }

      // 3. CHAT fast-path
      if (isFastConversational(trimmed)) {
        log.verbose('Route: CHAT fast-path');
        this.callbacks.onThinking('Thinking…', true, false);
        await this.respondConversationally(trimmed, signal);
        return;
      }

      // 4. ORCHESTRATE fast-path — full planner DAG
      if (isOrchestrateRequest(trimmed)) {
        log.verbose('Route: ORCHESTRATE fast-path', { guarded: isGuardedRequest(trimmed) });
        const guarded = isGuardedRequest(trimmed);
        await this.orchestration.dispatchFullDAG(
          trimmed,
          (e) => this.pushHistory(e as HistoryEntry),
          { requireConfirmation: guarded },
        );
        return; // Returns immediately — DAG runs async
      }

      // 5. Ambiguous — LLM 2-tier classifier
      log.verbose('Route: LLM intent classification');
      this.callbacks.onThinking('Classifying intent…', true, false);
      const intent = await classifyIntent(this.anthropic, this.config.model, trimmed, this.config.cheapModel);
      log.verbose(`Intent classified: ${intent}`);

      switch (intent) {
        case 'CHAT':
          await this.respondConversationally(trimmed, signal);
          break;
        case 'ORCHESTRATE':
          log.verbose('Route: ORCHESTRATE (LLM classified)', { guarded: isGuardedRequest(trimmed) });
          await this.orchestration.dispatchFullDAG(
            trimmed,
            (e) => this.pushHistory(e as HistoryEntry),
            { requireConfirmation: isGuardedRequest(trimmed) },
          );
          break;
        case 'CHAT_ASYNC':
          asyncFired = true;
          void this.respondConversationally(trimmed, signal).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error('Async conversational response error', { error: msg });
            this.callbacks.onText(`Something went wrong: ${msg}`, false, true);
          }).finally(() => {
            if (this.activeAbort?.signal === signal) {
              this.activeAbort = null;
            }
          });
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleMessage error', { error: msg });
      this.callbacks.onText(`Something went wrong: ${msg}`, false, true);
    } finally {
      if (!asyncFired && this.activeAbort?.signal === signal) {
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

  /** Handle a slash command. */
  async handleCommand(command: string): Promise<void> {
    // Ensure init() has completed
    if (this.initPromise) await this.initPromise;

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
            '  /workflows — List all active workflows',
            '  /status    — Session and system status',
            '  /stop      — Stop the active workflow',
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

      if (cmd === "/skills" || cmd.startsWith("/skills ")) {
        await this.handleSkillsCommand(cmd);
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
        let stopped = false;
        if (this.activeAbort && !this.activeAbort.signal.aborted) {
          this.activeAbort.abort();
          stopped = true;
        }
        this.orchestration.stopAll();
        this.callbacks.onCommandResult({
          command: '/stop', success: true,
          message: stopped ? 'Stopped.' : 'Nothing running to stop.',
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
    const { findInstallDirectory, runUpdateSteps } = await import('../commands/update.js');
    const installDir = findInstallDirectory();
    if (!installDir) {
      this.callbacks.onCommandResult({ command: '/update', success: false, message: 'Cannot find OrionOmega git repository' });
      return;
    }
    const ok = runUpdateSteps(installDir, {
      onStep: (label) => {
        this.callbacks.onCommandResult({ command: '/update', success: true, message: `${label}…` });
      },
      onStepDone: (label) => {
        log.info(`Update step complete: ${label}`);
      },
      onStepFailed: (label, error) => {
        this.callbacks.onCommandResult({ command: '/update', success: false, message: `${label} failed: ${error}` });
      },
    });
    if (!ok) return;
    this.callbacks.onCommandResult({ command: '/update', success: true, message: 'Update complete — restarting gateway…' });
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

  private async respondConversationally(userMessage: string, abortSignal?: AbortSignal): Promise<void> {
    // Signal that we're assembling context (visible in TUI spinner)
    this.callbacks.onThinking('Assembling context…', true, false);

    // Assemble context: hot window + Hindsight recall (parallel with prompt build)
    const [systemPrompt, assembled] = await Promise.all([
      this.getSystemPrompt(),
      this.context.assemble(userMessage),
    ]);

    // Build messages: prior context (if any) + hot window
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

    // Signal that we're waiting for the LLM
    this.callbacks.onThinking('Generating response…', true, false);

    try {
      const result = await streamConversation({
        client: this.anthropic,
        model: this.config.model,
        systemPrompt,
        messages,
        workspaceDir: this.config.workspaceDir,
        onText: this.callbacks.onText,
        onThinking: this.callbacks.onThinking,
        maxInputTokens: 100_000,
        abortSignal,
      });
      this.cumulativeInputTokens += result.inputTokens;
      this.cumulativeOutputTokens += result.outputTokens;
      this.cumulativeCacheCreationTokens += result.cacheCreationTokens;
      this.cumulativeCacheReadTokens += result.cacheReadTokens;
      this.sessionCostUsd += this.estimateConversationalCost(
        result.inputTokens, result.outputTokens,
        result.cacheCreationTokens, result.cacheReadTokens,
      );
      this.pushHistory({ role: "assistant", content: result.text });
      this.emitSessionStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Conversational response error', { error: msg });
      const fallback = 'I seem to be having trouble reaching my language centre. Give me a moment.';
      this.callbacks.onText(fallback, false, true);
      this.pushHistory({ role: 'assistant', content: fallback });
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
