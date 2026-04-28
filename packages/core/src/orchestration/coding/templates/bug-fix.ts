/**
 * @module orchestration/coding/templates/bug-fix
 * DAG template: reproduce → root-cause → fix → regression-test → validate → report
 *
 * Use case: Debugging, fixing errors, resolving issues.
 * Sequential by nature — each step depends on the previous diagnosis.
 */

import type { WorkflowNode } from '../../types.js';
import type { CodingNodeConfig } from '../coding-types.js';

export interface BugFixParams {
  /** Description of the bug, including error messages and reproduction steps. */
  task: string;
  /** Working directory for all agents. */
  cwd: string;
  models: {
    scanner: string;
    rootCause: string;
    fixer: string;
    testWriter: string;
    reporter: string;
  };
  budgets: {
    scanner: number;
    rootCause: number;
    fixer: number;
    testWriter: number;
    reporter: number;
  };
  maxTurns: {
    scanner: number;
    rootCause: number;
    fixer: number;
    testWriter: number;
    reporter: number;
  };
  validationCommands?: string[];
  validationMaxRetries?: number;
  /**
   * Per-command wall-clock budget (ms) for build/test/lint commands.
   * Sourced from `orchestration.validationTimeout` in the user's config so
   * monorepos that need >5 min for `pnpm -r build` can raise it without
   * editing template code. Defaults to 300_000 (5 min).
   */
  validationTimeoutMs?: number;
}

/**
 * Builds the bug-fix DAG template.
 */
