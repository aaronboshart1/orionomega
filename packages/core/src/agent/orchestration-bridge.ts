/**
 * @module agent/orchestration-bridge
 * Bridges the main agent to the orchestration engine (Planner → Executor).
 *
 * Handles plan generation, execution, worker event relay, and completion processing.
 * Supports concurrent workflows — multiple plans can be pending and multiple
 * executors can run simultaneously without interfering with one another.
 */

import { Planner } from '../orchestration/planner.js';
import { GraphExecutor } from '../orchestration/executor.js';
import type { ExecutorConfig } from '../orchestration/executor.js';
import { EventBus } from '../orchestration/event-bus.js';
import { OrchestratorCommands } from '../orchestration/commands.js';
import { CheckpointManager } from '../orchestration/checkpoint.js';
import { WorkflowState } from '../orchestration/state.js';
import type {
  PlannerOutput,
  WorkerEvent,
  GraphState,
  ExecutionResult,
  WorkflowCheckpoint,
  DAGDispatchInfo,
  DAGCompleteInfo,
  DAGConfirmInfo,
} from '../orchestration/types.js';
import type { MemoryBridge } from './memory-bridge.js';
import type { MainAgentCallbacks, ThinkingStep, ThinkingStepStatus } from './main-agent.js';
import { createLogger } from '../logging/logger.js';
import { randomBytes } from 'node:crypto';

const log = createLogger('orchestration-bridge');

/** Configuration for the orchestration bridge. */
export interface OrchestrationConfig {
  workspaceDir: string;
  checkpointDir: string;
  workerTimeout: number;
  maxRetries: number;
}

/** An active, running workflow. */
interface ActiveWorkflow {
  id: string;
  name: string;
  executor: GraphExecutor;
  /** Unsubscribes the event listener for this workflow. */
  eventUnsubscribe: () => void;
  /** Periodic state snapshot timer. */
  stateSnapshotTimer: ReturnType<typeof setInterval>;
  startedAt: string;
  task: string;
}

/** A plan that has been generated and is awaiting user approval. */
interface PendingPlan {
  id: string;
  plan: PlannerOutput;
  task: string;
  createdAt: string;
}

/** A human gate approval request waiting for user input. */
interface HumanGateRequest {
  gateId: string;
  workflowId: string;
  workflowName: string;
  action: string;
  description: string;
  resolve: (approved: boolean) => void;
  timestamp: string;
}

/**
 * Manages the lifecycle of workflow planning and execution.
 *
 * Owns: planner, executor map, pending plan map, event subscriptions.
 * Delegates: memory recall to MemoryBridge, UI updates to callbacks.
 */
export class OrchestrationBridge {
  private readonly planner: Planner;
  readonly eventBus: EventBus;
  readonly commands: OrchestratorCommands;

  /** Plans currently awaiting user approval, keyed by plan (graph) ID. */
  private readonly pendingPlans = new Map<string, PendingPlan>();

  /** Currently running executors, keyed by workflow ID. */
  private readonly activeWorkflows = new Map<string, ActiveWorkflow>();

  /** Human gate requests awaiting approval, keyed by gate ID. */
  private readonly pendingGates = new Map<string, HumanGateRequest>();

  /** Guarded DAG confirmations awaiting user approval, keyed by workflow ID. */
  private readonly pendingConfirmations = new Map<string, {
    plan: PlannerOutput;
    task: string;
    pushHistory: (entry: { role: string; content: string }) => void;
  }>();

  constructor(
    private readonly config: OrchestrationConfig,
    private readonly callbacks: MainAgentCallbacks,
    private readonly memory: MemoryBridge,
    private readonly availableSkills: string[],
    model: string,
  ) {
    this.planner = new Planner({ model });
    this.eventBus = new EventBus();
    this.commands = new OrchestratorCommands();
  }

  // ── Public getters ──────────────────────────────────────────────

  /** Whether there is at least one plan awaiting user approval. */
  get hasPendingPlans(): boolean { return this.pendingPlans.size > 0; }

  /**
   * ID of the most recently added pending plan, or null.
   * Used for single-plan approval flows (backward-compat).
   */
  get latestPendingPlanId(): string | null {
    if (this.pendingPlans.size === 0) return null;
    return [...this.pendingPlans.keys()].pop()!;
  }

