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
import { existsSync, unlinkSync } from 'node:fs';
import { AnthropicClient } from '../anthropic/client.js';
import type { AnthropicMessage } from '../anthropic/client.js';
import { buildSystemPrompt, buildRunDirBlock, type PromptContext } from './prompt-builder.js';
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
  /**
   * Wall-clock budget (seconds) for CODING_AGENT nodes. Defaults to
   * `workerTimeout` when omitted, but the recommended value is much higher
   * (≥1800s) because Claude Code coding loops are inherently long-running
   * and the executor enforces a 1800s floor anyway.
   */
  codingAgentTimeout?: number;
  maxRetries: number;
  skillsDir?: string;
  commandsDir?: string;
  hindsight?: OrionOmegaConfig['hindsight'];
  autoResume?: boolean;
  /** Path to the source repo for coding mode. */
  codingRepoDir?: string;
  /** Dedicated directory for storing run artifacts. Defaults to ~/.orionomega/runs. */
  runsDir?: string;
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
  onText: (text: string, streaming: boolean, done: boolean, workflowId?: string, sessionId?: string) => void;
  onThinking: (text: string, streaming: boolean, done: boolean, workflowId?: string, sessionId?: string) => void;
  onThinkingStep?: (step: ThinkingStep, workflowId?: string, sessionId?: string) => void;
  /** @deprecated Use onDAGConfirm for guarded plans. Kept for backward compat during migration. */
  onPlan: (plan: PlannerOutput, sessionId?: string) => void;
  onEvent: (event: WorkerEvent, sessionId?: string) => void;
  onGraphState: (state: GraphState, sessionId?: string) => void;
  onCommandResult: (result: { command: string; success: boolean; message: string }, sessionId?: string) => void;
  onSessionStatus?: (status: { model: string; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; maxContextTokens: number; sessionCostUsd: number }, sessionId?: string) => void;
  onWorkflowStart?: (workflowId: string, workflowName: string, sessionId?: string) => void;
  onWorkflowEnd?: (workflowId: string, sessionId?: string) => void;

  // New DAG lifecycle callbacks
  onDAGDispatched?: (dispatch: DAGDispatchInfo, sessionId?: string) => void;
  onDAGProgress?: (progress: DAGProgressInfo, sessionId?: string) => void;
  onDAGComplete?: (result: DAGCompleteInfo, sessionId?: string) => void;
  onDAGConfirm?: (confirm: DAGConfirmInfo, sessionId?: string) => void;
  /** Emitted when a direct (non-DAG) conversation turn starts. Used by the UI to open
   * an inline run summary card and orchestration-pane workflow tab while the turn streams. */
  onDirectStart?: (info: { runId: string; model: string; userMessage: string }, sessionId?: string) => void;
  /** Emitted when a direct (non-DAG) conversation turn completes with per-run stats. */
  onDirectComplete?: (info: DirectCompleteInfo, sessionId?: string) => void;

  /** Hindsight I/O activity state change (connected/busy). */
  onHindsightActivity?: (status: { connected: boolean; busy: boolean }) => void;

  /** Granular memory operation event for live activity feed. */
  onMemoryEvent?: (event: MemoryEvent, sessionId?: string) => void;

  /**
   * Emitted when an Agent SDK tool call is paused awaiting human approval
   * because of a `humanGates` policy match. Renderers should surface a
   * structured approve/deny prompt; the user's answer is routed back via
   * MainAgent.handleGateResponse(gateId, approved).
   */
  onGateRequest?: (request: GateRequestInfo, sessionId?: string) => void;

  /**
   * Emitted when a previously requested human gate has been resolved on
   * the backend — either by an explicit user response (`approved`/`denied`)
   * or because the underlying signal aborted (`expired`). Renderers should
   * use this to clear or finalize any approval prompt UI so stale cards
   * don't sit on screen after the agent has moved on.
   */
  onGateResolved?: (info: GateResolvedInfo, sessionId?: string) => void;
}

/** Payload describing a single human-gate approval prompt. */
export interface GateRequestInfo {
  gateId: string;
  workflowId: string;
  workflowName: string;
  /** Tool name (or action verb) the agent is asking to run. */
  action: string;
  /** Human-readable reason — typically the policy's deny message. */
  description: string;
  timestamp: string;
}