export function buildBugFixTemplate(params: BugFixParams): WorkflowNode[] {
  const {
    task,
    cwd,
    models,
    budgets,
    maxTurns,
    validationCommands = [],
    validationMaxRetries = 2,
    validationTimeoutMs = 300_000,
  } = params;

  // ── Layer 0: Reproduce & Analyze ──────────────────────────────────────────

  const reproduceConfig: CodingNodeConfig = {
    task: `Analyze this bug report and try to reproduce it by reading relevant code:\n\n${task}\n\nDo NOT make any code changes. Capture:\n- Exact error message and stack trace\n- Which files are involved\n- The likely code path that triggers the bug`,
    model: models.scanner,
    cwd,
    maxTurns: maxTurns.scanner,
    maxBudgetUsd: budgets.scanner,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    codingRole: 'codebase-scanner',
    fileScope: { owned: [], readable: [], pattern: '**/*', lockRequired: false },
  };

  const reproduce: WorkflowNode = {
    id: 'reproduce-analyze',
    type: 'CODING_AGENT',
    label: 'Reproduce & Analyze',
    dependsOn: [],
    status: 'pending',
    codingAgent: {
      task: reproduceConfig.task,
      model: models.scanner,
      cwd,
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    codingConfig: reproduceConfig,
  };

  // ── Layer 1: Root Cause Search ────────────────────────────────────────────

  const rootCauseConfig: CodingNodeConfig = {
    task: `Based on the reproduction analysis, identify the root cause of the bug.\n\nBug: ${task}\n\nTrace the bug to its source:\n1. Follow the code path from symptom to root cause\n2. Identify the exact line(s) responsible\n3. Explain why the bug occurs\n4. List the minimal set of files that need to be changed to fix it`,
    model: models.rootCause,
    cwd,
    maxTurns: maxTurns.rootCause,
    maxBudgetUsd: budgets.rootCause,
    allowedTools: ['Read', 'Glob', 'Grep'],
    codingRole: 'architect',
    fileScope: { owned: [], readable: [], lockRequired: false },
  };

  const rootCause: WorkflowNode = {
    id: 'root-cause-search',
    type: 'AGENT',
    label: 'Root Cause Analysis',
    dependsOn: ['reproduce-analyze'],
    status: 'pending',
    agent: {
      model: models.rootCause,
      task: rootCauseConfig.task,
    },
    codingConfig: rootCauseConfig,
  };

  // ── Layer 2: Fix Implementation ───────────────────────────────────────────

  const fixConfig: CodingNodeConfig = {
    task: `Fix the bug identified in the root cause analysis.\n\nBug: ${task}\n\nGuidelines:\n- Make the minimum change necessary to fix the bug\n- Do NOT refactor or reorganize unrelated code\n- Add inline comments where non-obvious\n- Ensure the fix handles edge cases mentioned in the analysis`,
    model: models.fixer,
    cwd,
    maxTurns: maxTurns.fixer,
    maxBudgetUsd: budgets.fixer,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    codingRole: 'implementer',
    fileScope: {
      owned: [],   // Populated from root-cause output
      readable: [],
      lockRequired: true,
    },
  };

  const fix: WorkflowNode = {
    id: 'fix-implementation',
    type: 'CODING_AGENT',
    label: 'Fix Implementation',
    dependsOn: ['root-cause-search'],
    status: 'pending',
    codingAgent: {
      task: fixConfig.task,
      model: models.fixer,
      cwd,
      maxTurns: maxTurns.fixer,
      maxBudgetUsd: budgets.fixer,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: fixConfig,
  };

  // ── Layer 3: Regression Test ──────────────────────────────────────────────

  const regressionConfig: CodingNodeConfig = {
    task: `Write a regression test that proves this bug is fixed and will catch future regressions.\n\nBug: ${task}\n\nThe test must:\n1. Reproduce the original failure scenario\n2. Assert the correct behavior after the fix\n3. Follow the existing test conventions in this project`,
    model: models.testWriter,
    cwd,
    maxTurns: maxTurns.testWriter,
    maxBudgetUsd: budgets.testWriter,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    codingRole: 'test-writer',
    fileScope: { owned: [], readable: [], lockRequired: true },
  };

  const regressionTest: WorkflowNode = {
    id: 'regression-test',
    type: 'CODING_AGENT',
    label: 'Regression Test',
    dependsOn: ['fix-implementation'],
    status: 'pending',
    codingAgent: {
      task: regressionConfig.task,
      model: models.testWriter,
      cwd,
      maxTurns: maxTurns.testWriter,
      maxBudgetUsd: budgets.testWriter,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: regressionConfig,
  };

  // ── Layer 4: Validation Loop ──────────────────────────────────────────────

  const validationLoop: WorkflowNode = {
    id: 'validation-loop',
    type: 'LOOP',
    label: 'Validation Loop',
    dependsOn: ['regression-test'],
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
      task: 'Validate the bug fix',
      codingRole: 'validator',
      fileScope: { owned: [], readable: [], lockRequired: false },
      // 5-minute per-command budget for build/test/lint — the previous 2 min
      // was insufficient for multi-package monorepo builds (e.g. pnpm -r) and
      // produced spurious "validation failed" results.
      validationConfig: { commands: validationCommands, maxRetries: validationMaxRetries, timeout: validationTimeoutMs },
    },
  };

  // ── Layer 5: Summary Report ───────────────────────────────────────────────

  const reportConfig: CodingNodeConfig = {
    task: `Write a concise bug fix report.\n\nBug: ${task}\n\nInclude: root cause, fix applied, regression test added, files changed.`,
    model: models.reporter,
    cwd,
    maxTurns: maxTurns.reporter,
    maxBudgetUsd: budgets.reporter,
    allowedTools: ['Read'],
    codingRole: 'reporter',
    fileScope: { owned: [], readable: [], lockRequired: false },
  };

  const summaryReport: WorkflowNode = {
    id: 'summary-report',
    type: 'AGENT',
    label: 'Summary Report',
    dependsOn: ['validation-loop'],
    status: 'pending',
    agent: { model: models.reporter, task: reportConfig.task },
    codingConfig: reportConfig,
  };

  return [reproduce, rootCause, fix, regressionTest, validationLoop, summaryReport];
}
