/**
 * @module agent/orchestration-bridge
 * Bridges the main agent to the orchestration engine (Planner → Executor).
 *
 * Handles plan generation, execution, worker event relay, and completion processing.
 * Separated from main-agent.ts so orchestration concerns are isolated.
 */

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
import type { MemoryBridge } from './memory-bridge.js';
import type { MainAgentCallbacks } from './main-agent.js';
import { createLogger } from '../logging/logger.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const log = createLogger('orchestration-bridge');

/** Configuration for the orchestration bridge. */
export interface OrchestrationConfig {
  workspaceDir: string;
  checkpointDir: string;
  workerTimeout: number;
  maxRetries: number;
}

/**
 * Manages the lifecycle of workflow planning and execution.
 *
 * Owns: planner, executor, pending plan state, event subscriptions.
 * Delegates: memory recall to MemoryBridge, UI updates to callbacks.
 */
export class OrchestrationBridge {
  private readonly planner: Planner;
  readonly eventBus: EventBus;
  readonly commands: OrchestratorCommands;

  /** The plan currently awaiting user approval. */
  private pendingPlan: PlannerOutput | null = null;
  private pendingPlanId: string | null = null;
  private pendingPlanTask: string | null = null;

  /** The currently running executor. */
  private activeExecutor: GraphExecutor | null = null;
  private eventUnsubscribe: (() => void) | null = null;
  private stateSnapshotTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: OrchestrationConfig,
    private readonly callbacks: MainAgentCallbacks,
    private readonly memory: MemoryBridge,
    private readonly availableSkills: string[],
    model: string,
  ) {
    this.planner = new Planner({ model });
    this.eventBus = new EventBus();
    this.commands = new OrchestratorCommands(null);
  }

  /** Whether there is a pending plan awaiting approval. */
  get hasPendingPlan(): boolean { return this.pendingPlan !== null; }

  /** ID of the pending plan. */
  get pendingId(): string | null { return this.pendingPlanId; }

  /** The active executor (if a workflow is running). */
  get executor(): GraphExecutor | null { return this.activeExecutor; }

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

      this.pendingPlan = plan;
      this.pendingPlanId = plan.graph.id;
      this.pendingPlanTask = task;

      this.callbacks.onThinking('', true, true);
      this.callbacks.onPlan(plan);
      pushHistory({ role: 'assistant', content: `[Plan presented] ${plan.summary}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Planning error', { error: msg });
      this.callbacks.onText(`Failed to generate a plan: ${msg}`, false, true);
    }
  }

  /**
   * Generate a plan and immediately execute it.
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

  /**
   * Handle a plan response (approve, modify, reject).
   */
  async handlePlanResponse(
    planId: string,
    action: string,
    pushHistory: (entry: { role: string; content: string }) => void,
    modification?: string,
  ): Promise<void> {
    if (!this.pendingPlan || this.pendingPlanId !== planId) {
      this.callbacks.onText(
        'That plan is no longer available. It may have expired or been superseded.',
        false, true,
      );
      return;
    }

    switch (action) {
      case 'approve':
        if (this.memory.banks && this.pendingPlanTask) {
          await this.memory.ensureProjectBank(this.pendingPlanTask);
        }
        await this.executePlan(this.pendingPlan, pushHistory);
        break;

      case 'modify': {
        const originalTask = this.pendingPlanTask ?? '';
        const modifiedTask = modification
          ? `${originalTask}\n\nModification: ${modification}`
          : originalTask;
        this.clearPendingPlan();
        this.callbacks.onText('Re-planning with your modifications…', true, true);
        await this.planOnly(modifiedTask, pushHistory);
        break;
      }

      case 'reject':
        this.clearPendingPlan();
        this.callbacks.onText('Plan rejected. What would you like instead?', false, true);
        break;

      default:
        this.callbacks.onText(
          `Unknown plan action: '${action}'. Use approve, modify, or reject.`,
          false, true,
        );
    }
  }

  /**
   * Execute a plan via the GraphExecutor.
   */
  private async executePlan(
    plan: PlannerOutput,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
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

    this.eventUnsubscribe = this.eventBus.subscribe('*', (event) => {
      this.handleWorkerEvent(event);
    });

    this.stateSnapshotTimer = setInterval(() => {
      if (this.activeExecutor) {
        this.callbacks.onGraphState(this.activeExecutor.getState());
      }
    }, 2_000);

    this.callbacks.onText('Workflow started. I\'ll keep you posted on progress.', false, true);
    pushHistory({ role: 'assistant', content: '[Workflow execution started]' });

    try {
      const result = await executor.execute();
      await this.onExecutionComplete(result, pushHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Execution error', { error: msg });
      this.callbacks.onText(`Workflow failed: ${msg}`, false, true);
    } finally {
      this.cleanupExecution();
    }
  }

  /** Handle worker events during execution. */
  private handleWorkerEvent(event: WorkerEvent): void {
    this.callbacks.onEvent(event);
    if (event.type === 'done' || event.type === 'error' || event.type === 'status') {
      if (this.activeExecutor) {
        this.callbacks.onGraphState(this.activeExecutor.getState());
      }
    }
  }

  /** Process workflow completion. */
  private async onExecutionComplete(
    result: ExecutionResult,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
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
      const maxLen = 4000;
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
            const preview = fileContent.length > 2000 ? fileContent.slice(0, 2000) + '\n... [truncated]' : fileContent;
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

    if (this.activeExecutor) {
      this.callbacks.onGraphState(this.activeExecutor.getState());
    }
  }

  /** Clear the pending plan. */
  clearPendingPlan(): void {
    this.pendingPlan = null;
    this.pendingPlanId = null;
    this.pendingPlanTask = null;
  }

  /** Stop and clean up execution. */
  stop(): void {
    if (this.activeExecutor) this.activeExecutor.stop();
    this.cleanupExecution();
  }

  private cleanupExecution(): void {
    if (this.eventUnsubscribe) { this.eventUnsubscribe(); this.eventUnsubscribe = null; }
    if (this.stateSnapshotTimer) { clearInterval(this.stateSnapshotTimer); this.stateSnapshotTimer = null; }
    this.activeExecutor = null;
    this.commands.setExecutor(null as unknown as GraphExecutor);
  }
}
