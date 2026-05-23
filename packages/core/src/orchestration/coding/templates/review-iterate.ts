/**
 * @module orchestration/coding/templates/review-iterate
 * DAG template: diff-analysis → review-loop(max=3)[code-review → fix(N) → re-review → validate] → report
 *
 * Use case: PR review, code quality improvement, addressing review feedback.
 * The outer review loop iterates up to 3 times until all review findings are addressed.
 */

import type { WorkflowNode } from '../../types.js';
import { buildReviewGateNode } from '../review-gate.js';
import type { ReviewGateNodeParams } from '../review-gate.js';

export interface ReviewIterateParams {
  task: string;
  cwd: string;
  models: {
    scanner: string;
    reviewer: string;
    fixer: string;
    reporter: string;
  };
  budgets: {
    scanner: number;
    reviewer: number;
    fixer: number;
    reporter: number;
  };
  validationCommands?: string[];
  validationMaxRetries?: number;
  /**
   * Per-command wall-clock budget (ms) for validation steps. Sourced from
   * `orchestration.validationTimeout` in the user's config. Defaults to 5 min.
   */
  validationTimeoutMs?: number;
  /**
   * Optional review-gate configuration.  Review-iterate sessions are medium
   * risk by default — they may touch many files across the codebase.
   */
  reviewGate?: Pick<ReviewGateNodeParams, 'complexityTier' | 'filesChanged' | 'manualReviewRequired'>;
}

