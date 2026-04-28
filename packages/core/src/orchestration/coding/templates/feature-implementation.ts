/**
 * @module orchestration/coding/templates/feature-implementation
 * DAG template: scan → design → implement(N) → stitch → test → validate → report
 *
 * Use case: Adding new features, endpoints, components, modules.
 * Layer 2 fans out dynamically based on the architect's FanOutDecision.
 */

import type { WorkflowNode } from '../../types.js';
import type { CodingNodeConfig } from '../coding-types.js';

export interface FeatureImplementationParams {
  /** Natural language description of the feature to implement. */
  task: string;
  /** Working directory for all agents. */
  cwd: string;
  /** Model IDs for each role (resolved by CodingModelResolver). */
  models: {
    scanner: string;
    architect: string;
    implementer: string;
    stitcher: string;
    testWriter: string;
    reporter: string;
  };
  /** Maximum budget per node in USD. */
  budgets: {
    scanner: number;
    architect: number;
    implementer: number;  // Applied to each implementer chunk
    stitcher: number;
    testWriter: number;
    reporter: number;
  };
  /** Maximum turns per node. */
  maxTurns: {
    scanner: number;
    architect: number;
    implementer: number;
    stitcher: number;
    testWriter: number;
    reporter: number;
  };
  /** Validation commands to run. Empty = auto-detect. */
  validationCommands?: string[];
  /** Max validation retry iterations. */
  validationMaxRetries?: number;
  /**
   * Per-command wall-clock budget (ms) for validation steps. Sourced from
   * `orchestration.validationTimeout` in the user's config. Defaults to 5 min.
   */
  validationTimeoutMs?: number;
}

/**
 * Builds the feature-implementation DAG template.
 *
 * Layers 0-1-3-4-5-6 are statically defined.
 * Layer 2 (implementers) is a single placeholder node (`impl-placeholder`)
 * that the executor replaces via fan-out after the architect node completes.
 *
 * @param params - Template parameters.
 * @returns Array of WorkflowNodes that form the template graph.
 */
