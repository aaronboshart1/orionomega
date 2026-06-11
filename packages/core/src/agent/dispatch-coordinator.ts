/**
 * @module agent/dispatch-coordinator
 *
 * Thin dispatch contract between {@link MainAgent} and the orchestration
 * engine (Task #237). `OrchestrationBridge` is a large lifecycle coordinator
 * that owns the planner, the executor map, pending-plan/gate/intervention
 * state, and worker-event relay. Most of that is internal machinery; the
 * surface MainAgent actually needs to *drive* a workflow is small.
 *
 * `DispatchCoordinator` captures exactly that surface so callers can depend on
 * the contract rather than on the concrete God-object. The bridge declares
 * `implements DispatchCoordinator`, which keeps the two in lockstep at
 * compile time without changing any runtime behavior.
 *
 * The option types live here (rather than inline on the bridge methods) so the
 * interface and the implementation share a single definition. `ExecutorOverrides`
 * is re-exported from `orchestration-bridge.ts` for backwards-compatible imports.
 */

import type { ExecutorConfig } from '../orchestration/executor.js';
import type { StagedAttachment } from './attachment-staging.js';
import type { SessionRepoSelection } from './coding-dispatch.js';
import type { PlannerOutput, CommitSafetyReport } from '../orchestration/types.js';

/** Append-only chat-history sink threaded through every dispatch entry point. */
export type PushHistory = (entry: { role: string; content: string }) => void;

/**
 * Per-dispatch override for the executor config. Code-mode dispatches use this
 * to pin every CODING_AGENT node's cwd to the per-run checkout path even when
 * the planner LLM forgets to include `cwd` on a node.
 *
 * Kept extremely narrow (only the fields code mode needs to override) so future
 * overrides are added intentionally rather than by accident.
 */
export type ExecutorOverrides = Pick<ExecutorConfig, 'codingRepoDir' | 'stagedAttachments'> & {
  /**
   * Optional cleanup hook invoked AFTER `executor.execute()` returns
   * (regardless of success / failure) and BEFORE `cleanupWorkflow`.
   * Used by Task #196 to merge per-CODING_AGENT-node worktree branches
   * back into the session clone's base branch on success and to prune
   * the worktrees on either outcome. Errors thrown here are caught and
   * surfaced to the user but do not re-throw.
   */
  postExecute?: (success: boolean) => Promise<void>;
  /**
   * Task #197: Coding-mode preamble (Repository block + rules) that the
   * macro-expansion callback passes to the per-phase sub-planner so each
   * sub-DAG inherits the same repo / cwd / branch context. Set by
   * `dispatchCodingWorkflow` only — non-coding dispatches leave this
   * unset and the executor's `macroExpansionCallback` stays unwired.
   */
  codingPreamble?: string;
  /**
   * Task #197: Trusted phase bodies, keyed by `${specRef}::${phaseId}`.
   * The macro-expansion callback looks bodies up here at run-time so
   * the planner's top-level tool output never has to carry phase body
   * text. Built by `dispatchCodingWorkflow` from `prepared.specs` and
   * is only set when at least one referenced spec has parsed phases.
   */
  macroPhaseBodies?: Map<string, { title: string; body: string }>;
};

/** Options accepted by {@link DispatchCoordinator.dispatchFullDAG}. */
export interface DispatchFullDAGOptions {
  requireConfirmation?: boolean;
  executorOverrides?: ExecutorOverrides;
  /**
   * Pre-minted workflow ID. When provided, overrides the planner's
   * randomly-generated `plan.graph.id` so the executor's `getRunDir()`
   * (which is keyed off `graph.id`) and any pre-clone folder share the
   * same identifier.
   */
  workflowId?: string;
  /**
   * Task #192: chat attachments already staged to disk by
   * `MainAgent.handleMessage`. Prepended to the planner task and forwarded
   * to the executor so every worker is told the absolute paths.
   */
  stagedAttachments?: StagedAttachment[];
  /**
   * Hook invoked AFTER planning, BEFORE dispatch. Receives the generated
   * plan so callers can mutate node configs in-place (e.g. Task #196
   * worktree allocation per CODING_AGENT node) and optionally return a
   * `postExecute` callback that runs after the executor finishes.
   */
  onPlanReady?: (plan: PlannerOutput) => Promise<{ postExecute?: (success: boolean) => Promise<void> } | void>;
  /**
   * Task #209: structured commit-safety report from `prepareCodingDispatch`.
   * Threaded through to the executor so it surfaces in `run-summary.md`.
   */
  commitSafety?: CommitSafetyReport;
  /**
   * Architecture/prior-decision context already recalled by the caller.
   * Merged with the memories returned by `recallForPlanning`.
   */
  preRecalledContext?: string;
}

/** Options accepted by {@link DispatchCoordinator.dispatchCodingWorkflow}. */
export interface CodingDispatchOptions {
  stagedAttachments?: StagedAttachment[];
  sessionRepo?: SessionRepoSelection;
}

/**
 * The thin dispatch + lifecycle contract MainAgent depends on to drive
 * workflows. Implemented by `OrchestrationBridge`.
 *
 * Deliberately excludes the bridge's internal collaborators (planner,
 * executor map, event relay, pending-state maps) and its many query helpers —
 * those are implementation detail of the coordinator, not part of the contract
 * a caller needs to start, approve, and stop work.
 */
export interface DispatchCoordinator {
  /** Plan and dispatch a general orchestration request. */
  dispatchFullDAG(task: string, pushHistory: PushHistory, opts?: DispatchFullDAGOptions): Promise<void>;

  /** Resolve repo + plan + dispatch a code-mode request. */
  dispatchCodingWorkflow(task: string, pushHistory: PushHistory, opts?: CodingDispatchOptions): Promise<void>;

  /** Apply a user's approve / reject / modify decision to a pending plan. */
  handlePlanResponse(planId: string, action: string, pushHistory: PushHistory, modification?: string): Promise<void>;

  /** Stop a specific workflow by ID, or all running workflows when omitted. */
  stop(workflowId?: string): void;

  /** Stop every running workflow. */
  stopAll(): void;

  /** Resolve a pending human-gate approval request. */
  resolveGate(gateId: string, approved: boolean): void;

  /** Resolve a pending manual-intervention request with operator input. */
  resolveIntervention(interventionId: string, input: string): void;
}