  /** Whether any workflow is currently running. */
  get hasActiveWorkflow(): boolean { return this.activeWorkflows.size > 0; }

  /** Number of currently running workflows. */
  get workflowCount(): number { return this.activeWorkflows.size; }

  /** Check if a specific workflow is currently active. */
  isWorkflowActive(workflowId: string): boolean { return this.activeWorkflows.has(workflowId); }

  /** Whether there are any human gate requests awaiting approval. */
  get hasPendingGates(): boolean { return this.pendingGates.size > 0; }

  /** Whether there are any guarded DAG confirmations awaiting approval. */
  get hasPendingConfirmations(): boolean { return this.pendingConfirmations.size > 0; }

  // ── Thinking step helper ─────────────────────────────────────────

  private _stepTimers = new Map<string, number>();

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

  // ── Full DAG dispatch (ORCHESTRATE tier) ──────────────────────────

  /**
   * Generate a full planner DAG and dispatch it.
   * If `requireConfirmation` is set, pause for user approval before executing.
   */
  async dispatchFullDAG(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
    opts: { requireConfirmation?: boolean } = {},
  ): Promise<void> {
    this.emitStep('memory', 'Recalling memory', 'active');
    this.callbacks.onThinking('Planning…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      this.emitStep('memory', 'Recalling memory', 'done', `${memories.length} source${memories.length !== 1 ? 's' : ''} found`);
      this.emitStep('planning', 'Generating plan', 'active');
      const preRecalledContext = memories.length ? memories.join('\n') : undefined;
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      }, preRecalledContext);
      const nodeCount = plan.graph?.nodes ? (plan.graph.nodes instanceof Map ? plan.graph.nodes.size : Object.keys(plan.graph.nodes).length) : 0;
      this.emitStep('planning', 'Generating plan', 'done', `${nodeCount} node${nodeCount !== 1 ? 's' : ''} in DAG`);
      this.callbacks.onThinking('', true, true);

      if (opts.requireConfirmation) {
        // Store for confirmation and emit confirm event
        this.pendingConfirmations.set(plan.graph.id, { plan, task, pushHistory });

        const confirmInfo: DAGConfirmInfo = {
          workflowId: plan.graph.id,
          summary: plan.summary,
          reasoning: plan.reasoning,
          estimatedCost: plan.estimatedCost,
          estimatedTime: plan.estimatedTime,
          nodes: [...plan.graph.nodes.values()].map((n) => ({ id: n.id, label: n.label, type: n.type })),
          guardedActions: [],
        };
        this.callbacks.onDAGConfirm?.(confirmInfo);
        // Also send a text message for TUI/backward compat
        this.callbacks.onText(
          `This task involves potentially destructive operations. ${plan.summary}\nSay **yes** to approve or **no** to cancel.`,
          false, true,
        );
        pushHistory({ role: 'assistant', content: `[Awaiting confirmation] ${plan.summary}` });
        return;
      }

