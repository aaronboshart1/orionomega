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
  /**
   * Optional list of relevant prior architecture decisions / coding-run
   * memories recalled from Hindsight. When non-empty, the architect prompt
   * surfaces them under a "Prior Architecture Decisions" section so the
   * design step doesn't relitigate work that was already settled.
   */
  priorDecisions?: string[];
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
    validationCommands = [],
    validationMaxRetries = 2,
    validationTimeoutMs = 300_000,
    priorDecisions = [],
  } = params;

  // Render prior decisions (if any) into a bounded markdown block to avoid
  // blowing past the architect model's context window with raw memory dumps.
  const priorDecisionsBlock =
    priorDecisions.length === 0
      ? ''
      : `\n\n## Prior Architecture Decisions (recalled from memory)\n` +
        `Consult these before designing — do not relitigate settled choices unless the new task explicitly requires it.\n\n` +
        priorDecisions
          .slice(0, 8)
          .map((d, i) => {
            const trimmed = d.length > 1500 ? d.slice(0, 1500) + '\n...[truncated]' : d;
            return `### Decision ${i + 1}\n${trimmed}`;
          })
          .join('\n\n');

  // ── Layer 0: Codebase Scanner ───────────────────────────────────────────────

  const codingConfigScanner: CodingNodeConfig = {
    task: `Analyze the codebase to understand its structure, language, framework, test framework, and files most relevant to this feature request:\n\n${task}`,
    model: models.scanner,
    cwd,
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
      maxBudgetUsd: budgets.scanner,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
    codingConfig: codingConfigScanner,
  };

  // ── Layer 1: Architect ─────────────────────────────────────────────────────

  const architectTask = `You are the architect for this feature implementation.

## Feature Request
${task}${priorDecisionsBlock}

## Instructions
1. Review the codebase scan output from the previous node.
2. **Extract concrete requirements** from the user's task — every distinct goal,
   behavior, or acceptance criterion the user expects. Each requirement must be
   independently checkable after implementation.
3. Design a clear implementation approach.
4. Identify which files need to be created or modified.
5. Divide the work into independent "chunks" that can be implemented in parallel.
   - Default sizing: 2–4 chunks for small/medium tasks, each owning a non-overlapping
     set of files. Minimize shared files.
   - **Multi-phase spec override (Task #174):** if the user task references a
     specification document (\`*.md\` / \`*.txt\` / \`*.spec\`) that contains **3 or
     more** \`## Phase N\` / \`### Phase N\` / \`## Step N\` / numbered top-level
     headings, you MUST emit **one chunk per phase** instead of the default 2–4 —
     even if that means 6, 8, or more chunks. The pre-loaded spec contents are
     attached to the planner preamble, so you can read the phases directly.
   - Detect explicit dependency language inside the spec ("depends on Phase N",
     "after Phase N", "requires Phase N") and encode it via the optional
     \`dependsOn\` array on each chunk (list other chunk \`id\`s). Default to no
     \`dependsOn\` (parallel) when the spec doesn't state a dependency.
   - **Complexity safety net:** if a chunk would honestly be tagged
     \`estimatedComplexity: high\` and its underlying phase still spans many
     files, subdivide it into 2–4 sibling chunks (sharing the same
     \`dependsOn\`) BEFORE emitting the JSON. Cap subdivision at one pass.
6. **Map every requirement to one or more chunks** via the chunk's \`coveredBy\`
   list (use chunk \`id\` values). A requirement that no chunk covers is a
   planning bug — fix the design or add a chunk before emitting the JSON.
7. Output a JSON object with this exact structure:
\`\`\`json
{
  "approach": "...",
  "requirements": [
    {
      "id": "req-1",
      "description": "What the user wants — one short sentence.",
      "acceptance": "Concrete, observable signal that this requirement is met.",
      "coveredBy": ["chunk-0"]
    }
  ],
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
        "estimatedComplexity": "low|medium|high",
        "dependsOn": []
      }
    ],
    "maxParallelism": 3
  },
  "risks": ["..."],
  "testStrategy": "..."
}
\`\`\`

The \`requirements\` array is mandatory and must contain at least one entry. The
post-implementation reviewer will grade each requirement individually and force
a retask if any is unmet — so be specific and observable.`;

  const architectCodingConfig: CodingNodeConfig = {
    task: architectTask,
    model: models.architect,
    cwd,
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
