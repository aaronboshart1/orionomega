/**
 * @module orchestration/coding/templates/review-iterate
 * DAG template: diff-analysis → code-review → fix(N) → re-review → validate → report
 *
 * Use case: PR review, code quality improvement, addressing review feedback.
 * The re-review node can loop back to Layer 2 if issues persist (max 2 outer iterations).
 */

import type { WorkflowNode } from '../../types.js';
import type { CodingNodeConfig } from '../coding-types.js';

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
  maxTurns: {
    scanner: number;
    reviewer: number;
    fixer: number;
    reporter: number;
  };
  validationCommands?: string[];
  validationMaxRetries?: number;
}

export function buildReviewIterateTemplate(params: ReviewIterateParams): WorkflowNode[] {
  const {
    task,
    cwd,
    models,
    budgets,
    maxTurns,
    validationCommands = [],
    validationMaxRetries = 2,
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
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    codingConfig: {
      task: `Diff analysis: ${task}`,
      model: models.scanner,
      cwd,
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      codingRole: 'codebase-scanner',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  // ── Layer 1: Code Review ──────────────────────────────────────────────────

  const codeReview: WorkflowNode = {
    id: 'code-review',
    type: 'AGENT',
    label: 'Code Review',
    dependsOn: ['diff-analysis'],
    status: 'pending',
    agent: {
      model: models.reviewer,
      task: `Perform a thorough code review.\n\nContext: ${task}\n\nReview for:\n- Correctness and logic errors\n- Security vulnerabilities\n- Performance issues\n- Code style and maintainability\n- Missing tests\n\nOutput a FanOutDecision JSON where each chunk represents an independent set of review findings to fix in parallel.`,
    },
    codingConfig: {
      task: `Code review: ${task}`,
      model: models.reviewer,
      cwd,
      maxTurns: maxTurns.reviewer,
      maxBudgetUsd: budgets.reviewer,
      allowedTools: ['Read', 'Glob', 'Grep'],
      codingRole: 'reviewer',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  // ── Layer 2: Fix Placeholder (fans out) ───────────────────────────────────

  const fixPlaceholder: WorkflowNode = {
    id: 'impl-placeholder',
    type: 'CODING_AGENT',
    label: 'Fix Review Findings (fan-out pending)',
    dependsOn: ['code-review'],
    status: 'pending',
    codingAgent: {
      task: `Fix the assigned review findings for: ${task}`,
      model: models.fixer,
      cwd,
      maxTurns: maxTurns.fixer,
      maxBudgetUsd: budgets.fixer,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: {
      task: `Fix review findings: ${task}`,
      model: models.fixer,
      cwd,
      maxTurns: maxTurns.fixer,
      maxBudgetUsd: budgets.fixer,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      codingRole: 'implementer',
      fileScope: { owned: [], readable: [], lockRequired: true },
    },
  };

  // ── Layer 3: Re-Review ────────────────────────────────────────────────────

  const reReview: WorkflowNode = {
    id: 're-review',
    type: 'AGENT',
    label: 'Re-Review',
    dependsOn: ['impl-placeholder'],
    status: 'pending',
    agent: {
      model: models.reviewer,
      task: `Verify that all review findings from the previous code review have been properly addressed.\n\nOriginal task: ${task}\n\nCheck each finding was fixed. Note any remaining issues or regressions introduced by the fixes.`,
    },
    codingConfig: {
      task: `Re-review: ${task}`,
      model: models.reviewer,
      cwd,
      maxTurns: maxTurns.reviewer,
      maxBudgetUsd: budgets.reviewer,
      allowedTools: ['Read', 'Glob', 'Grep'],
      codingRole: 'reviewer',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  // ── Layer 4: Validation Loop ──────────────────────────────────────────────

  const validationLoop: WorkflowNode = {
    id: 'validation-loop',
    type: 'LOOP',
    label: 'Validation Loop',
    dependsOn: ['re-review'],
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
      ],
      maxIterations: validationMaxRetries + 1,
      exitCondition: { type: 'all_pass' },
      carryForward: true,
    },
    codingConfig: {
      task: 'Validate review fixes',
      codingRole: 'validator',
      fileScope: { owned: [], readable: [], lockRequired: false },
      validationConfig: { commands: validationCommands, maxRetries: validationMaxRetries, timeout: 120_000 },
    },
  };

  // ── Layer 5: Summary Report ───────────────────────────────────────────────

  const summaryReport: WorkflowNode = {
    id: 'summary-report',
    type: 'AGENT',
    label: 'Summary Report',
    dependsOn: ['validation-loop'],
    status: 'pending',
    agent: {
      model: models.reporter,
      task: `Write a review iteration summary for: ${task}\n\nInclude: findings addressed, files changed, validation results, remaining concerns if any.`,
    },
    codingConfig: {
      task: `Summarize review: ${task}`,
      model: models.reporter,
      cwd,
      maxTurns: maxTurns.reporter,
      maxBudgetUsd: budgets.reporter,
      allowedTools: ['Read'],
      codingRole: 'reporter',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  return [diffAnalysis, codeReview, fixPlaceholder, reReview, validationLoop, summaryReport];
}