/** Payload describing the resolution of a previously requested human gate. */
export interface GateResolvedInfo {
  gateId: string;
  workflowId: string;
  /** How the gate was resolved. `expired` means the backend aborted/timed out. */
  resolution: 'approved' | 'denied' | 'expired';
  timestamp: string;
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
/** Default session id — must match `DEFAULT_SESSION_ID` in the gateway. */
const DEFAULT_SESSION_ID = 'default';

interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export class MainAgent {
  private readonly config: MainAgentConfig;
  /** User-provided callbacks (raw, no sessionId injection). */
  private readonly userCallbacks: MainAgentCallbacks;
  /** Wrapped callbacks that inject sessionId on every call. Used everywhere internally. */
  private readonly callbacks: MainAgentCallbacks;
  private readonly anthropic: AnthropicClient;

  private readonly memory: MemoryBridge;
  private readonly orchestration: OrchestrationBridge;
  private initPromise: Promise<void> | null = null;

  /**
   * The session whose turn is currently being processed on the foreground
   * agent loop. Set on each handleMessage() / handleCommand() entry. Async
   * DAG events resolve their session via workflowSessions instead.
   */
  private currentSessionId: string = DEFAULT_SESSION_ID;

  /** Map of workflowId → owning sessionId, populated on dispatch and on direct-mode start. */
  private readonly workflowSessions = new Map<string, string>();

  /**
   * Snapshot of Hindsight client health (circuit breaker state, last error,
   * consecutive failures). Surfaced via the gateway's `/api/health` so that
   * operators can see memory-subsystem state without reading logs. Returns
   * `null` when memory is not configured.
   */
  getHindsightStatus() {
    return this.memory.getHindsightStatus();
  }

  /**
   * Snapshot of session-summariser health (success/failure counts, last
   * error, last success/failure timestamps). Surfaced via `/api/health`.
   * Returns `null` when memory is not configured.
   */
  getSummarizerStatus() {
    return this.memory.getSummarizerStatus();
  }

  /** Per-session ContextAssembler — each session gets its own hot window. */
  private readonly contextBySession = new Map<string, ContextAssembler>();
  /** Per-session token / cost totals — replaces process-wide cumulative counters. */
  private readonly totalsBySession = new Map<string, SessionTotals>();
  private cachedSystemPrompt: string | null = null;
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
    this.userCallbacks = callbacks;
    this.callbacks = this.buildWrappedCallbacks(callbacks);
    this.anthropic = new AnthropicClient(config.apiKey);

    // Create the memory bridge
    this.memory = new MemoryBridge(
      { hindsight: config.hindsight, model: config.model, cheapModel: config.cheapModel },
      this.anthropic,
      new EventBus(),
    );

    // Per-session ContextAssemblers are created lazily in getContext(sessionId).
    // The default session's context is created up-front so any pre-init reads
    // (e.g. `context.getHistory()` for logging) succeed without surprise.
    this.getContext(DEFAULT_SESSION_ID);

    // We'll initialise orchestration in init() after skills are discovered
    this.orchestration = null!; // set in init()
    this.initPromise = null;

    log.info('MainAgent initialised', { model: config.model });
  }

  // ── Per-session helpers ────────────────────────────────────────────────

  /**
   * Resolve which sessionId an event belongs to. Async DAG callbacks carry
   * a workflowId; we look it up in workflowSessions. Synchronous callbacks
   * fall back to the active foreground session.
   */
  private resolveSessionId(workflowId?: string): string {
    if (workflowId) {
      const sid = this.workflowSessions.get(workflowId);
      if (sid) return sid;
    }
    return this.currentSessionId;
  }