export function buildReviewIterateTemplate(params: ReviewIterateParams): WorkflowNode[] {
  const {
    task,
    cwd,
    models,
    budgets,
    validationCommands = [],
    validationMaxRetries = 2,
    validationTimeoutMs = 300_000,
    reviewGate,
  } = params;

  // ── Layer 0: Diff Analysis ────────────────────────────────────────────────

  const diffAnalysis: WorkflowNode = {
    id: 'diff-analysis',
    type: 'CODING_AGENT',
    label: 'Diff Analysis',
    dependsOn: [],
    status: 'pending',
    codingAgent: {
      task: `Analyze the code changes to understand scope and context for review.\n\nReview task: ${task}\n\nCapture:\n- Summary of changes\n- Files modified\n- Complexity and risk areas\n- Dependencies affected`,
      model: models.scanner,
      cwd,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    codingConfig: {
      task: `Diff analysis: ${task}`,
      model: models.scanner,
      cwd,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      codingRole: 'codebase-scanner',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  // ── Layers 1-4: Outer Review Loop (max 3 iterations) ─────────────────────
  //
  // The review loop wraps code-review → fix(fan-out) → re-review → validation
  // into a repeating cycle. After each iteration an LLM judge evaluates the
  // re-review output to decide whether all findings are resolved or another
  // iteration is needed. Exits early when all issues are addressed (max 3).

  const innerValidationLoop: WorkflowNode = {
    id: 'validation-loop',
    type: 'LOOP',
    label: 'Validation Loop',
    dependsOn: [],   // Sequential within outer loop body
    status: 'pending',
    loop: {
      body: [
        {
          id: 'validator',
          type: 'TOOL',
          label: 'Run Tests',
          dependsOn: [],
          status: 'pending',
          tool: { name: 'SHELL_SEQUENCE', params: { commands: validationCommands, cwd } },
        },
        {
          id: 'debugger',
          type: 'CODING_AGENT',
          label: 'Debug Failures',
          dependsOn: ['validator'],
          status: 'pending',
          codingAgent: {
            task: `Fix the failing tests and build errors identified by the validator.\n\nReview task: ${task}\n\nAnalyze the error output, identify root causes, and make the minimal changes needed to make the validation pass.`,
            model: models.fixer,
            cwd,
            maxBudgetUsd: budgets.fixer,
            allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          },
          codingConfig: {
            task: `Fix validation failures: ${task}`,
            model: models.fixer,
            cwd,
            maxBudgetUsd: budgets.fixer,
            allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
            codingRole: 'debugger',
            fileScope: { owned: [], readable: [], lockRequired: true },
          },
        },
      ],
      maxIterations: validationMaxRetries + 1,
      exitCondition: { type: 'all_pass' },
      carryForward: true,
    },
    codingConfig: {
      task: 'Validate review fixes',
      codingRole: 'validator',
      fileScope: { owned: [], readable: [], lockRequired: false },
      validationConfig: { commands: validationCommands, maxRetries: validationMaxRetries, timeout: validationTimeoutMs },
    },
  };

  const reviewLoop: WorkflowNode = {
    id: 'review-loop',
    type: 'LOOP',
    label: 'Review Iteration Loop',
    dependsOn: ['diff-analysis'],
    status: 'pending',
    loop: {
      // Body executes sequentially in order: review → fix → re-review → validate
      body: [
        {
          id: 'code-review',
          type: 'AGENT',
          label: 'Code Review',
          dependsOn: [],
          status: 'pending',
          agent: {
            model: models.reviewer,
            task: `Perform a thorough code review.\n\nContext: ${task}\n\nReview for:\n- Correctness and logic errors\n- Security vulnerabilities\n- Performance issues\n- Code style and maintainability\n- Missing tests\n\nOutput a FanOutDecision JSON where each chunk represents an independent set of review findings to fix in parallel.`,
          },
          codingConfig: {
            task: `Code review: ${task}`,
            model: models.reviewer,
            cwd,
            maxBudgetUsd: budgets.reviewer,
            allowedTools: ['Read', 'Glob', 'Grep'],
            codingRole: 'reviewer',
            fileScope: { owned: [], readable: [], lockRequired: false },
          },
        },
        {
          id: 'impl-placeholder',
          type: 'CODING_AGENT',
          label: 'Fix Review Findings (fan-out pending)',
          dependsOn: [],
          status: 'pending',
          codingAgent: {
            task: `Fix the assigned review findings for: ${task}`,
            model: models.fixer,
            cwd,
            maxBudgetUsd: budgets.fixer,
            allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          },
          codingConfig: {
            task: `Fix review findings: ${task}`,
            model: models.fixer,
            cwd,
            maxBudgetUsd: budgets.fixer,
            allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
            codingRole: 'implementer',
            fileScope: { owned: [], readable: [], lockRequired: true },
          },
        },
        {
          id: 're-review',
          type: 'AGENT',
          label: 'Re-Review',
          dependsOn: [],
          status: 'pending',
          agent: {
            model: models.reviewer,
            task: `Verify that all review findings from the previous code review have been properly addressed.\n\nOriginal task: ${task}\n\nCheck each finding was fixed. Note any remaining issues or regressions introduced by the fixes. If all issues are resolved, state "EXIT: all findings addressed".`,
          },
          codingConfig: {
            task: `Re-review: ${task}`,
            model: models.reviewer,
            cwd,
            maxBudgetUsd: budgets.reviewer,
            allowedTools: ['Read', 'Glob', 'Grep'],
            codingRole: 'reviewer',
            fileScope: { owned: [], readable: [], lockRequired: false },
          },
        },
        innerValidationLoop,
      ],
      maxIterations: 3,
      exitCondition: {
        type: 'llm_judge',
        judgePrompt: 'Have all code review findings been properly addressed and do all tests pass? If yes, answer EXIT. If there are remaining issues or test failures, answer CONTINUE.',
      },
      carryForward: true,
    },
    codingConfig: {
      task: `Review iteration cycle: ${task}`,
      codingRole: 'reviewer',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  // ── Layer 5: Review Gate ──────────────────────────────────────────────────

  const reviewGateNode = buildReviewGateNode({
    cwd,
    dependsOn: ['review-loop'],
    // Review-iterate sessions are medium risk — may touch many files
    complexityTier: reviewGate?.complexityTier ?? 'medium',
    filesChanged: reviewGate?.filesChanged ?? [],
    manualReviewRequired: reviewGate?.manualReviewRequired ?? false,
    approvedNextNode: 'summary-report',
    blockedNextNode: 'summary-report',
  });

  // ── Layer 6: Summary Report ───────────────────────────────────────────────

  const summaryReport: WorkflowNode = {
    id: 'summary-report',
    type: 'AGENT',
    label: 'Summary Report',
    dependsOn: ['review-gate'],
    status: 'pending',
    agent: {
      model: models.reporter,
      task: `Write a review iteration summary for: ${task}\n\nInclude: findings addressed, files changed, validation results, remaining concerns if any.`,
    },
    codingConfig: {
      task: `Summarize review: ${task}`,
      model: models.reporter,
      cwd,
      maxBudgetUsd: budgets.reporter,
      allowedTools: ['Read'],
      codingRole: 'reporter',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  return [diffAnalysis, reviewLoop, reviewGateNode, summaryReport];
}
