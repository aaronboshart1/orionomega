/**
 * @module orchestration/coding/templates/test-suite
 * DAG template: scan → coverage-analysis → test-gen(N) → test-integration → validate → report
 *
 * Use case: Writing tests, improving coverage, adding test infrastructure.
 */

import type { WorkflowNode } from '../../types.js';
import type { CodingNodeConfig } from '../coding-types.js';

export interface TestSuiteParams {
  task: string;
  cwd: string;
  models: {
    scanner: string;
    coverageAnalyst: string;
    testGen: string;
    integrator: string;
    reporter: string;
  };
  budgets: {
    scanner: number;
    coverageAnalyst: number;
    testGen: number;
    integrator: number;
    reporter: number;
  };
  maxTurns: {
    scanner: number;
    coverageAnalyst: number;
    testGen: number;
    integrator: number;
    reporter: number;
  };
  validationCommands?: string[];
  validationMaxRetries?: number;
}

export function buildTestSuiteTemplate(params: TestSuiteParams): WorkflowNode[] {
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
      task: `Analyze the codebase to understand: test framework, existing test patterns, coverage gaps relevant to: ${task}`,
      model: models.scanner,
      cwd,
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    codingConfig: {
      task: `Scan for test writing: ${task}`,
      model: models.scanner,
      cwd,
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      codingRole: 'codebase-scanner',
      fileScope: { owned: [], readable: [], pattern: '**/*', lockRequired: false },
    },
  };

  // ── Layer 1: Coverage Analysis ────────────────────────────────────────────

  const coverageAnalyst: WorkflowNode = {
    id: 'coverage-analysis',
    type: 'AGENT',
    label: 'Coverage Analysis',
    dependsOn: ['codebase-scan'],
    status: 'pending',
    agent: {
      model: models.coverageAnalyst,
      task: `Identify untested code paths and prioritize them by risk.\n\nTest task: ${task}\n\nOutput a FanOutDecision JSON where each chunk targets a specific module/area for test generation.`,
    },
    codingConfig: {
      task: `Coverage analysis: ${task}`,
      model: models.coverageAnalyst,
      cwd,
      maxTurns: maxTurns.coverageAnalyst,
      maxBudgetUsd: budgets.coverageAnalyst,
      allowedTools: ['Read', 'Glob', 'Grep'],
      codingRole: 'architect',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  // ── Layer 2: Test Generation Placeholder (fans out) ───────────────────────

  const testGenPlaceholder: WorkflowNode = {
    id: 'impl-placeholder',
    type: 'CODING_AGENT',
    label: 'Test Generation (fan-out pending)',
    dependsOn: ['coverage-analysis'],
    status: 'pending',
    codingAgent: {
      task: `Generate tests for the assigned module as part of: ${task}`,
      model: models.testGen,
      cwd,
      maxTurns: maxTurns.testGen,
      maxBudgetUsd: budgets.testGen,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: {
      task: `Generate tests: ${task}`,
      model: models.testGen,
      cwd,
      maxTurns: maxTurns.testGen,
      maxBudgetUsd: budgets.testGen,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      codingRole: 'test-writer',
      fileScope: { owned: [], readable: [], lockRequired: true },
    },
  };

  // ── Layer 3: Test Integration ─────────────────────────────────────────────

  const integrator: WorkflowNode = {
    id: 'test-integration',
    type: 'CODING_AGENT',
    label: 'Test Integration',
    dependsOn: ['impl-placeholder'],
    status: 'pending',
    codingAgent: {
      task: `Integrate all generated tests:\n- Ensure shared fixtures/helpers are not duplicated\n- Update test index/runner if needed\n- Verify all imports are correct\n\nTest task: ${task}`,
      model: models.integrator,
      cwd,
      maxTurns: maxTurns.integrator,
      maxBudgetUsd: budgets.integrator,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    },
    codingConfig: {
      task: `Integrate tests: ${task}`,
      model: models.integrator,
      cwd,
      maxTurns: maxTurns.integrator,
      maxBudgetUsd: budgets.integrator,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
      codingRole: 'stitcher',
      fileScope: { owned: [], readable: [], lockRequired: true },
    },
  };

  // ── Layer 4: Validation Loop ──────────────────────────────────────────────

  const validationLoop: WorkflowNode = {
    id: 'validation-loop',
    type: 'LOOP',
    label: 'Validation Loop',
    dependsOn: ['test-integration'],
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
      task: 'Validate test suite',
      codingRole: 'validator',
      fileScope: { owned: [], readable: [], lockRequired: false },
      validationConfig: { commands: validationCommands, maxRetries: validationMaxRetries, timeout: 180_000 },
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
      task: `Summarize the test suite added for: ${task}\n\nInclude: tests written, coverage areas, passing/failing count.`,
    },
    codingConfig: {
      task: `Summarize test suite: ${task}`,
      model: models.reporter,
      cwd,
      maxTurns: maxTurns.reporter,
      maxBudgetUsd: budgets.reporter,
      allowedTools: ['Read'],
      codingRole: 'reporter',
      fileScope: { owned: [], readable: [], lockRequired: false },
    },
  };

  return [scanner, coverageAnalyst, testGenPlaceholder, integrator, validationLoop, summaryReport];
}