  /** Lazily create (and bootstrap) a ContextAssembler for the given session. */
  private getContext(sessionId: string): ContextAssembler {
    let ctx = this.contextBySession.get(sessionId);
    if (ctx) return ctx;

    const configPath = process.env.CONFIG_PATH || '';
    const configDir = configPath
      ? configPath.replace(/\/[^/]+$/, '')
      : `${process.env.HOME || '/root'}/.orionomega`;

    ctx = new ContextAssembler(this.memory.client, {
      hotWindowSize: 20,
      recallBudgetTokens: 30_000,
      maxTurnTokens: 60_000,
      conversationBank: this.config.hindsight?.url
        ? `conversation-${sessionId}`
        : undefined,
      additionalBanks: this.config.hindsight?.url ? ['core'] : [],
      persistPath: `${configDir}/sessions/hot-window-${sessionId}.json`,
      sessionId,
    });

    // Wire memory-event forwarding so the live activity feed shows which
    // session each retain/dedup/recall came from.
    if (this.userCallbacks.onMemoryEvent) {
      ctx.onMemoryEvent = (op, detail, bank, meta) => {
        this.emitMemoryEvent(op as MemoryEvent['op'], detail, bank, { ...(meta ?? {}), sessionId }, sessionId);
      };
    }

    this.contextBySession.set(sessionId, ctx);

    // Best-effort: ensure the per-session conversation bank exists in
    // Hindsight. Failures are logged at debug — the bank usually exists
    // (after restarts) and circuit-breaker handles transport problems.
    if (this.memory.client && this.config.hindsight?.url) {
      const bank = `conversation-${sessionId}`;
      this.memory.client.createBank(bank, {
        name: `OrionOmega session ${sessionId}`,
      }).catch((err) => {
        log.debug('Conversation bank create failed (may already exist)', {
          bank,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return ctx;
  }

  /** Lazily create per-session totals. */
  private getTotals(sessionId: string): SessionTotals {
    let t = this.totalsBySession.get(sessionId);
    if (!t) {
      t = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 };
      this.totalsBySession.set(sessionId, t);
    }
    return t;
  }

  /**
   * Drop all in-memory per-session state for `sessionId`. Called by the
   * gateway when a session is deleted so the assembler/totals/workflow
   * mappings don't outlive the session row. Hindsight memories (and the
   * conversation bank itself) are intentionally NOT touched — they are the
   * cross-session knowledge graph and survive session deletion.
   */
  clearSessionState(sessionId: string): void {
    this.contextBySession.delete(sessionId);
    this.totalsBySession.delete(sessionId);
    for (const [wfId, sid] of this.workflowSessions) {
      if (sid === sessionId) {
        this.workflowSessions.delete(wfId);
        // Also drop the mirrored mapping inside RetentionEngine so any
        // late-arriving workflow events for this session don't keep tagging
        // memories under a deleted session id.
        this.memory.retention?.unregisterWorkflowSession(wfId);
      }
    }
    // Best-effort delete of the per-session hot-window file (and its .bak)
    // so a recreated session with the same id doesn't rehydrate stale
    // conversation context. Hindsight memories are NOT touched — they are
    // the cross-session knowledge graph and survive session deletion.
    try {
      const configPath = process.env.CONFIG_PATH || '';
      const configDir = configPath
        ? configPath.replace(/\/[^/]+$/, '')
        : `${process.env.HOME || '/root'}/.orionomega`;
      const hwPath = `${configDir}/sessions/hot-window-${sessionId}.json`;
      for (const p of [hwPath, `${hwPath}.bak`]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch (err) {
          log.debug('Failed to delete per-session hot-window file', {
            path: p,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.debug('clearSessionState: hot-window cleanup skipped', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.info('Cleared in-memory state for session', { sessionId });
  }

  /** Register a workflow → session mapping so async DAG callbacks route correctly. */
  registerWorkflowSession(workflowId: string, sessionId: string): void {
    this.workflowSessions.set(workflowId, sessionId);
    // Mirror the binding into the RetentionEngine so event-driven memory
    // writes (findings, errors, node outputs) get tagged with the source
    // session even though they originate from the EventBus, not from a
    // session-scoped callback.
    this.memory.retention?.registerWorkflowSession(workflowId, sessionId);
  }

  /**
   * Build a callbacks object that auto-injects sessionId into every call
   * by inspecting the workflowId argument and falling back to the active
   * foreground session.
   */
  private buildWrappedCallbacks(user: MainAgentCallbacks): MainAgentCallbacks {
    const sid = (workflowId?: string) => this.resolveSessionId(workflowId);
    return {
      onText: (text, streaming, done, workflowId) =>
        user.onText(text, streaming, done, workflowId, sid(workflowId)),
      onThinking: (text, streaming, done, workflowId) =>
        user.onThinking(text, streaming, done, workflowId, sid(workflowId)),
      onThinkingStep: user.onThinkingStep
        ? (step, workflowId) => user.onThinkingStep!(step, workflowId, sid(workflowId))
        : undefined,
      onPlan: (plan) => user.onPlan(plan, sid(plan?.graph?.id)),
      onEvent: (event) => user.onEvent(event, sid(event.workflowId)),
      onGraphState: (state) => user.onGraphState(state, sid((state as { workflowId?: string }).workflowId)),
      onCommandResult: (result) => user.onCommandResult(result, sid()),
      onSessionStatus: user.onSessionStatus
        ? (status) => user.onSessionStatus!(status, sid())
        : undefined,
      onWorkflowStart: user.onWorkflowStart
        ? (wfId, name) => user.onWorkflowStart!(wfId, name, sid(wfId))
        : undefined,
      onWorkflowEnd: user.onWorkflowEnd
        ? (wfId) => user.onWorkflowEnd!(wfId, sid(wfId))
        : undefined,
      onDAGDispatched: user.onDAGDispatched
        ? (info) => user.onDAGDispatched!(info, sid(info.workflowId))
        : undefined,
      onDAGProgress: user.onDAGProgress
        ? (info) => user.onDAGProgress!(info, sid(info.workflowId))
        : undefined,
      onDAGComplete: user.onDAGComplete
        ? (info) => user.onDAGComplete!(info, sid(info.workflowId))
        : undefined,
      onDAGConfirm: user.onDAGConfirm
        ? (info) => user.onDAGConfirm!(info, sid(info.workflowId))
        : undefined,
      onDirectStart: user.onDirectStart
        ? (info) => user.onDirectStart!(info, sid(info.runId))
        : undefined,
      onDirectComplete: user.onDirectComplete
        ? (info) => user.onDirectComplete!(info, sid(info.runId))
        : undefined,
      onHindsightActivity: user.onHindsightActivity,
      onMemoryEvent: user.onMemoryEvent
        ? (event) => user.onMemoryEvent!(event, sid())
        : undefined,
      onGateRequest: user.onGateRequest
        ? (req) => user.onGateRequest!(req, sid(req.workflowId))
        : undefined,
      onGateResolved: user.onGateResolved
        ? (info) => user.onGateResolved!(info, sid(info.workflowId))
        : undefined,
    };
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

    // 1b. Attach Hindsight client to all existing per-session context assemblers
    // (now that memory is initialised). New per-session contexts created later
    // via getContext() pull `this.memory.client` directly.
    if (this.memory.client) {
      for (const ctx of this.contextBySession.values()) {
        ctx.setHindsightClient(this.memory.client);
      }

      // Wire hindsight I/O activity tracking to gateway callback
      if (this.userCallbacks.onHindsightActivity) {
        this.memory.client.onActivity = this.userCallbacks.onHindsightActivity;
      }

      if (this.userCallbacks.onMemoryEvent) {
        this.memory.onMemoryEvent = (op, detail, bank, meta) => {
          this.emitMemoryEvent(op, detail, bank, meta);
        };
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
    // The orchestration bridge sees `wrappedCallbacks` — these include both
    // per-session cost accumulation (for DAGs) and the sessionId-injection
    // wrappers from `this.callbacks`.
    const wrappedCallbacks: MainAgentCallbacks = {
      ...this.callbacks,
      onDAGComplete: (result) => {
        if (result.status !== 'stopped') {
          const sid = this.resolveSessionId(result.workflowId);
          this.getTotals(sid).costUsd += result.totalCostUsd;
          this.emitSessionStatus(sid);
        }
        this.callbacks.onDAGComplete?.(result);
        // NOTE: workflowSessions.delete() is intentionally NOT called here.
        // OrchestrationBridge.cleanupWorkflow() fires onWorkflowEnd AFTER
        // onDAGComplete, and the wrapped onWorkflowEnd needs to resolve the
        // sessionId from workflowSessions. Deleting here would force the
        // resolver to fall back to currentSessionId — wrong attribution.
        // The deletion happens in the onWorkflowEnd wrapper below, after
        // the user callback has already received the correct session id.
      },
      onWorkflowEnd: (wfId) => {
        // Invoke the user-facing callback first so session resolution still
        // works (workflowSessions still contains the wfId → sid mapping).
        this.callbacks.onWorkflowEnd?.(wfId);
        // Now drop the mapping so the maps don't grow unboundedly across
        // the lifetime of the process. Mirror the cleanup into the
        // RetentionEngine to keep both maps in sync.
        this.workflowSessions.delete(wfId);
        this.memory.retention?.unregisterWorkflowSession(wfId);
      },
      onDAGDispatched: (info) => {
        // Bind workflowId → currentSessionId on dispatch so subsequent
        // async DAG events resolve to the originating session.
        this.registerWorkflowSession(info.workflowId, this.currentSessionId);
        this.callbacks.onDAGDispatched?.(info);
      },
      onDAGConfirm: (info) => {
        this.registerWorkflowSession(info.workflowId, this.currentSessionId);
        this.callbacks.onDAGConfirm?.(info);
      },
      onDirectStart: (info) => {
        // Direct runs use info.runId instead of a workflowId. Register the
        // mapping so the matching async onDirectComplete (and any background
        // text/thinking emissions keyed by runId) attributes back to the
        // session that initiated the direct run, not whatever session is
        // currently in the foreground.
        this.registerWorkflowSession(info.runId, this.currentSessionId);
        this.callbacks.onDirectStart?.(info);
      },
      onDirectComplete: (info) => {
        const sid = this.resolveSessionId(info.runId);
        if (info.totalCostUsd) {
          this.getTotals(sid).costUsd += info.totalCostUsd;
          this.emitSessionStatus(sid);
        }
        this.callbacks.onDirectComplete?.(info);
        this.workflowSessions.delete(info.runId);
        // Mirror the cleanup into RetentionEngine — direct runs registered
        // their runId via registerWorkflowSession() at start, so we must
        // unregister it here to keep both maps in sync and prevent the
        // workflowSessions map in retention-engine from growing unbounded.
        this.memory.retention?.unregisterWorkflowSession(info.runId);
      },
    };
    (this as unknown as { orchestration: OrchestrationBridge }).orchestration = new OrchestrationBridge(
      {
        workspaceDir: this.config.workspaceDir,
        checkpointDir: this.config.checkpointDir,
        workerTimeout: this.config.workerTimeout,
        codingAgentTimeout: this.config.codingAgentTimeout,
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
            (e) => this.pushHistory(DEFAULT_SESSION_ID, e as HistoryEntry),
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
    sessionId: string,
    content: string,
    replyContext?: { messageId: string; content: string; role: string; dagId?: string; workflowId?: string },
    attachments?: { name: string; size: number; type: string; data?: string; textContent?: string }[],
    agentMode?: 'orchestrate' | 'direct' | 'code',
    externalAbortSignal?: AbortSignal,
  ): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }

    // Bind the foreground session for this turn so synchronous callbacks
    // (text, thinking, command results, gates) attribute back to the right
    // session. Async DAG callbacks resolve via workflowSessions instead.
    // ALSO capture into `sid` so any closure created during this turn (e.g.
    // pushHistory callbacks passed to orchestration) attributes to *this*
    // session even if a later turn for another session shifts
    // `this.currentSessionId` while we're awaiting.
    this.currentSessionId = sessionId || DEFAULT_SESSION_ID;
    const sid = this.currentSessionId;
    const ctx = this.getContext(sid);

    if (!content?.trim() && (!attachments || attachments.length === 0)) {
      this.callbacks.onText('I didn\'t catch that. Could you say that again?', false, true);
      return;
    }

    const trimmed = (content || '').trim();
    log.verbose('Handling message', {
      sessionId: sid,
      contentLength: trimmed.length,
      contentPreview: trimmed.slice(0, 200),
      historyLength: ctx.getHistory().length,
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

    this.pushHistory(sid, { role: 'user', content: userContent });

    if (trimmed.startsWith('/')) {
      log.verbose('Route: slash command (pre-detach)', { command: trimmed.slice(0, 80) });
      await this.handleCommand(sid, trimmed);
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

    // Link external abort (e.g. scheduler timeout) to the internal controller
    // so any consumer that already honours `signal` (streamConversation, etc.)
    // gets cancelled when the caller aborts. Best-effort for orchestration
    // paths — the orchestration bridge is also stopped via stopAll() so any
    // workflow this turn dispatched is wound down.
    let externalAbortHandler: (() => void) | null = null;
    if (externalAbortSignal) {
      const internalAbort = this.activeAbort;
      const abortFromExternal = () => {
        if (!internalAbort.signal.aborted) {
          log.warn('handleMessage: external abort signal fired — aborting active conversation and orchestration');
          try {
            internalAbort.abort();
          } catch { /* ignore */ }
          try {
            this.orchestration?.stopAll();
          } catch (err) {
            log.debug('orchestration.stopAll() during external abort failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      };
      if (externalAbortSignal.aborted) {
        abortFromExternal();
      } else {
        externalAbortHandler = abortFromExternal;
        externalAbortSignal.addEventListener('abort', abortFromExternal, { once: true });
      }
    }

    if (this.memory.retention) {
      this.memory.retention.evaluateUserMessage(trimmed, this.memory.projectBank ?? undefined, sid).catch((err) => {
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
          (e) => this.pushHistory(sid, e as HistoryEntry),
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
              (e) => this.pushHistory(sid, e as HistoryEntry),
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
          (e) => this.pushHistory(sid, e as HistoryEntry),
        );
        return;
      }

      // 3. Skill-match shortcut — route through orchestration so skill MCP tools are available
      if (this.matchesAvailableSkill(trimmed)) {
        log.verbose('Route: ORCHESTRATE (skill match)', { guarded: isGuardedRequest(trimmed) });
        await this.orchestration.dispatchFullDAG(
          userContent,
          (e) => this.pushHistory(sid, e as HistoryEntry),
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
          (e) => this.pushHistory(sid, e as HistoryEntry),
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
            (e) => this.pushHistory(sid, e as HistoryEntry),
            { requireConfirmation: isGuardedRequest(trimmed) },
          );
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleMessage error', { error: msg });
      this.callbacks.onText(`Something went wrong: ${msg}`, false, true);
    } finally {
      if (externalAbortHandler && externalAbortSignal) {
        try {
          externalAbortSignal.removeEventListener('abort', externalAbortHandler);
        } catch { /* ignore */ }
      }
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
  async handleDAGResponse(sessionId: string, workflowId: string, action: 'approve' | 'reject'): Promise<void> {
    this.currentSessionId = sessionId || DEFAULT_SESSION_ID;
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

  /**
   * Handle a structured human-gate approval response from the gateway.
   * Mirrors handleDAGResponse's contract — gateway calls this when a client
   * sends a `gate_response` message with the gateId returned in the
   * matching `gate_request` event.
   */
  async handleGateResponse(sessionId: string, gateId: string, approved: boolean): Promise<void> {
    this.currentSessionId = sessionId || DEFAULT_SESSION_ID;
    try {
      this.orchestration.resolveGate(gateId, approved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleGateResponse error', { error: msg });
      this.callbacks.onText(`Error handling gate response: ${msg}`, false, true);
    }
  }

  /** Handle a plan response (approve, modify, reject). */
  async handlePlanResponse(sessionId: string, planId: string, action: string, modification?: string): Promise<void> {
    const sid = sessionId || DEFAULT_SESSION_ID;
    this.currentSessionId = sid;
    try {
      await this.orchestration.handlePlanResponse(
        planId, action,
        (e) => this.pushHistory(sid, e as HistoryEntry),
        modification,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handlePlanResponse error', { error: msg });
      this.callbacks.onText(`Error handling plan response: ${msg}`, false, true);
    }
  }

  /** Handle a slash command, optionally targeting a specific workflow. */
  async handleCommand(sessionId: string, command: string, workflowId?: string): Promise<void> {
    const sid = sessionId || DEFAULT_SESSION_ID;
    this.currentSessionId = sid;
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
            (e) => this.pushHistory(sid, e as HistoryEntry),
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
        // Wipe only the calling session's hot window + totals — other sessions
        // remain untouched. Hindsight memories are NOT cleared (cross-session
        // knowledge survives /reset).
        this.getContext(sid).clear();
        const totals = this.getTotals(sid);
        totals.inputTokens = 0;
        totals.outputTokens = 0;
        totals.cacheCreationTokens = 0;
        totals.cacheReadTokens = 0;
        totals.costUsd = 0;
        this.cachedSystemPrompt = null;
        this.callbacks.onCommandResult({
          command: '/reset', success: true,
          message: 'Reset complete. Pending plans cleared, history wiped, executor stopped.',
        });
        this.emitSessionStatus(sid);
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
          await this.handleMessage(sid, fileCmd.content);
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
  async flushMemory(sessionId?: string): Promise<void> {
    const sid = sessionId || this.currentSessionId;
    await this.memory.flush(this.getContext(sid).getHistory(), sid);
  }

  /** Summarize the session to Hindsight. */
  async summarizeSession(sessionId?: string): Promise<void> {
    const sid = sessionId || this.currentSessionId;
    await this.memory.summarize(this.getContext(sid).getHistory(), sid);
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

  emitMemoryEvent(op: MemoryEvent['op'], detail: string, bank?: string, meta?: Record<string, unknown>, sessionId?: string): void {
    const sid = sessionId ?? this.currentSessionId;
    this.userCallbacks.onMemoryEvent?.({
      id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      op,
      detail,
      bank,
      meta: { ...(meta ?? {}), sessionId: sid },
    }, sid);
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

    // CRITICAL multi-session correctness:
    // The wrapped onText/onThinking/onThinkingStep callbacks below pass
    // `effectiveRunId` (NOT the `direct-${effectiveRunId}` prefixed form)
    // as the workflowId argument when the conversation is detached. The
    // user-facing `buildWrappedCallbacks` then runs `sid(workflowId)`
    // (i.e. resolveSessionId(effectiveRunId)) to attribute the event to
    // the originating session. Without an entry under `effectiveRunId`
    // in workflowSessions, that lookup misses and falls back to
    // `currentSessionId` — which is mutable across turns. If a different
    // session has become foreground by the time a background turn emits
    // its final text, the text would be persisted/broadcast to the wrong
    // session.
    //
    // We therefore bind BOTH `effectiveRunId` (used by streaming
    // callbacks) AND `direct-${effectiveRunId}` (used by
    // onDirectStart/Complete + the orchestration `onEvent` emissions
    // below) to the active session at turn start, and clear both
    // bindings in the `finally` block. This guarantees sid resolution
    // succeeds for every event regardless of which ID the call site
    // chose to thread through.
    const _directWorkflowIdForBinding = `direct-${effectiveRunId}`;
    const _sessionAtTurnStart = this.currentSessionId;
    this.registerWorkflowSession(effectiveRunId, _sessionAtTurnStart);
    this.registerWorkflowSession(_directWorkflowIdForBinding, _sessionAtTurnStart);

    const checkDetached = () => {
      if (!wasDetached && this.backgroundConversations.has(effectiveRunId)) {
        wasDetached = true;
      }
      return wasDetached;
    };

    // `directWorkflowId` is captured by closure below; we initialize it
    // here so the wrapped callbacks can forward direct-mode thinking/text
    // into the orchestration event stream (Activity Feed parity).
    const _directWorkflowId = `direct-${effectiveRunId}`;
    // Captured here (not inside try) so the catch path can compute
    // failure duration for the orchestration `run_failed` signal.
    const turnStartTime = Date.now();

    // Streaming convention from `streamConversation`:
    //   onText(delta, streaming=true, done=false)  per chunk
    //   onText('', streaming=true, done=true)       on completion
    //   onThinking(label, true, false) / onThinking('', false, true)
    // Emitting orchestration events only on `done && text` would drop
    // every successful run's narrative because the terminal callback is
    // the empty-string sentinel. Accumulate deltas and emit the buffered
    // content on `done` so Activity Feed gets the full final text /
    // thinking, matching Orchestrate-mode parity.
    // Emit text/thinking deltas into the orchestration stream as they
    // arrive so the Activity Feed updates in real time, matching
    // Orchestrate-mode parity. We coalesce frequent deltas into ~80ms
    // batches to keep the bus from getting flooded by per-token
    // callbacks while still giving a responsive UI.
    let _textBuffer = '';
    let _thinkingBuffer = '';
    let _textTimer: ReturnType<typeof setTimeout> | null = null;
    let _thinkingTimer: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_MS = 80;
    const TEXT_CAP = 4000;
    const THINK_CAP = 2000;
    const emitTextChunk = (chunk: string) => {
      if (wasDetached || !chunk.trim()) return;
      const out = chunk.length > TEXT_CAP ? chunk.slice(0, TEXT_CAP) + '…' : chunk;
      this.callbacks.onEvent({
        workflowId: _directWorkflowId,
        workerId: 'direct',
        nodeId: 'direct',
        timestamp: new Date().toISOString(),
        type: 'finding',
        message: out,
      });
    };
    const emitThinkingChunk = (chunk: string) => {
      if (wasDetached || !chunk.trim()) return;
      const out = chunk.length > THINK_CAP ? chunk.slice(0, THINK_CAP) + '…' : chunk;
      this.callbacks.onEvent({
        workflowId: _directWorkflowId,
        workerId: 'direct',
        nodeId: 'direct',
        timestamp: new Date().toISOString(),
        type: 'thinking',
        thinking: out,
      });
    };
    const flushText = () => {
      if (_textTimer) { clearTimeout(_textTimer); _textTimer = null; }
      const buf = _textBuffer; _textBuffer = '';
      if (buf) emitTextChunk(buf);
    };
    const flushThinking = () => {
      if (_thinkingTimer) { clearTimeout(_thinkingTimer); _thinkingTimer = null; }
      const buf = _thinkingBuffer; _thinkingBuffer = '';
      if (buf) emitThinkingChunk(buf);
    };

    const wrappedOnText = (text: string, streaming: boolean, done: boolean) => {
      checkDetached();
      this.callbacks.onText(text, streaming, done, wasDetached ? effectiveRunId : undefined);
      if (text) {
        _textBuffer += text;
        if (!_textTimer) _textTimer = setTimeout(flushText, FLUSH_MS);
      }
      if (done) flushText();
    };

    const wrappedOnThinking = (text: string, streaming: boolean, done: boolean) => {
      checkDetached();
      this.callbacks.onThinking(text, streaming, done, wasDetached ? effectiveRunId : undefined);
      if (text) {
        _thinkingBuffer += (_thinkingBuffer ? '\n' : '') + text;
        if (!_thinkingTimer) _thinkingTimer = setTimeout(flushThinking, FLUSH_MS);
      }
      if (done) flushThinking();
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

    // Surface this direct-mode turn in the orchestration pane so users see
    // the same Activity Feed / Workflow tab affordances they get for
    // Orchestrate/Code mode runs. Uses the same `direct-${runId}` workflow
    // id that `onDirectComplete` already references, so the live tab and
    // the final RunSummaryCard share state.
    const directWorkflowId = _directWorkflowId;
    if (!wasDetached) {
      this.callbacks.onDirectStart?.({
        runId: directWorkflowId,
        model: this.config.model,
        userMessage: userMessage.length > 200 ? userMessage.slice(0, 200) + '…' : userMessage,
      });
    }

    // Per-turn run output directory. Mirrors the orchestration executor's
    // `${workspaceDir}/output/${runId}` pattern so direct-mode artifacts land
    // in the canonical run output folder. The runDir block in the system
    // prompt and the relative-path resolution + install-dir guard in
    // `executeMainTool` both pivot off this path.
    const runDir = this.config.workspaceDir
      ? `${this.config.workspaceDir}/output/${effectiveRunId}`
      : undefined;
    if (runDir) {
      try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(runDir, { recursive: true });
      } catch (err) {
        log.warn('Failed to create direct-mode run output dir', {
          runDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const sid = _sessionAtTurnStart;
    const [systemPrompt, assembled] = await Promise.all([
      this.getSystemPrompt(runDir),
      this.getContext(sid).assemble(userMessage),
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
      // Forward direct-mode tool calls into the orchestration event stream
      // so the Activity Feed / Workflow tab show them like any other run.
      // Only fire for foreground turns — background conversations already
      // tag every onText/onThinking with a workflowId and don't need a
      // duplicate orchestration thread.
      const directToolStart = wasDetached ? undefined : (info: { id: string; name: string; input: Record<string, unknown>; summary: string; file?: string; action?: string }) => {
        this.callbacks.onEvent({
          workflowId: directWorkflowId,
          workerId: 'direct',
          nodeId: 'direct',
          timestamp: new Date().toISOString(),
          type: 'tool_call',
          tool: { id: info.id, name: info.name, summary: info.summary, file: info.file, action: info.action, params: info.input },
        } as WorkerEvent & { tool: { id?: string; name: string; summary?: string; file?: string; action?: string; params?: Record<string, unknown> } });
      };
      const directToolEnd = wasDetached ? undefined : (info: { id: string; name: string; result: string; isError: boolean; durationMs: number; summary: string; file?: string; action?: string }) => {
        this.callbacks.onEvent({
          workflowId: directWorkflowId,
          workerId: 'direct',
          nodeId: 'direct',
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          tool: { id: info.id, name: info.name, summary: info.summary, file: info.file, action: info.action },
          message: info.result,
          durationMs: info.durationMs,
          ...(info.isError ? { error: info.result } : {}),
        } as WorkerEvent & { message?: string; durationMs?: number });
      };

      const result = await streamConversation({
        client: this.anthropic,
        model: this.config.model,
        systemPrompt,
        messages,
        workspaceDir: this.config.workspaceDir,
        runDir,
        onText: wrappedOnText,
        onThinking: wrappedOnThinking,
        onThinkingStep: wrappedOnThinkingStep ? (step) => wrappedOnThinkingStep(step as ThinkingStep) : undefined,
        onToolStart: directToolStart,
        onToolEnd: directToolEnd,
        maxInputTokens: 100_000,
        abortSignal,
      });
      if (!checkDetached()) {
        this.emitStep('llm', 'Generating response', 'done');
      }
      const totals = this.getTotals(sid);
      totals.inputTokens += result.inputTokens;
      totals.outputTokens += result.outputTokens;
      totals.cacheCreationTokens += result.cacheCreationTokens;
      totals.cacheReadTokens += result.cacheReadTokens;
      totals.costUsd += this.estimateConversationalCost(
        result.inputTokens, result.outputTokens,
        result.cacheCreationTokens, result.cacheReadTokens,
      );
      if (!wasDetached) {
        this.pushHistory(sid, { role: "assistant", content: result.text });
      } else {
        log.info('Background conversation completed, appending to history', { runId: effectiveRunId, textLength: result.text.length });
        this.pushHistory(sid, { role: "assistant", content: `[Background ${effectiveRunId.slice(0, 12)}]: ${result.text}` });
      }
      this.emitSessionStatus(sid);

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
        this.pushHistory(sid, { role: 'assistant', content: fallback });
        // Surface direct-mode failures through the orchestration event
        // stream + completion callback so the Workflow tab tab transitions
        // to an "error" terminal state rather than appearing stuck mid-run.
        this.callbacks.onEvent({
          workflowId: _directWorkflowId,
          workerId: 'direct',
          nodeId: 'direct',
          timestamp: new Date().toISOString(),
          type: 'error',
          error: msg,
          message: msg,
        });
        const failureDurationSec = (Date.now() - turnStartTime) / 1000;
        const shortModel = this.config.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
        this.callbacks.onDirectComplete?.({
          runId: _directWorkflowId,
          model: this.config.model,
          durationSec: Math.round(failureDurationSec * 10) / 10,
          modelUsage: [{
            model: shortModel,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            workerCount: 1,
            costUsd: 0,
          }],
          totalCostUsd: 0,
          error: msg,
        });
      }
    } finally {
      if (runId) {
        this.backgroundConversations.delete(runId);
      }
      if (this.foregroundRunId === effectiveRunId) {
        this.isActiveConversation = false;
      }
      // Drop the workflow→session bindings registered at turn start so
      // the maps don't grow unboundedly. Mirror the cleanup into the
      // RetentionEngine to keep both maps in sync.
      this.workflowSessions.delete(effectiveRunId);
      this.workflowSessions.delete(_directWorkflowIdForBinding);
      this.memory.retention?.unregisterWorkflowSession(effectiveRunId);
      this.memory.retention?.unregisterWorkflowSession(_directWorkflowIdForBinding);
    }
  }

  /**
   * Emit session status for the given session to the TUI/gateway.
   * Bypasses the sessionId-injection wrapper and goes straight to the user
   * callback so we can pass an explicit sessionId (callers may emit status
   * for a non-foreground session, e.g. when a DAG belonging to session B
   * completes while session A is the foreground turn).
   */
  private emitSessionStatus(sessionId: string): void {
    const totals = this.getTotals(sessionId);
    this.userCallbacks.onSessionStatus?.({
      model: this.config.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      maxContextTokens: 200000,
      sessionCostUsd: totals.costUsd,
    }, sessionId);
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

  /**
   * Returns the cached base system prompt, optionally appended with a per-turn
   * "Output Directory (STRICT)" block for the active direct-mode run. The base
   * prompt is cached because it includes host-identity execs and SOUL/USER/TOOLS
   * file reads; the runDir block changes every turn so it's appended on the fly
   * rather than baked into the cache.
   */
  private async getSystemPrompt(runDir?: string): Promise<string> {
    let base: string;
    if (this.cachedSystemPrompt) {
      base = this.cachedSystemPrompt;
    } else if (this.config.systemPrompt) {
      this.cachedSystemPrompt = this.config.systemPrompt;
      base = this.cachedSystemPrompt;
    } else {
      const context: PromptContext = {
        workspaceDir: this.config.workspaceDir,
        activeWorkflow: this.orchestration.hasActiveWorkflow,
      };
      this.cachedSystemPrompt = await buildSystemPrompt(context);
      base = this.cachedSystemPrompt;
    }
    return runDir ? base + buildRunDirBlock(runDir) : base;
  }

  /** Build messages from a session's hot window only (sync, for non-conversational paths). */
  private buildAnthropicMessages(sessionId?: string): AnthropicMessage[] {
    const sid = sessionId || this.currentSessionId;
    return this.getContext(sid).getHistory().map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
  }

  private pushHistory(sessionId: string, entry: HistoryEntry): void {
    // Fire-and-forget: push to context assembler (retains to Hindsight + hot window)
    this.getContext(sessionId).push({
      role: entry.role as 'user' | 'assistant' | 'system',
      content: entry.content,
    }).catch((err) => {
      log.debug('Context push failed (fire-and-forget)', { sessionId, error: err instanceof Error ? err.message : String(err) });
    });
  }
}