export function buildFeatureImplementationTemplate(
  params: FeatureImplementationParams,
): WorkflowNode[] {
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

  // ── Layer 0: Codebase Scanner ───────────────────────────────────────────────

  const codingConfigScanner: CodingNodeConfig = {
    task: `Analyze the codebase to understand its structure, language, framework, test framework, and files most relevant to this feature request:\n\n${task}`,
    model: models.scanner,
    cwd,
    maxTurns: maxTurns.scanner,
    maxBudgetUsd: budgets.scanner,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    codingRole: 'codebase-scanner',
    fileScope: {
      owned: [],
      readable: [],
      pattern: '**/*',
      lockRequired: false,
    },
  };

  const scanner: WorkflowNode = {
    id: 'codebase-scan',
    type: 'CODING_AGENT',
    label: 'Codebase Scanner',
    dependsOn: [],
    status: 'pending',
    codingAgent: {
      task: codingConfigScanner.task,
      model: models.scanner,
      cwd,
      maxTurns: maxTurns.scanner,
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    codingConfig: codingConfigScanner,
  };

  // ── Layer 1: Architect ─────────────────────────────────────────────────────

  const architectTask = `You are the architect for this feature implementation.

## Feature Request
${task}

## Instructions
1. Review the codebase scan output from the previous node.
2. Design a clear implementation approach.
3. Identify which files need to be created or modified.
4. Divide the work into 2–4 independent "chunks" that can be implemented in parallel.
   - Each chunk should own a non-overlapping set of files.
   - Minimize shared files (move shared utilities to a separate chunk if possible).
5. Output a JSON object with this exact structure:
\`\`\`json
{
  "approach": "...",
  "fileChanges": [
    { "path": "...", "action": "create|modify|delete", "description": "...", "cluster": 0 }
  ],
  "fanOut": {
    "chunks": [
      {
        "id": "chunk-0",
        "label": "...",
        "fileCluster": ["path/to/file.ts"],
        "sharedFiles": [],
        "task": "Specific instructions for this implementer...",
        "estimatedComplexity": "low|medium|high"
      }
    ],
    "maxParallelism": 3
  },
  "risks": ["..."],
  "testStrategy": "..."
}
\`\`\``;

  const architectCodingConfig: CodingNodeConfig = {
    task: architectTask,
    model: models.architect,
    cwd,
    maxTurns: maxTurns.architect,
    maxBudgetUsd: budgets.architect,
    allowedTools: ['Read', 'Glob', 'Grep'],
    codingRole: 'architect',
    fileScope: {
      owned: [],
      readable: [],
      pattern: '**/*',
      lockRequired: false,
    },
  };

  const architect: WorkflowNode = {
    id: 'architecture-design',
    type: 'AGENT',
    label: 'Architecture Design',
    dependsOn: ['codebase-scan'],
    status: 'pending',
    agent: {
      model: models.architect,
      task: architectTask,
    },
    codingConfig: architectCodingConfig,
  };

  // ── Layer 2: Implementer Placeholder ───────────────────────────────────────
  // The executor replaces this with N parallel CODING_AGENT nodes after
  // the architect's FanOutDecision is parsed.

  const implPlaceholderConfig: CodingNodeConfig = {
    task: `Implement the assigned file cluster for: ${task}`,
    model: models.implementer,
    cwd,
    maxTurns: maxTurns.implementer,
    maxBudgetUsd: budgets.implementer,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    codingRole: 'implementer',
    fileScope: {
      owned: [],     // Populated dynamically from FanOutDecision
      readable: [],
      lockRequired: true,
    },
  };

  const implPlaceholder: WorkflowNode = {
    id: 'impl-placeholder',
    type: 'CODING_AGENT',
    label: 'Implementation (fan-out pending)',
    dependsOn: ['architecture-design'],
    status: 'pending',
    codingAgent: {
      task: implPlaceholderConfig.task,
      model: models.implementer,
      cwd,
      maxTurns: maxTurns.implementer,
      maxBudgetUsd: budgets.implementer,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: implPlaceholderConfig,
  };

  // ── Layer 3: Integration Stitch ────────────────────────────────────────────

  const stitcherCodingConfig: CodingNodeConfig = {
    task: `You are the integration stitcher. Review all implementation outputs and resolve any conflicts or inconsistencies between parallel implementation chunks.\n\nFeature: ${task}`,
    model: models.stitcher,
    cwd,
    maxTurns: maxTurns.stitcher,
    maxBudgetUsd: budgets.stitcher,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    codingRole: 'stitcher',
    fileScope: {
      owned: [],   // Populated at runtime from all impl outputs
      readable: [],
      lockRequired: true,
    },
  };

  const stitcher: WorkflowNode = {
    id: 'integration-stitch',
    type: 'CODING_AGENT',
    label: 'Integration Stitch',
    dependsOn: ['impl-placeholder'],  // Will be updated to all impl-chunk-N nodes
    status: 'pending',
    codingAgent: {
      task: stitcherCodingConfig.task,
      model: models.stitcher,
      cwd,
      maxTurns: maxTurns.stitcher,
      maxBudgetUsd: budgets.stitcher,
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    },
    codingConfig: stitcherCodingConfig,
  };

  // ── Layer 4: Test Generation ───────────────────────────────────────────────

  const testWriterCodingConfig: CodingNodeConfig = {
    task: `Write comprehensive tests for the implemented feature.\n\nFeature: ${task}\n\nUse the existing test framework and conventions in this project.`,
    model: models.testWriter,
    cwd,
    maxTurns: maxTurns.testWriter,
    maxBudgetUsd: budgets.testWriter,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    codingRole: 'test-writer',
    fileScope: {
      owned: [],   // Test files (determined at runtime)
      readable: [],
      lockRequired: true,
    },
  };

  const testGeneration: WorkflowNode = {
    id: 'test-generation',
    type: 'CODING_AGENT',
    label: 'Test Generation',
    dependsOn: ['integration-stitch'],
    status: 'pending',
    codingAgent: {
      task: testWriterCodingConfig.task,
      model: models.testWriter,
      cwd,
      maxTurns: maxTurns.testWriter,
      maxBudgetUsd: budgets.testWriter,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
    codingConfig: testWriterCodingConfig,
  };

  // ── Layer 5: Validation Loop ───────────────────────────────────────────────

  const validationLoop: WorkflowNode = {
    id: 'validation-loop',
    type: 'LOOP',
    label: 'Validation Loop',
    dependsOn: ['test-generation'],
    status: 'pending',
    loop: {
      body: [
        {
          id: 'validator',
          type: 'TOOL',
          label: 'Run Tests & Lint',
          dependsOn: [],
          status: 'pending',
          tool: {
            name: 'SHELL_SEQUENCE',
            params: {
              commands: validationCommands,
              cwd,
            },
          },
        },
      ],
      maxIterations: validationMaxRetries + 1,
      exitCondition: { type: 'all_pass' },
      carryForward: true,
    },
    codingConfig: {
      task: 'Validate the implementation',
      codingRole: 'validator',
      fileScope: { owned: [], readable: [], lockRequired: false },
      validationConfig: {
        commands: validationCommands,
        maxRetries: validationMaxRetries,
        // Per-command budget sourced from `orchestration.validationTimeout`
        // so monorepo builds (e.g. `pnpm -r`) can be granted more time
        // without editing template code.
        timeout: validationTimeoutMs,
      },
    },
  };

  // ── Layer 6: Summary Report ────────────────────────────────────────────────

  const reporterCodingConfig: CodingNodeConfig = {
    task: `Generate a concise summary report of the implemented feature.\n\nFeature: ${task}\n\nInclude: files created/modified, what was implemented, test results, any known limitations.`,
    model: models.reporter,
    cwd,
    maxTurns: maxTurns.reporter,
    maxBudgetUsd: budgets.reporter,
    allowedTools: ['Read'],
    codingRole: 'reporter',
    fileScope: {
      owned: [],
      readable: [],
      lockRequired: false,
    },
  };

  const summaryReport: WorkflowNode = {
    id: 'summary-report',
    type: 'AGENT',
    label: 'Summary Report',
    dependsOn: ['validation-loop'],
    status: 'pending',
    agent: {
      model: models.reporter,
      task: reporterCodingConfig.task,
    },
    codingConfig: reporterCodingConfig,
  };

  return [scanner, architect, implPlaceholder, stitcher, testGeneration, validationLoop, summaryReport];
}
