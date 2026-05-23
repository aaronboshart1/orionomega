/**
 * @module orchestration/coding/dag-adapter
 * Dynamic DAG adaptation for Coding Mode.
 *
 * Implements Section 4.3 runtime DAG mutation strategies:
 *   - `insertDebugNode`    — injected on task failure; routes a debugger
 *                            node before the next attempted retask.
 *   - `insertArchitectReviewNode` — injected on scope expansion; adds an
 *                            architect-review node to validate the expanded
 *                            scope before resuming implementation.
 *   - `escalateToReplan`   — triggered after 2+ validation failures;
 *                            produces a full replan escalation signal.
 *
 * All functions are **pure** — they return a `DagAdaptation` descriptor
 * and/or an `EscalationSignal` without mutating the live DAG. The
 * orchestrator applies the adaptation.
 */

import type { WorkflowNode, NodeStatus } from '../types.js';
import type {
  DagAdaptation,
  DagAdaptationTrigger,
  EscalationSignal,
} from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('dag-adapter');

// ── insertDebugNode ───────────────────────────────────────────────────────────

/** Parameters for {@link insertDebugNode}. */
export interface InsertDebugNodeParams {
  /** The node that failed and triggered this adaptation. */
  failedNode: WorkflowNode;
  /**
   * The error message or failure output from the failed node.
   * Embedded in the debugger node's task prompt.
   */
  errorOutput: string;
  /** Working directory for the debugger agent. */
  cwd: string;
  /** Model to use for the debugger role (default: same as failedNode's model). */
  model?: string;
  /** Budget for the debugger node in USD. */
  maxBudgetUsd?: number;
  /**
   * Retry attempt count for the failed node.
   * At retry >= 1 the orchestrator should have already upgraded to opus
   * via CodingModelResolver, but this is threaded through for context.
   */
  retryAttempt?: number;
}

/**
 * Build a `DagAdaptation` that inserts a debugger node directly after a
 * failed implementation node.
 *
 * The debugger node is wired as:
 *   `impl-debug-<failedNode.id>` depends on `failedNode.dependsOn`
 *   The failed node's downstream successors are rewired to also depend on
 *   the debug node, so the debugger's fix output is visible before they run.
 *
 * The debugger node type is `CODING_AGENT` with `codingRole: 'debugger'`.
 */
