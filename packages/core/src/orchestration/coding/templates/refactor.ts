/**
 * @module orchestration/coding/templates/refactor
 * DAG template: scan → dependency-analysis → refactor(N) → stitch → test-update → validate → report
 *
 * Use case: Restructuring, renaming, extracting, moving code.
 * Parallel refactoring chunks operate on independent file clusters.
 */

import type { WorkflowNode } from '../../types.js';
import type { CodingNodeConfig } from '../coding-types.js';

export interface RefactorParams {
  task: string;
  cwd: string;
  models: {
    scanner: string;
    analyst: string;
    refactorer: string;
    stitcher: string;
    testUpdater: string;
    reporter: string;
  };
  budgets: {
    scanner: number;
    analyst: number;
    refactorer: number;
    stitcher: number;
    testUpdater: number;
    reporter: number;
  };
  maxTurns: {
    scanner: number;
    analyst: number;
    refactorer: number;
    stitcher: number;
    testUpdater: number;
    reporter: number;
  };
  validationCommands?: string[];
  validationMaxRetries?: number;
}

export function buildRefactorTemplate(params: RefactorParams): WorkflowNode[] {
  const {
    task,
    cwd,
    models,
    budgets,
    maxTurns,
    validationCommands = [],
    validationMaxRetries = 2,
  } = params;

  // ── Layer 0: Codebase Scanner ─────────────────────────────────────────────

  const scanner: WorkflowNode = {
    id: 'codebase-scan',
    type: 'CODING_AGENT',
    label: 'Codebase Scanner',
    dependsOn: [],
    status: 'pending',
    codingAgent: {
      task: `Analyze the codebase structure to understand what needs to be refactored:\n\n${task}\n\nMap out: file structure, import/export relationships, shared utilities, and test files.`,
      model: models.scanner,
      cwd,
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    codingConfig: {
      task: `Analyze codebase for refactoring: ${task}`,
      model: models.scanner,
      cwd,
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      codingRole: 'codebase-scanner',
      fileScope: { owned: [], readable: [], pattern: '**/*', lockRequired: false },
    },
  };

  // ── Layer 1: Dependency Analysis ──────────────────────────────────────────

  const analyst: WorkflowNode = {
    id: 'dependency-analysis',
    type: 'AGENT',
    label: 'Dependency Analysis',
    dependsOn: ['codebase-scan'],
    status: 'pending',
    agent: {
      model: models.analyst,
      task: `Analyze the file dependency graph to identify safe parallel refactoring boundaries.\n\nRefactoring task: ${task}\n\nOutput a FanOutDecision JSON (same schema as feature-implementation architect) that:\n1. Groups files into independent clusters (no cross-cluster imports that would create merge conflicts)\n2. Identifies shared files that need stitcher coordination\n3. Creates specific refactoring instructions per chunk`,
    },
    codingConfig: {
      task: `Dependency analysis for refactor: ${task}`,
      model: models.analyst,
      cwd,
      maxTurns: maxTurns.analyst,
      maxBudgetUsd: budgets.analyst,
      allowedTools: ['Read', 'Glob', 'Grep'],
      codingRole: 'architect',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  // ── Layer 2: Refactor Placeholder (fans out) ───────────────────────────────

  const refactorPlaceholder: WorkflowNode = {
    id: 'impl-placeholder',
    type: 'CODING_AGENT',
    label: 'Refactoring (fan-out pending)',
    dependsOn: ['dependency-analysis'],
    status: 'pending',
    codingAgent: {
      task: `Apply the assigned refactoring changes for: ${task}`,
      model: models.refactorer,
      cwd,
      maxTurns: maxTurns.refactorer,
      maxBudgetUsd: budgets.refactorer,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: {
      task: `Refactor assigned cluster: ${task}`,
      model: models.refactorer,
      cwd,
      maxTurns: maxTurns.refactorer,
      maxBudgetUsd: budgets.refactorer,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      codingRole: 'implementer',
      fileScope: { owned: [], readable: [], lockRequired: true },
    },
  };

  // ── Layer 3: Integration Stitch ───────────────────────────────────────────

  const stitcher: WorkflowNode = {
    id: 'integration-stitch',
    type: 'CODING_AGENT',
    label: 'Integration Stitch',
    dependsOn: ['impl-placeholder'],
    status: 'pending',
    codingAgent: {
      task: `Reconcile the parallel refactoring outputs. Fix import paths, resolve naming conflicts, and ensure consistency across all refactored files.\n\nTask: ${task}`,
      model: models.stitcher,
      cwd,
      maxTurns: maxTurns.stitcher,
      maxBudgetUsd: budgets.stitcher,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    },
    codingConfig: {
      task: `Stitch refactoring: ${task}`,
      model: models.stitcher,
      cwd,
      maxTurns: maxTurns.stitcher,
      maxBudgetUsd: budgets.stitcher,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      codingRole: 'stitcher',
      fileScope: { owned: [], readable: [], lockRequired: true },
    },
  };

  // ── Layer 4: Test Update ──────────────────────────────────────────────────

  const testUpdate: WorkflowNode = {
    id: 'test-update',
    type: 'CODING_AGENT',
    label: 'Test Update',
    dependsOn: ['integration-stitch'],
    status: 'pending',
    codingAgent: {
      task: `Update all affected tests to match the refactored code.\n\nRefactoring: ${task}\n\nUpdate import paths, renamed symbols, and any assertions that reference moved/renamed code.`,
      model: models.testUpdater,
      cwd,
      maxTurns: maxTurns.testUpdater,
      maxBudgetUsd: budgets.testUpdater,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: {
      task: `Update tests for refactoring: ${task}`,
      model: models.testUpdater,
      cwd,
      maxTurns: maxTurns.testUpdater,
      maxBudgetUsd: budgets.testUpdater,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      codingRole: 'test-writer',
      fileScope: { owned: [], readable: [], lockRequired: true },
    },
  };

  // ── Layer 5: Validation Loop ──────────────────────────────────────────────

  const validationLoop: WorkflowNode = {
    id: 'validation-loop',
    type: 'LOOP',
    label: 'Validation Loop',
    dependsOn: ['test-update'],
    status: 'pending',
    loop: {
      body: [
        {
          id: 'validator',
          type: 'TOOL',
          label: 'Run Tests & Type Check',
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
      task: 'Validate refactoring',
      codingRole: 'validator',
      fileScope: { owned: [], readable: [], lockRequired: false },
      validationConfig: { commands: validationCommands, maxRetries: validationMaxRetries, timeout: 180_000 },
    },
  };

  // ── Layer 6: Summary Report ───────────────────────────────────────────────

  const summaryReport: WorkflowNode = {
    id: 'summary-report',
    type: 'AGENT',
    label: 'Summary Report',
    dependsOn: ['validation-loop'],
    status: 'pending',
    agent: {
      model: models.reporter,
      task: `Write a concise refactoring summary.\n\nTask: ${task}\n\nInclude: what was refactored, files changed, tests updated, validation results.`,
    },
    codingConfig: {
      task: `Summarize refactoring: ${task}`,
      model: models.reporter,
      cwd,
      maxTurns: maxTurns.reporter,
      maxBudgetUsd: budgets.reporter,
      allowedTools: ['Read'],
      codingRole: 'reporter',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  return [scanner, analyst, refactorPlaceholder, stitcher, testUpdate, validationLoop, summaryReport];
}
