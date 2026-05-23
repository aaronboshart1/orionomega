/**
 * @module orchestration/coding/planning-schemas
 * Extended planning types for the architect's structured output.
 *
 * This module adds the spec-accurate `CodingTask` / `PlanningDecision`
 * types (Section 4.3 — The FanOutDecision Schema) and the planning
 * constraint validator. Review, approval, risk, and test-result types
 * are defined in `coding-types.ts` and re-exported here for convenience.
 *
 * NOTE ON NAMING:
 *   `coding-types.ts` exports a `FanOutDecision` that uses `chunks[]` —
 *   the execution-engine representation. `PlanningDecision` here is the
 *   richer architect output (spec §4.3) with `tasks[]`, dependency maps,
 *   shared context, and test strategy. `fanout-expansion.ts` translates
 *   between the two formats.
 */

// Re-export related types from their canonical modules so consumers can
// import everything planning-related from a single location.
export type {
  RiskTier,
  ReviewIssue,
  ReviewResult,
  FileChange,
  ApprovalPackage,
  EscalationSignal,
} from './coding-types.js';

export type { TestFailure, TestResults } from './test-result-parser.js';

// ── CodingTask ────────────────────────────────────────────────────────────────

/**
 * A single concrete implementation goal inside a PlanningDecision.
 *
 * Each task maps to one CODING_AGENT node in the execution DAG.
 * The architect produces this list; the planner materialises it into
 * `FanOutDecision.chunks` that the executor understands.
 *
 * From spec Section 4.3 — The FanOutDecision Schema.
 */
export interface CodingTask {
  /** Stable identifier, e.g. "impl-chunk-0". Used in `dependencies` and `fileAssignments`. */
  id: string;
  /** Short human-readable title, e.g. "Route handler and controller". */
  title: string;
  /**
   * Detailed implementation instructions for the agent.
   * Should be specific enough to implement without further clarification.
   */
  description: string;
  /** The specialized coding role assigned to execute this task. */
  role: 'implementer' | 'test-writer' | 'integrator';
  /**
   * Files this task will write to exclusively.
   * Planning constraint: no file may appear in two tasks' targetFiles.
   */
  targetFiles: string[];
  /** Files this task reads for context but does not modify. */
  contextFiles: string[];
  /**
   * Estimated lines of code changed.
   * Planning constraint: must be ≤ 150 LOC per task.
   */
  estimatedLOC: number;
  /**
   * Task priority class.
   *   critical-path — on the longest dependency chain; schedule first
   *   parallel       — no inter-task dependency; can run concurrently
   *   optional       — nice-to-have; may be deferred on budget pressure
   */
  priority: 'critical-path' | 'parallel' | 'optional';
  /**
   * Concrete, testable acceptance criteria.
   * Checked by the architect-reviewer after implementation.
   */
  acceptanceCriteria: string[];
}

// ── PlanningDecision ──────────────────────────────────────────────────────────

/**
 * The full planning artifact produced by the architect agent.
 *
 * This is the richest representation of the implementation plan and is the
 * direct JSON output of the architect's structured response. The orchestrator
 * translates it into the execution-engine's `FanOutDecision` (chunks format)
 * via `fanout-expansion.ts`.
 *
 * From spec Section 4.3 — The FanOutDecision Schema (renamed `PlanningDecision`
 * here to avoid collision with the execution-engine `FanOutDecision` type in
 * `coding-types.ts`).
 */
export interface PlanningDecision {
  /** Overall strategy narrative — explains *why* this decomposition was chosen. */
  approach: string;

  /**
   * Ordered list of implementation tasks.
   * Every modified file must be covered by exactly one task (no overlaps).
   * Every task must have at least one acceptance criterion.
   */
  tasks: CodingTask[];

  /**
   * Dependency edges: taskId → taskIds that must complete first.
   * Must form a DAG (no cycles). Absent = no dependencies (all parallel).
   *
   * Example: `{ "impl-chunk-0": ["impl-chunk-1", "impl-chunk-2"] }`
   * means chunk-0 can only start after chunk-1 AND chunk-2 are done.
   */
  dependencies: Map<string, string[]>;

  /**
   * Exclusive file ownership map: taskId → files[] this task may write to.
   * A file must NOT appear in two tasks' assignments.
   */
  fileAssignments: Map<string, string[]>;

  /** Context shared across all tasks; injected into every agent's system prompt. */
  sharedContext: {
    /** Key shared type / interface definitions the tasks must agree on. */
    interfaces: string[];
    /** Project coding standards and idioms to follow. */
    conventions: string[];
    /** Hard constraints, e.g. "Validation runs BEFORE database write". */
    constraints: string[];
  };

  /** Test coverage strategy for the implementation. */
  testStrategy: {
    /** Task IDs that need accompanying unit tests. */
    unitTestTasks: string[];
    /** Integration test files to create/update after implementation. */
    integrationTestFiles: string[];
    /** Optional end-to-end test scenarios. */
    e2eScenarios?: string[];
  };

  /** Risk assessment for the implementation. */
  risks: {
    /** Files where mistakes are especially costly (e.g. auth, DB migrations). */
    highRiskFiles: string[];
    /** How to undo all changes if the implementation fails. */
    rollbackPlan: string;
    /**
     * When true, the review-gate ROUTER must pause for explicit human approval
     * regardless of the auto-approve risk level setting.
     */
    manualReviewRequired: boolean;
  };
}

