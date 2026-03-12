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
import type {
  PlannerOutput,
  WorkerEvent,
  GraphState,
  ExecutionResult,
  WorkflowCheckpoint,
} from '../orchestration/types.js';
import type { MemoryBridge } from './memory-bridge.js';
import type { MainAgentCallbacks } from './main-agent.js';
import { createLogger } from '../logging/logger.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

  /** Whether there are any human gate requests awaiting approval. */
  get hasPendingGates(): boolean { return this.pendingGates.size > 0; }

  // ── Plan generation ─────────────────────────────────────────────

  /**
   * Generate a plan and present it to the user (without executing).
   */
  async planOnly(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    this.callbacks.onThinking('Analysing your request and building an execution plan…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      });

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
    this.callbacks.onThinking('Planning and executing immediately…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      });
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
  ): Promise<void> {
    const workflowId = plan.graph.id;
    const workflowName = plan.graph.name;

    // Remove from pending (it's now moving to execution)
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

    const executor = new GraphExecutor(plan.graph, this.eventBus, executorConfig);

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

    this.callbacks.onText('Workflow started. I\'ll keep you posted on progress.', false, true);
    pushHistory({ role: 'assistant', content: '[Workflow execution started]' });

    try {
      const result = await executor.execute();
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

  /** Relay a worker event to callbacks, also triggering a state snapshot. */
  private handleWorkerEvent(event: WorkerEvent, workflowId: string): void {
    this.callbacks.onEvent(event);
    if (event.type === 'done' || event.type === 'error' || event.type === 'status') {
      const wf = this.activeWorkflows.get(workflowId);
      if (wf) this.callbacks.onGraphState(wf.executor.getState());
    }
  }

  // ── Completion ──────────────────────────────────────────────────

  /** Process workflow completion, emit summary text. */
  private async onExecutionComplete(
    result: ExecutionResult,
    workflowId: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    const wf = this.activeWorkflows.get(workflowId);

    // Retain workflow outcome (fire-and-forget)
    if (this.memory.retention && this.memory.projectBank) {
      this.memory.retention.retainWorkflowOutcome({
        bankId: this.memory.projectBank,
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

    const { status, durationSec, workerCount, findings, errors, taskSummary, outputPaths, decisions, nodeOutputs } = result;
    const lines: string[] = [];

    if (status === 'complete') lines.push('✅ Workflow complete.');
    else if (status === 'error') lines.push('⚠️ Workflow finished with errors.');
    else lines.push('🛑 Workflow stopped.');

    // Primary answer from exit node
    const nodeOutputEntries = nodeOutputs ? Object.entries(nodeOutputs) : [];
    if (nodeOutputEntries.length > 0) {
      const [, lastOutput] = nodeOutputEntries[nodeOutputEntries.length - 1];
      const maxLen = 32000;
      lines.push('');
      lines.push(lastOutput.length > maxLen ? lastOutput.slice(0, maxLen) + '\n\n... [truncated]' : lastOutput);
    } else if (taskSummary) {
      lines.push('');
      lines.push(taskSummary);
    }

    if (findings.length > 0) {
      lines.push('', '**Key findings:**');
      for (const f of findings.slice(0, 8)) lines.push(`  • ${f}`);
    }

    if (decisions.length > 0) {
      lines.push('', '**Decisions:**');
      for (const d of decisions.slice(0, 5)) lines.push(`  • ${d}`);
    }

    if (outputPaths.length > 0) {
      lines.push('', '**Output files:**');
      for (const p of outputPaths) {
        lines.push(`  📄 ${p}`);
        try {
          const resolved = p.startsWith('/') ? p : `${this.config.workspaceDir}/${p}`;
          if (existsSync(resolved)) {
            const fileContent = await readFile(resolved, 'utf-8');
            const preview = fileContent.length > 8000 ? fileContent.slice(0, 8000) + '\n... [truncated]' : fileContent;
            lines.push('', '```', preview, '```');
          }
        } catch { /* non-fatal */ }
      }
    }

    if (errors.length > 0) {
      lines.push('', '**Errors:**');
      for (const e of errors.slice(0, 5)) lines.push(`  ❌ ${e.worker}: ${e.message}`);
    }

    lines.push('', `⏱️ ${durationSec.toFixed(1)}s | ${workerCount} workers`);

    const summary = lines.join('\n');
    this.callbacks.onText(summary, false, true);
    pushHistory({ role: 'assistant', content: `[Workflow result] ${summary}` });

    // Final state snapshot
    if (wf) this.callbacks.onGraphState(wf.executor.getState());
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

  /** Resume a workflow from a checkpoint. Re-executes the full graph. */
  async resumeFromCheckpoint(
    checkpoint: WorkflowCheckpoint,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    const graph = CheckpointManager.graphFromCheckpoint(checkpoint);
    // Reset any nodes stuck in 'running' state back to pending
    for (const [, node] of graph.nodes) {
      if (node.status === 'running') {
        node.status = 'pending';
        node.startedAt = undefined;
      }
    }
    const plan: PlannerOutput = {
      graph,
      reasoning: `Resuming interrupted workflow from layer ${checkpoint.currentLayer}`,
      estimatedCost: 0,
      estimatedTime: 0,
      summary: checkpoint.task,
    };
    // Remove the checkpoint so we don't prompt to resume again
    const mgr = new CheckpointManager(this.config.checkpointDir);
    mgr.remove(checkpoint.workflowId);
    this.callbacks.onText(`Resuming: ${checkpoint.graph.name}`, false, true);
    await this.executePlan(plan, pushHistory);
  }

  /** Delete a checkpoint without resuming it. */
  discardInterruptedWorkflow(workflowId: string): void {
    const mgr = new CheckpointManager(this.config.checkpointDir);
    mgr.remove(workflowId);
  }
}