export function insertDebugNode(
  dag: WorkflowNode[],
  params: InsertDebugNodeParams,
): DagAdaptation {
  const { failedNode, errorOutput, cwd, model, maxBudgetUsd = 0.50, retryAttempt = 0 } = params;

  const debugNodeId = `impl-debug-${failedNode.id}`;
  const resolvedModel = model ?? failedNode.codingAgent?.model ?? failedNode.codingConfig?.model ?? '';

  const debugTask =
    `Debug the failure in node "${failedNode.id}" (retry attempt ${retryAttempt + 1}).\n\n` +
    `## Original Task\n${failedNode.codingAgent?.task ?? failedNode.codingConfig?.task ?? '(unknown)'}\n\n` +
    `## Failure Output\n\`\`\`\n${errorOutput}\n\`\`\`\n\n` +
    `Diagnose the root cause, apply a minimal targeted fix, and verify the fix does not ` +
    `break adjacent code. Do NOT refactor unrelated code.`;

  const debugNode: WorkflowNode = {
    id: debugNodeId,
    type: 'CODING_AGENT',
    label: `Debug: ${failedNode.label ?? failedNode.id}`,
    dependsOn: failedNode.dependsOn.slice(),
    status: 'pending' as NodeStatus,
    codingAgent: {
      task: debugTask,
      model: resolvedModel,
      cwd,
      maxBudgetUsd,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: {
      task: debugTask,
      model: resolvedModel,
      cwd,
      maxBudgetUsd,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      codingRole: 'debugger',
      fileScope: {
        owned: failedNode.codingConfig?.fileScope?.owned ?? [],
        readable: failedNode.codingConfig?.fileScope?.readable ?? [],
        lockRequired: true,
      },
    },
  };

  // Identify direct successors of the failed node in the current DAG
  const successors = dag
    .filter((n) => n.id !== failedNode.id && n.dependsOn.includes(failedNode.id))
    .map((n) => n.id);

  // Rewire successors to also depend on the debug node
  const rewireDependencies = successors.map((nodeId) => ({
    nodeId,
    addDeps: [debugNodeId],
  }));

  const description =
    `Inserted debugger node "${debugNodeId}" after failed node "${failedNode.id}". ` +
    `Successors rewired: [${successors.join(', ')}].`;

  log.info('dag-adapter: insertDebugNode', { failedNodeId: failedNode.id, debugNodeId, successors });

  return {
    trigger: 'task_failure' as DagAdaptationTrigger,
    failedNodeId: failedNode.id,
    insertNodes: [debugNode],
    rewireDependencies,
    description,
  };
}

// ── insertArchitectReviewNode ─────────────────────────────────────────────────

/** Parameters for {@link insertArchitectReviewNode}. */
export interface InsertArchitectReviewNodeParams {
  /**
   * The implementer node that reported a scope expansion
   * (e.g. emitted `additional_file_needed` signal).
   */
  triggeringNode: WorkflowNode;
  /** Files the implementer determined it additionally needs access to. */
  additionalFiles: string[];
  /** Working directory for the review agent. */
  cwd: string;
  /** Model for the architect-review role (default: triggeringNode's model). */
  model?: string;
  /** Budget for the review node in USD. */
  maxBudgetUsd?: number;
}

/**
 * Build a `DagAdaptation` that inserts an architect-review node when an
 * implementer reports needing files outside its originally assigned cluster.
 *
 * The review node:
 *   - Depends on the triggering implementer node (validates its partial output)
 *   - Is wired before the stitcher / integration node so the stitcher has
 *     authoritative scope information before reconciling
 *   - Uses `codingRole: 'architect'` so it has read-only access to all files
 *     and can amend the implementation plan
 */
export function insertArchitectReviewNode(
  dag: WorkflowNode[],
  params: InsertArchitectReviewNodeParams,
): DagAdaptation {
  const { triggeringNode, additionalFiles, cwd, model, maxBudgetUsd = 0.30 } = params;

  const reviewNodeId = `arch-review-${triggeringNode.id}`;
  const resolvedModel = model ?? triggeringNode.codingAgent?.model ?? triggeringNode.codingConfig?.model ?? '';

  const reviewTask =
    `Review the scope expansion reported by implementer node "${triggeringNode.id}".\n\n` +
    `## Requested Additional Files\n${additionalFiles.map((f) => `- ${f}`).join('\n')}\n\n` +
    `Determine whether the scope expansion is justified:\n` +
    `1. If yes — approve and update the implementation plan to include these files.\n` +
    `2. If no — reject and explain how to complete the task within the original file cluster.\n\n` +
    `Output a brief decision (APPROVE or REJECT) followed by reasoning.`;

  const reviewNode: WorkflowNode = {
    id: reviewNodeId,
    type: 'AGENT',
    label: `Architect Review: ${triggeringNode.label ?? triggeringNode.id}`,
    dependsOn: [triggeringNode.id],
    status: 'pending' as NodeStatus,
    agent: {
      model: resolvedModel,
      task: reviewTask,
    },
    codingConfig: {
      task: reviewTask,
      model: resolvedModel,
      cwd,
      maxBudgetUsd,
      allowedTools: ['Read', 'Glob', 'Grep'],
      codingRole: 'architect',
      fileScope: {
        owned: [],
        readable: additionalFiles,
        lockRequired: false,
      },
    },
  };

  // Rewire the stitcher (or any node that depends on the triggering implementer)
  // to also depend on the architect review so it has the decision before merging.
  const downstreamNodes = dag
    .filter((n) => n.id !== triggeringNode.id && n.dependsOn.includes(triggeringNode.id))
    .map((n) => n.id);

  const rewireDependencies = downstreamNodes.map((nodeId) => ({
    nodeId,
    addDeps: [reviewNodeId],
  }));

  const description =
    `Inserted architect-review node "${reviewNodeId}" after scope expansion in ` +
    `"${triggeringNode.id}". Additional files: [${additionalFiles.join(', ')}]. ` +
    `Downstream rewired: [${downstreamNodes.join(', ')}].`;

  log.info('dag-adapter: insertArchitectReviewNode', {
    triggeringNodeId: triggeringNode.id,
    reviewNodeId,
    additionalFiles,
    downstreamNodes,
  });

  return {
    trigger: 'scope_expansion' as DagAdaptationTrigger,
    failedNodeId: triggeringNode.id,
    insertNodes: [reviewNode],
    rewireDependencies,
    description,
  };
}

// ── escalateToReplan ──────────────────────────────────────────────────────────

/** Parameters for {@link escalateToReplan}. */
export interface EscalateToReplanParams {
  /**
   * The validation-loop node (or any repeatedly-failing node) that triggered
   * the escalation.
   */
  failedNode: WorkflowNode;
  /**
   * Number of consecutive validation failures (must be >= 2 to trigger
   * this escalation per Section 4.3).
   */
  failureCount: number;
  /** Files that were changed during the failed attempts. */
  affectedFiles: string[];
  /**
   * Combined failure output from the validation loop (last N iterations).
   * Used to populate the EscalationSignal reason.
   */
  failureOutput: string;
  /**
   * Optional suggested approach from the validation-loop context
   * (e.g. "try upgrading the test framework version").
   */
  suggestedApproach?: string;
}

/**
 * Build a `DagAdaptation` + `EscalationSignal` for a full replan when
 * validation has failed 2 or more consecutive times.
 *
 * Unlike `insertDebugNode`, this does not inject a targeted fix node.
 * Instead it:
 *   1. Produces an `EscalationSignal` for the orchestrator to surface to
 *      the user / planner model.
 *   2. Returns a `DagAdaptation` with `trigger: 'validation_escalation'`
 *      and empty `insertNodes` / `rewireDependencies` — the orchestrator
 *      uses this as the signal to suspend execution and request a replan.
 */
export function escalateToReplan(params: EscalateToReplanParams): {
  adaptation: DagAdaptation;
  signal: EscalationSignal;
} {
  const { failedNode, failureCount, affectedFiles, failureOutput, suggestedApproach } = params;

  if (failureCount < 2) {
    throw new Error(
      `escalateToReplan: failureCount must be >= 2 (got ${failureCount}). ` +
      `Use insertDebugNode for the first failure.`,
    );
  }

  const reason =
    `Validation failed ${failureCount} consecutive time(s) for node "${failedNode.id}". ` +
    `Last failure output:\n${failureOutput.slice(0, 2000)}${failureOutput.length > 2000 ? '\n...[truncated]' : ''}`;

  const signal: EscalationSignal = {
    type: 'replan_required',
    reason,
    affectedFiles,
    suggestedApproach:
      suggestedApproach ??
      'Review the implementation approach and consider restructuring the affected files ' +
      'or relaxing validation constraints if they are overly strict.',
  };

  const description =
    `Escalating to replan after ${failureCount} consecutive validation failures ` +
    `in node "${failedNode.id}". Affected files: [${affectedFiles.join(', ')}].`;

  log.warn('dag-adapter: escalateToReplan', {
    failedNodeId: failedNode.id,
    failureCount,
    affectedFiles,
  });

  const adaptation: DagAdaptation = {
    trigger: 'validation_escalation' as DagAdaptationTrigger,
    failedNodeId: failedNode.id,
    insertNodes: [],
    rewireDependencies: [],
    description,
  };

  return { adaptation, signal };
}