      await this.dispatchAsync(plan, pushHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('dispatchFullDAG error', { error: msg });
      this.callbacks.onThinking('', true, true);
      this.callbacks.onText(`Failed to plan: ${msg}`, false, true);
    }
  }

  // ── Async dispatch (shared by micro and full DAGs) ────────────────

  /**
   * Dispatch a plan for background execution. Returns the workflow ID immediately.
   * The agent loop is freed — execution happens asynchronously.
   */
  private async dispatchAsync(
    plan: PlannerOutput,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<string> {
    const workflowId = plan.graph.id;

    // Emit dispatch info
    const dispatchInfo: DAGDispatchInfo = {
      workflowId,
      workflowName: plan.graph.name,
      nodeCount: plan.graph.nodes.size,
      estimatedTime: plan.estimatedTime,
      estimatedCost: plan.estimatedCost,
      summary: plan.summary,
      nodes: [...plan.graph.nodes.values()].map((n) => ({ id: n.id, label: n.label, type: n.type })),
    };
    this.callbacks.onDAGDispatched?.(dispatchInfo);
    pushHistory({ role: 'assistant', content: `[Dispatched] ${plan.summary}` });

    // Fire-and-forget: execute in the background
    void this.executeBackground(plan, pushHistory).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Background execution failed', { error: msg, workflowId });
      this.callbacks.onText(`Workflow failed: ${msg}`, false, true);
    });

    return workflowId;
  }

  /**
   * Execute a plan in the background via the GraphExecutor.
   * Identical to executePlan but designed to be called via fire-and-forget.
   */
  private async executeBackground(
    plan: PlannerOutput,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    await this.executePlan(plan, pushHistory);
  }

  // ── Confirmation resolution ───────────────────────────────────────

  /**
   * Resolve a pending guarded DAG confirmation.
   * Called when the user says "yes"/"no" to a guarded operation.
   * If workflowId is provided, resolves that specific confirmation.
   * Otherwise resolves the most recent one.
   */
  resolveConfirmation(approved: boolean, workflowId?: string): void {
    const targetId = workflowId ?? [...this.pendingConfirmations.keys()].pop();
    if (!targetId) return;

    const pending = this.pendingConfirmations.get(targetId);
    if (!pending) return;

    this.pendingConfirmations.delete(targetId);

    if (approved) {
      this.callbacks.onText('Approved. Starting execution…', false, true);
      void this.dispatchAsync(pending.plan, pending.pushHistory);
    } else {
      this.callbacks.onText('Cancelled.', false, true, targetId);
      pending.pushHistory({ role: 'assistant', content: '[Cancelled by user]' });
    }
  }

  // ── Plan generation ─────────────────────────────────────────────

  /**
   * Generate a plan and present it to the user (without executing).
   */
  async planOnly(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    this.emitStep('memory', 'Recalling memory', 'active');
    this.callbacks.onThinking('Analysing your request and building an execution plan…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      this.emitStep('memory', 'Recalling memory', 'done', `${memories.length} source${memories.length !== 1 ? 's' : ''} found`);
      this.emitStep('planning', 'Generating plan', 'active');
      const preRecalledContext = memories.length ? memories.join('\n') : undefined;
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      }, preRecalledContext);

      const nodeCount = plan.graph?.nodes ? (plan.graph.nodes instanceof Map ? plan.graph.nodes.size : Object.keys(plan.graph.nodes).length) : 0;
      this.emitStep('planning', 'Generating plan', 'done', `${nodeCount} node${nodeCount !== 1 ? 's' : ''} in DAG`);

      this.pendingPlans.set(plan.graph.id, {
        id: plan.graph.id,
        plan,
        task,
        createdAt: new Date().toISOString(),
      });

      this.callbacks.onThinking('', true, true);
      this.callbacks.onPlan(plan);
      pushHistory({ role: 'assistant', content: `[Plan presented] ${plan.summary}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Planning error', { error: msg });
      this.callbacks.onThinking('', true, true);
      this.callbacks.onText(`Failed to generate a plan: ${msg}`, false, true);
    }
  }

  /**
   * Generate a plan and immediately execute it (no approval step).
   */
  async planAndExecute(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    this.emitStep('memory', 'Recalling memory', 'active');
    this.callbacks.onThinking('Planning and executing immediately…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      this.emitStep('memory', 'Recalling memory', 'done', `${memories.length} source${memories.length !== 1 ? 's' : ''} found`);
      this.emitStep('planning', 'Generating plan', 'active');
      const preRecalledContext = memories.length ? memories.join('\n') : undefined;
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      }, preRecalledContext);
      const nodeCount = plan.graph?.nodes ? (plan.graph.nodes instanceof Map ? plan.graph.nodes.size : Object.keys(plan.graph.nodes).length) : 0;
      this.emitStep('planning', 'Generating plan', 'done', `${nodeCount} node${nodeCount !== 1 ? 's' : ''} in DAG`);
      this.callbacks.onThinking('', true, true);
      this.callbacks.onPlan(plan);
      pushHistory({ role: 'assistant', content: `[Plan auto-approved] ${plan.summary}` });
      await this.executePlan(plan, pushHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Plan-and-execute error', { error: msg });
      this.callbacks.onText(`Failed to plan or execute: ${msg}`, false, true);
    }
  }

  // ── Plan response handling ──────────────────────────────────────

  /**
   * Handle a plan response (approve, modify, reject) for a specific plan ID.
   */
  async handlePlanResponse(
    planId: string,
    action: string,
    pushHistory: (entry: { role: string; content: string }) => void,
    modification?: string,
  ): Promise<void> {
    const pending = this.pendingPlans.get(planId);
    if (!pending) {
      this.callbacks.onText(
        'That plan is no longer available. It may have expired or been superseded.',
        false, true,
      );
      return;
    }

    switch (action) {
      case 'approve':
        if (this.memory.banks && pending.task) {
          await this.memory.ensureProjectBank(pending.task);
        }
        await this.executePlan(pending.plan, pushHistory);
        break;

      case 'modify': {
        if (!modification) {
          // No modification text — treat as approve
          if (this.memory.banks && pending.task) {
            await this.memory.ensureProjectBank(pending.task);
          }
          await this.executePlan(pending.plan, pushHistory);
          break;
        }

        // Classify the modification: is it approval-with-context or a genuine change?
        const isApprovalWithContext = await this.classifyModification(modification, pending.task);

        if (isApprovalWithContext) {
          // User is approving with additional instructions — execute the plan as-is
          // and inject the additional context into the task description for workers
          log.verbose('Modification classified as approval-with-context', { modification });
          pending.task = `${pending.task}\n\nAdditional instructions: ${modification}`;
          if (this.memory.banks && pending.task) {
            await this.memory.ensureProjectBank(pending.task);
          }
          await this.executePlan(pending.plan, pushHistory);
        } else {
          // Genuine modification — re-plan with the changes
          log.verbose('Modification classified as change request', { modification });
          const modifiedTask = `${pending.task}\n\nModification: ${modification}`;
          this.pendingPlans.delete(planId);
          this.callbacks.onText('Re-planning with your modifications…', true, true);
          await this.planOnly(modifiedTask, pushHistory);
        }
        break;
      }

      case 'reject':
        this.pendingPlans.delete(planId);
        this.callbacks.onText('Plan rejected. What would you like instead?', false, true);
        break;

      default:
        this.callbacks.onText(
          `Unknown plan action: '${action}'. Use approve, modify, or reject.`,
          false, true,
        );
    }
  }

  // ── Execution ───────────────────────────────────────────────────

  /**
   * Classify whether a user's modification text is:
   * - Approval with additional context ("this is correct, just do X")
   * - A genuine change to the plan ("actually, remove step 3 and add Y")
   *
   * Uses fast heuristics first, falls back to LLM for ambiguous cases.
   */
  private async classifyModification(modification: string, _task: string): Promise<boolean> {
    const lower = modification.toLowerCase().trim();

    // Fast-path: clear approval signals
    const approvalSignals = [
      /\b(this is correct|that'?s? (correct|right|perfect|good|great))\b/i,
      /\b(looks? good|sounds? good|exactly|perfect|go ahead|do it|proceed|get .* (setup|started|going|done))\b/i,
      /\b(yes|yep|yeah|correct|approved?|lgtm)\b/i,
      /^(ok|okay)\b/i,
    ];
    const hasApprovalSignal = approvalSignals.some((re) => re.test(lower));

    // Fast-path: clear change signals
    const changeSignals = [
      /\b(instead|change|replace|remove|delete|swap|don'?t|shouldn'?t|actually no|wait)\b/i,
      /\b(add (a |another )?step|reorder|different)\b/i,
    ];
    const hasChangeSignal = changeSignals.some((re) => re.test(lower));

    // If only approval signals, it's approval-with-context
    if (hasApprovalSignal && !hasChangeSignal) return true;
    // If only change signals, it's a modification
    if (hasChangeSignal && !hasApprovalSignal) return false;

    // Ambiguous — default to approval-with-context
    // Rationale: rejecting a plan is more disruptive than executing with extra context.
    // If the user wanted to reject, they'd say "no", "reject", "cancel", etc.
    log.verbose('Modification classification ambiguous, defaulting to approval-with-context', {
      modification: lower.slice(0, 100),
      hasApprovalSignal,
      hasChangeSignal,
    });
    return true;
  }

  /**
   * Execute an approved plan via the GraphExecutor.
   * Registers the workflow in both the active map and the commands registry.
   */
  private async executePlan(
    plan: PlannerOutput,
    pushHistory: (entry: { role: string; content: string }) => void,
    startLayer?: number,
    restoredState?: WorkflowState,
  ): Promise<void> {
    const workflowId = plan.graph.id;
    const workflowName = plan.graph.name;

    this.pendingPlans.delete(workflowId);

    const executorConfig: ExecutorConfig = {
      workspaceDir: this.config.workspaceDir,
      checkpointDir: this.config.checkpointDir,
      workerTimeout: this.config.workerTimeout,
      maxRetries: this.config.maxRetries,
      checkpointInterval: 1,
      humanGateCallback: async (action: string, description: string): Promise<boolean> => {
        const gateId = randomBytes(8).toString('hex');
        return new Promise<boolean>((resolve) => {
          this.pendingGates.set(gateId, {
            gateId,
            workflowId,
            workflowName,
            action,
            description,
            resolve,
            timestamp: new Date().toISOString(),
          });
          this.callbacks.onText(
            `⚠️ [${workflowName}] Approval needed: ${action} — ${description}\nGate ID: ${gateId}\nReply allow or deny`,
            false, true,
          );
        });
      },
    };

    const executor = new GraphExecutor(plan.graph, this.eventBus, executorConfig, restoredState);

    // Subscribe to '*' and filter to only this workflow's events
    const eventUnsub = this.eventBus.subscribe('*', (event) => {
      if (event.workflowId === workflowId) {
        this.handleWorkerEvent(event, workflowId);
      }
    });

    // Periodic state snapshot for this workflow
    const stateSnapshotTimer = setInterval(() => {
      const wf = this.activeWorkflows.get(workflowId);
      if (wf) this.callbacks.onGraphState(wf.executor.getState());
    }, 2_000);

    const workflow: ActiveWorkflow = {
      id: workflowId,
      name: workflowName,
      executor,
      eventUnsubscribe: eventUnsub,
      stateSnapshotTimer,
      startedAt: new Date().toISOString(),
      task: plan.summary,
    };

    this.activeWorkflows.set(workflowId, workflow);
    this.callbacks.onWorkflowStart?.(workflowId, workflowName);
    this.commands.addWorkflow(workflowId, executor, workflowName);

    if (this.memory.retention && this.memory.projectBank) {
      this.memory.retention.registerWorkflowBank(workflowId, this.memory.projectBank);
    }

    this.callbacks.onText('Workflow started. I\'ll keep you posted on progress.', false, true, workflowId);
    pushHistory({ role: 'assistant', content: '[Workflow execution started]' });

    try {
      const result = await executor.execute(startLayer);
      await this.onExecutionComplete(result, workflowId, pushHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Execution error', { error: msg });
      this.callbacks.onText(`Workflow failed: ${msg}`, false, true);
    } finally {
      this.cleanupWorkflow(workflowId);
    }
  }

  // ── Event handling ──────────────────────────────────────────────

  /** Per-node progress throttle timestamps for DAG progress events. */
  private readonly progressThrottleMap = new Map<string, number>();

  /** Relay a worker event to callbacks, also triggering a state snapshot and inline progress. */
  private handleWorkerEvent(event: WorkerEvent, workflowId: string): void {
    this.callbacks.onEvent(event);

    if (event.type === 'done' || event.type === 'error' || event.type === 'status') {
      const wf = this.activeWorkflows.get(workflowId);
      if (wf) this.callbacks.onGraphState(wf.executor.getState());
    }

    // Emit throttled inline DAG progress
    this.emitThrottledDAGProgress(event, workflowId);
  }

  /**
   * Emit throttled DAG progress events from worker events.
   * Max 1 update per node per 5 seconds to prevent flooding.
   * Terminal events (done/error) always pass through.
   */
  private emitThrottledDAGProgress(event: WorkerEvent, workflowId: string): void {
    if (!this.callbacks.onDAGProgress) return;

    const nodeId = event.nodeId;
    const throttleKey = `${workflowId}:${nodeId}`;
    const now = Date.now();
    const lastEmit = this.progressThrottleMap.get(throttleKey) ?? 0;

    const isTerminal = event.type === 'done' || event.type === 'error';
    if (!isTerminal && now - lastEmit < 5_000) return;

    this.progressThrottleMap.set(throttleKey, now);
    // Cleanup old entries
    if (isTerminal) this.progressThrottleMap.delete(throttleKey);

    const wf = this.activeWorkflows.get(workflowId);
    const state = wf?.executor.getState();
    const nodeState = state?.nodes?.[nodeId];

    let status: 'started' | 'progress' | 'done' | 'error' = 'progress';
    if (event.type === 'done') status = 'done';
    else if (event.type === 'error') status = 'error';
    else if (lastEmit === 0) status = 'started';

    this.callbacks.onDAGProgress({
      workflowId,
      nodeId,
      nodeLabel: nodeState?.label ?? nodeId,
      status,
      message: event.message ?? event.thinking?.slice(0, 100),
      progress: event.progress ?? nodeState?.progress,
      layerProgress: state ? {
        completed: state.completedLayers,
        total: state.totalLayers,
      } : undefined,
    });
  }

  // ── Completion ──────────────────────────────────────────────────

  /** Process workflow completion, emit summary text. */
  private async onExecutionComplete(
    result: ExecutionResult,
    workflowId: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    const wf = this.activeWorkflows.get(workflowId);

    if (this.memory.retention && this.memory.projectBank) {
      this.memory.retention.retainWorkflowOutcome({
        bankId: this.memory.projectBank,
        workflowId: result.workflowId,
        taskSummary: result.taskSummary,
        workerCount: result.workerCount,
        durationSec: result.durationSec,
        outputPaths: result.outputPaths,
        nodeOutputPaths: result.nodeOutputPaths,
        decisions: result.decisions,
        findings: result.findings,
        errors: result.errors,
        infraChanges: result.infraChanges,
      }).catch(() => {});
    }

    const { status, findings, errors, taskSummary, decisions, nodeOutputPaths } = result;

    // ── Extract the final worker output (the actual analysis/report) ──
    const finalOutput = this.extractFinalOutput(result);

    // ── Structured text message ─────────────────────────────────────
    const parts: string[] = [];

    let header: string;
    if (status === 'complete') header = 'Workflow complete.';
    else if (status === 'error') header = 'Workflow finished with errors.';
    else header = 'Workflow stopped.';
    parts.push(header);

    parts.push('', `**Task:** ${taskSummary}`);

    if (errors.length > 0) {
      parts.push('', '**Errors:**');
      for (const e of errors.slice(0, 5)) parts.push(`  ${e.worker}: ${e.message}`);
    }

    if (findings.length > 0) {
      parts.push('', '**Key findings:**');
      for (const f of findings.slice(0, 8)) parts.push(`  - ${f}`);
    }

    if (decisions.length > 0) {
      parts.push('', '**Decisions:**');
      for (const d of decisions.slice(0, 5)) parts.push(`  - ${d}`);
    }

    if (finalOutput) {
      parts.push('', finalOutput);
    }

    const summary = parts.join('\n');
    this.callbacks.onText(summary, false, true, workflowId);
    pushHistory({ role: 'assistant', content: `[Workflow result] ${summary}` });

    const completeInfo: DAGCompleteInfo = {
      workflowId,
      status,
      summary: taskSummary,
      output: summary,
      findings: findings.length > 0 ? findings.slice(0, 8) : undefined,
      outputPaths: result.outputPaths.length > 0 ? result.outputPaths : undefined,
      nodeOutputPaths: nodeOutputPaths && Object.keys(nodeOutputPaths).length > 0 ? nodeOutputPaths : undefined,
      durationSec: result.durationSec,
      workerCount: result.workerCount,
      totalCostUsd: result.totalCostUsd ?? result.estimatedCost,
      modelUsage: result.modelUsage && result.modelUsage.length > 0 ? result.modelUsage : undefined,
      toolCallCount: result.toolCallCount,
    };
    this.callbacks.onDAGComplete?.(completeInfo);

    if (wf) this.callbacks.onGraphState(wf.executor.getState());
  }


  private extractFinalOutput(result: ExecutionResult): string | null {
    const MAX_OUTPUT_CHARS = 12_000;

    const truncate = (text: string): string => {
      const trimmed = text.trim();
      if (!trimmed) return '';
      if (trimmed.length > MAX_OUTPUT_CHARS) {
        return trimmed.slice(0, MAX_OUTPUT_CHARS) + '\n\n…(output truncated)';
      }
      return trimmed;
    };

    if (result.nodeFinalResults && Object.keys(result.nodeFinalResults).length > 0) {
      const values = Object.values(result.nodeFinalResults);
      const last = values[values.length - 1];
      if (last && last.trim()) return truncate(last);
    }

    if (result.nodeOutputs && Object.keys(result.nodeOutputs).length > 0) {
      const entries = Object.values(result.nodeOutputs);
      const last = entries[entries.length - 1];
      if (last && last.trim()) return truncate(last);
    }

    return null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Clean up resources for a single completed or stopped workflow.
   * Does not affect sibling workflows.
   */
  private cleanupWorkflow(workflowId: string): void {
    const wf = this.activeWorkflows.get(workflowId);
    if (!wf) return;
    wf.eventUnsubscribe();
    clearInterval(wf.stateSnapshotTimer);
    this.callbacks.onWorkflowEnd?.(workflowId);
    this.activeWorkflows.delete(workflowId);
    this.commands.removeWorkflow(workflowId);
    if (this.memory.retention) {
      this.memory.retention.unregisterWorkflowBank(workflowId);
    }
  }

  /** Clear all pending plans (e.g. on /reset). */
  clearPendingPlans(): void {
    this.pendingPlans.clear();
  }

  /**
   * Stop a specific workflow by ID, or stop all if no ID given.
   */
  stop(workflowId?: string): void {
    if (workflowId) {
      this.activeWorkflows.get(workflowId)?.executor.stop();
    } else {
      for (const [, wf] of this.activeWorkflows) wf.executor.stop();
    }
  }

  /** Stop all running workflows. */
  stopAll(): void {
    for (const [, wf] of this.activeWorkflows) wf.executor.stop();
  }

  // ── Human gate API ──────────────────────────────────────────────

  /** Resolve a pending human gate by ID. */
  resolveGate(gateId: string, approved: boolean): void {
    const gate = this.pendingGates.get(gateId);
    if (!gate) return;
    this.pendingGates.delete(gateId);
    gate.resolve(approved);
    this.callbacks.onText(
      `${approved ? '✅' : '❌'} Gate ${gate.action} [${gate.workflowName}]: ${approved ? 'approved' : 'denied'}`,
      false, true,
    );
  }

  /** Return all pending gate requests as an array. */
  listPendingGates(): HumanGateRequest[] {
    return [...this.pendingGates.values()];
  }

  // ── Checkpoint resume API ───────────────────────────────────────

  /** Scan the checkpoint directory for incomplete workflows from previous sessions. */
  checkForInterruptedWorkflows(): WorkflowCheckpoint[] {
    const mgr = new CheckpointManager(this.config.checkpointDir);
    return mgr.findIncomplete();
  }

  async resumeFromCheckpoint(
    checkpoint: WorkflowCheckpoint,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    const graph = CheckpointManager.graphFromCheckpoint(checkpoint);
    for (const [, node] of graph.nodes) {
      if (node.status === 'running') {
        node.status = 'pending';
        node.startedAt = undefined;
      }
    }

    let restoredState: WorkflowState | undefined;
    try {
      restoredState = await WorkflowState.restore(checkpoint.workflowId, this.config.checkpointDir);
    } catch {
      log.warn(`Could not restore WorkflowState for '${checkpoint.workflowId}' — starting fresh`);
    }

    const plan: PlannerOutput = {
      graph,
      reasoning: `Resuming interrupted workflow from layer ${checkpoint.currentLayer}`,
      estimatedCost: 0,
      estimatedTime: 0,
      summary: checkpoint.task,
    };
    this.callbacks.onText(`Resuming: ${checkpoint.graph.name} (from layer ${checkpoint.currentLayer + 1})`, false, true);
    await this.executePlan(plan, pushHistory, checkpoint.currentLayer, restoredState);
  }

  /** Delete a checkpoint without resuming it. */
  discardInterruptedWorkflow(workflowId: string): void {
    const mgr = new CheckpointManager(this.config.checkpointDir);
    mgr.remove(workflowId);
  }
}
