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

import { execSync } from 'node:child_process';
import { AnthropicClient } from '../anthropic/client.js';
import type { AnthropicMessage } from '../anthropic/client.js';
import { buildSystemPrompt, type PromptContext } from './prompt-builder.js';
import { createLogger } from '../logging/logger.js';
import { SkillLoader, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';
import type { OrionOmegaConfig } from '../config/types.js';

import type { PlannerOutput, WorkerEvent, GraphState, WorkflowCheckpoint } from '../orchestration/types.js';
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
import { ContextAssembler } from '../memory/context-assembler.js';

const log = createLogger('main-agent');

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
  onSessionStatus?: (status: { model: string; inputTokens: number; outputTokens: number; maxContextTokens: number }) => void;
  onWorkflowStart?: (workflowId: string, workflowName: string) => void;
  onWorkflowEnd?: (workflowId: string) => void;
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
  private availableSkills: string[] = [];
  private interruptedWorkflows: WorkflowCheckpoint[] = [];

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
        ? ['jarvis-core']
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
      // Ensure the conversation bank exists
      if (!this.context['conversationBank']) {
        this.context.setConversationBank(`conversation-${Date.now().toString(36)}`);
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
   * Routes to: conversation, immediate execution, plan generation, or command.
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

    // Evaluate for preference patterns (fire-and-forget)
    if (this.memory.retention) {
      this.memory.retention.evaluateUserMessage(trimmed, this.memory.projectBank ?? undefined).catch(() => {});
    }

    try {
      // 0a. Human gate resolution
      if (this.orchestration.hasPendingGates && /^(allow|approve|yes|y|deny|reject|no|n)$/i.test(trimmed)) {
        const gates = this.orchestration.listPendingGates();
        if (gates.length > 0) {
          const approved = /^(allow|approve|yes|y)$/i.test(trimmed);
          this.orchestration.resolveGate(gates[0].gateId, approved);
          return;
        }
      }

      // 0b. Checkpoint resume / discard
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

      // 2. Fast-path conversational
      if (isFastConversational(trimmed)) {
        log.verbose('Route: fast conversational');
        this.callbacks.onThinking('Thinking…', true, false);
        await this.respondConversationally(trimmed);
        return;
      }

      // 3. Pending plan + "do it"
      if (this.orchestration.hasPendingPlans && this.orchestration.latestPendingPlanId && isImmediateExecution(trimmed)) {
        log.verbose('Route: approve pending plan', { planId: this.orchestration.latestPendingPlanId });
        await this.orchestration.handlePlanResponse(
          this.orchestration.latestPendingPlanId, 'approve',
          (e) => this.pushHistory(e as HistoryEntry),
        );
        return;
      }

      // 4. Immediate execution
      if (isImmediateExecution(trimmed)) {
        log.verbose('Route: immediate execution');
        await this.orchestration.planAndExecute(trimmed, (e) => this.pushHistory(e as HistoryEntry));
        return;
      }

      // 5. Fast-path task
      if (isFastTask(trimmed)) {
        log.verbose('Route: fast task (orchestration)');
        await this.orchestration.planOnly(trimmed, (e) => this.pushHistory(e as HistoryEntry));
        return;
      }

      // 6. Ambiguous — LLM classifier
      log.verbose('Route: LLM intent classification');
      this.callbacks.onThinking('Classifying intent…', true, false);
      const intent = await classifyIntent(this.anthropic, this.config.model, trimmed);
      log.verbose(`Intent classified: ${intent}`);
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
            '  /status    — Current workflow status',
            '  /stop      — Stop the active workflow',
            '  /pause     — Pause before next layer',
            '  /resume    — Resume a paused workflow',
            '  /plan      — Show the current plan',
            '  /workers   — List active workers',
            '  /gates     — List pending human approval gates',
            '  /reset     — Clear pending plans and history',
            '  /restart   — Restart the gateway service',
            '  /skills    — View, enable/disable, configure skills',
            '  /help      — This message',
          ].join('\n'),
        });
        return;
      }

      if (cmd === '/restart') {
        this.callbacks.onCommandResult({
          command: '/restart', success: true,
          message: 'Restarting gateway...',
        });
        // Give the response time to flush, then restart
        setTimeout(() => {
          try {
            execSync('sudo systemctl restart orionomega', { stdio: 'ignore' });
          } catch {
            process.exit(0); // fallback: just exit, systemd will restart
          }
        }, 500);
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

  private async respondConversationally(userMessage: string): Promise<void> {
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
      });
      this.cumulativeInputTokens += result.inputTokens;
      this.cumulativeOutputTokens += result.outputTokens;
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
      maxContextTokens: 200000,
    });
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
    }).catch(() => {}); // never block on retain
  }
}