// ── Planning Constraint Validation ────────────────────────────────────────────

/** A single planning constraint violation. */
export interface PlanningViolation {
  /** Machine-readable constraint that was violated. */
  constraint:
    | 'max_loc_exceeded'
    | 'file_overlap'
    | 'dependency_cycle'
    | 'uncovered_file'
    | 'missing_acceptance_criteria'
    | 'empty_tasks';
  /** Human-readable description of the violation. */
  message: string;
  /** Task IDs involved in the violation. */
  taskIds: string[];
}

/** Result of validatePlanningDecision(). */
export interface PlanningValidationResult {
  /** Whether the plan satisfies all constraints. */
  valid: boolean;
  /** All constraint violations found (empty when valid=true). */
  violations: PlanningViolation[];
}

/**
 * Validates a PlanningDecision against the planning constraints from spec Section 4.3.
 *
 * Enforced constraints:
 *   1. No task exceeds 150 LOC estimated change
 *   2. No file appears in multiple tasks' fileAssignments (no overlaps)
 *   3. Dependencies form a DAG (no cycles — DFS-based detection)
 *   4. Every fileAssignment key is a valid task ID
 *   5. Every task has at least one acceptance criterion
 *   6. tasks array is non-empty
 *
 * All violations are collected before returning (not fail-fast), so callers
 * receive the complete picture for error reporting.
 *
 * @param plan - The PlanningDecision to validate.
 * @returns Validation result with all violations.
 */
export function validatePlanningDecision(plan: PlanningDecision): PlanningValidationResult {
  const violations: PlanningViolation[] = [];

  // ── Constraint 6: non-empty tasks ───────────────────────────────────────────
  if (plan.tasks.length === 0) {
    violations.push({
      constraint: 'empty_tasks',
      message: 'PlanningDecision must contain at least one task.',
      taskIds: [],
    });
    // Return early — further checks are meaningless on an empty plan.
    return { valid: false, violations };
  }

  const taskIds = new Set(plan.tasks.map((t) => t.id));

  // ── Constraint 1: max 150 LOC per task ──────────────────────────────────────
  for (const task of plan.tasks) {
    if (task.estimatedLOC > 150) {
      violations.push({
        constraint: 'max_loc_exceeded',
        message:
          `Task "${task.id}" estimates ${task.estimatedLOC} LOC, ` +
          `exceeding the 150 LOC limit. Split into smaller tasks.`,
        taskIds: [task.id],
      });
    }
  }

  // ── Constraint 2: no file overlap in fileAssignments ────────────────────────
  const fileOwner = new Map<string, string>(); // file → first taskId
  for (const [taskId, files] of plan.fileAssignments) {
    for (const file of files) {
      const prior = fileOwner.get(file);
      if (prior !== undefined) {
        violations.push({
          constraint: 'file_overlap',
          message:
            `File "${file}" is assigned to both "${prior}" and "${taskId}". ` +
            `Each file may only appear in one task's fileAssignments.`,
          taskIds: [prior, taskId],
        });
      } else {
        fileOwner.set(file, taskId);
      }
    }
  }

  // ── Constraint 3: dependency DAG — no cycles (DFS) ──────────────────────────
  const WHITE = 0, GRAY = 1, BLACK = 2;
  type Color = 0 | 1 | 2;
  const color = new Map<string, Color>();
  for (const id of taskIds) color.set(id, WHITE);

  const dfsVisit = (nodeId: string, path: string[]): void => {
    color.set(nodeId, GRAY);
    for (const dep of (plan.dependencies.get(nodeId) ?? [])) {
      if ((color.get(dep) ?? WHITE) === GRAY) {
        const cycle = [...path, nodeId, dep].join(' → ');
        violations.push({
          constraint: 'dependency_cycle',
          message: `Dependency cycle detected: ${cycle}`,
          taskIds: [...path, nodeId, dep],
        });
        return; // Abort this DFS branch to avoid infinite recursion
      }
      if ((color.get(dep) ?? WHITE) === WHITE) {
        dfsVisit(dep, [...path, nodeId]);
      }
    }
    color.set(nodeId, BLACK);
  };

  for (const id of taskIds) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      dfsVisit(id, []);
    }
  }

  // ── Constraint 4: all fileAssignment keys are valid task IDs ─────────────────
  for (const taskId of plan.fileAssignments.keys()) {
    if (!taskIds.has(taskId)) {
      violations.push({
        constraint: 'uncovered_file',
        message:
          `fileAssignments references task ID "${taskId}" which does not exist in tasks[].`,
        taskIds: [taskId],
      });
    }
  }

  // ── Constraint 5: every task has at least one acceptance criterion ────────────
  for (const task of plan.tasks) {
    if (task.acceptanceCriteria.length === 0) {
      violations.push({
        constraint: 'missing_acceptance_criteria',
        message:
          `Task "${task.id}" has no acceptance criteria. ` +
          `Every task must have at least one testable criterion.`,
        taskIds: [task.id],
      });
    }
  }

  return { valid: violations.length === 0, violations };
}
