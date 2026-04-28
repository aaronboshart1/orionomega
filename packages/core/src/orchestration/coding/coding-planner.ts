/**
 * @module orchestration/coding/coding-planner
 * Selects and instantiates Coding Mode DAG templates.
 *
 * CodingPlanner sits between the main Planner and the GraphExecutor.
 * It handles template selection, budget allocation, model assignment,
 * and produces a CodingPlannerOutput ready for the executor.
 */

import type {
  CodingDAGTemplate,
  CodingModeConfig,
  CodebaseScanOutput,
  BudgetAllocation,
  CodingPlannerOutput,
  CodingRole,
} from './coding-types.js';
import type { WorkflowNode } from '../types.js';
import type { DiscoveredModel } from '../../models/model-discovery.js';
import { CodingBudgetAllocator } from './coding-budget.js';
import { CodingModelResolver } from './coding-models.js';
import { loadCodingTemplate } from './templates/index.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('coding-planner');

// ── Intent classification ─────────────────────────────────────────────────────

/**
 * Fast-path regex patterns for template selection.
 * Checked in order; first match wins.
 */
const CODING_INTENT_PATTERNS: Array<{
  pattern: RegExp;
  template: CodingDAGTemplate;
}> = [
  // Bug / fix
  {
    pattern: /\b(fix|bug|error|crash|exception|broken|doesn'?t work|not working|failing|fail)\b/i,
    template: 'bug-fix',
  },
  // Refactor
  {
    pattern: /\b(refactor|restructure|reorganize|rename|move|extract|split|clean up)\b/i,
    template: 'refactor',
  },
  // Test suite
  {
    pattern: /\b(test|tests|testing|coverage|spec|specs|unit test|integration test)\b/i,
    template: 'test-suite',
  },
  // Review / PR
  {
    pattern: /\b(review|pr|pull request|feedback|comment|lint|quality)\b/i,
    template: 'review-iterate',
  },
  // Feature implementation (broad catch-all)
  {
    pattern: /\b(add|implement|create|build|develop|feature|endpoint|component|module|function)\b/i,
    template: 'feature-implementation',
  },
];

/**
 * Attempts fast-path template matching from the task description.
 *
 * @param task - Natural language task description.
 * @returns Matched template or null (requires LLM classification).
 */
export function matchCodingIntent(task: string): CodingDAGTemplate | null {
  for (const { pattern, template } of CODING_INTENT_PATTERNS) {
    if (pattern.test(task)) {
      return template;
    }
  }
  return null;
}

/**
 * Returns true if the task is likely a coding mode request.
 * Used by MainAgent to decide whether to invoke CodingPlanner.
 */
export function isCodingModeRequest(task: string): boolean {
  return matchCodingIntent(task) !== null;
}

// ── Planner ────────────────────────────────────────────────────────────────────

export interface CodingPlannerOptions {
  codingModeConfig: CodingModeConfig;
  discoveredModels?: DiscoveredModel[];
  fallbackModel: string;
  cwd?: string;
  /**
   * Per-command wall-clock budget (ms) for validation steps, propagated
   * from `orchestration.validationTimeout`. Defaults to 300_000 ms when
   * omitted. Plumbed through to template builders.
   */
  validationTimeoutMs?: number;
}

export class CodingPlanner {
  private readonly config: CodingModeConfig;
  private readonly modelResolver: CodingModelResolver;
  private readonly budgetAllocator: CodingBudgetAllocator;
  private readonly cwd: string;
  private readonly validationTimeoutMs: number;

  constructor(opts: CodingPlannerOptions) {
    this.config = opts.codingModeConfig;
    this.cwd = opts.cwd ?? process.cwd();
    this.validationTimeoutMs = opts.validationTimeoutMs ?? 300_000;

    this.modelResolver = new CodingModelResolver({
      overrides: opts.codingModeConfig.models,
      discoveredModels: opts.discoveredModels ?? [],
      fallbackModel: opts.fallbackModel,
    });

    this.budgetAllocator = new CodingBudgetAllocator({
      budgetMultiplier: opts.codingModeConfig.budgetMultiplier,
    });
  }

  /**
   * Select a coding template for the given task.
   *
   * Uses fast-path regex matching; returns 'feature-implementation' as fallback
   * when no pattern matches (LLM classification is handled by the caller if needed).
   *
   * @param task - Natural language task description.
   * @returns The selected CodingDAGTemplate.
   */
  selectTemplate(task: string): CodingDAGTemplate {
    const fastMatch = matchCodingIntent(task);
    if (fastMatch) {
      log.debug(`Template fast-matched: "${fastMatch}" for task: "${task.slice(0, 80)}"`);
      return fastMatch;
    }

    // Fallback (LLM classification would go here; for now use feature-implementation)
    log.debug('No fast-path template match; defaulting to feature-implementation');
    return 'feature-implementation';
  }

  /**
   * Build the full CodingPlannerOutput for a task.
   *
   * @param task - Natural language task description.
   * @param template - Pre-selected template (from selectTemplate).
   * @param profile - Codebase scan output (may be a stub if scanner hasn't run yet).
   * @returns CodingPlannerOutput with nodes, budget, and model assignments.
   */
  plan(
    task: string,
    template: CodingDAGTemplate,
    profile: CodebaseScanOutput,
  ): CodingPlannerOutput {
    // 1. Check template is enabled
    if (!this.config.templates[template]) {
      log.warn(`Template "${template}" is disabled in config; falling back to feature-implementation`);
      template = 'feature-implementation';
    }

    // 2. Resolve models for each role
    const context = { profile };
    const roles: CodingRole[] = [
      'codebase-scanner',
      'architect',
      'implementer',
      'stitcher',
      'test-writer',
      'validator',
      'reviewer',
      'reporter',
    ];

    const modelMap: Record<string, string> = {};
    for (const role of roles) {
      const resolved = this.modelResolver.resolve(role, context);
      modelMap[role] = resolved.model;
    }

    // 3. Estimate budgets (use a stub allocation initially; refined after scan)
    const stubBudget = this.stubBudget(template, modelMap);

    // 4. Build template nodes
    const validationCmds = this.config.validation.autoRun
      ? this.config.validation.commands
      : [];

    const nodes = loadCodingTemplate(template, {
      task,
      cwd: this.cwd,
      models: {
        default:     modelMap['implementer'] ?? '',
        scanner:     modelMap['codebase-scanner'] ?? '',
        architect:   modelMap['architect'] ?? '',
        implementer: modelMap['implementer'] ?? '',
        stitcher:    modelMap['stitcher'] ?? '',
        testWriter:  modelMap['test-writer'] ?? '',
        reviewer:    modelMap['reviewer'] ?? '',
        reporter:    modelMap['reporter'] ?? '',
      },
      budgets: {
        default:     stubBudget.perNode.get('codebase-scan')?.maxBudgetUsd ?? 0.10,
        scanner:     stubBudget.perNode.get('codebase-scan')?.maxBudgetUsd ?? 0.10,
        architect:   stubBudget.perNode.get('architecture-design')?.maxBudgetUsd ?? 0.20,
        implementer: stubBudget.perNode.get('impl-placeholder')?.maxBudgetUsd ?? 0.50,
        stitcher:    stubBudget.perNode.get('integration-stitch')?.maxBudgetUsd ?? 0.30,
        testWriter:  stubBudget.perNode.get('test-generation')?.maxBudgetUsd ?? 0.30,
        reviewer:    stubBudget.perNode.get('code-review')?.maxBudgetUsd ?? 0.25,
        reporter:    stubBudget.perNode.get('summary-report')?.maxBudgetUsd ?? 0.05,
      },
      maxTurns: {
        default:     20,
        scanner:     10,
        architect:   15,
        implementer: 30,
        stitcher:    20,
        testWriter:  25,
        reviewer:    20,
        reporter:    5,
      },
      validationCommands: validationCmds,
      validationMaxRetries: 2,
      validationTimeoutMs: this.validationTimeoutMs,
    });

    // 5. Build model assignment map (node ID → {model, thinking})
    const modelAssignments = this.buildModelAssignments(nodes);

    log.info(
      `CodingPlanner: template="${template}" nodes=${nodes.length} ` +
      `estimated=$${stubBudget.estimated.toFixed(2)}`,
    );

    return {
      template,
      codebaseProfile: profile,
      budgetAllocation: stubBudget,
      modelAssignments,
      fanOutPending: this.hasFanOutPlaceholder(nodes),
      nodes,
    };
  }

  /**
   * Refine the budget allocation after the codebase scan completes.
   * Returns an updated CodingPlannerOutput with a more accurate budget.
   */
  refineBudget(
    output: CodingPlannerOutput,
    realProfile: CodebaseScanOutput,
  ): CodingPlannerOutput {
    const nodeDescriptors = output.nodes
      .filter((n) => n.codingConfig)
      .map((n) => ({
        id: n.id,
        codingRole: n.codingConfig!.codingRole,
        model: n.codingConfig!.model ?? '',
      }));

    const refined = this.budgetAllocator.allocate(
      output.template,
      realProfile,
      nodeDescriptors,
    );

    log.debug(
      `Budget refined: estimated=$${refined.estimated.toFixed(2)} ` +
      `(was $${output.budgetAllocation.estimated.toFixed(2)})`,
    );

    return { ...output, budgetAllocation: refined, codebaseProfile: realProfile };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Build a stub budget using a minimal profile (before the actual scan runs). */
  private stubBudget(
    template: CodingDAGTemplate,
    modelMap: Record<string, string>,
  ): BudgetAllocation {
    // Minimal stub profile for pre-scan budget estimation
    const stubProfile: CodebaseScanOutput = {
      language: 'typescript',
      framework: null,
      testFramework: null,
      buildSystem: null,
      lintCommand: null,
      projectStructure: '',
      relevantFiles: Array(20).fill({ path: '', role: 'source', complexity: 'medium', linesOfCode: 100 }),
      entryPoints: [],
      dependencies: {},
    };

    const stubNodes = [
      { id: 'codebase-scan', codingRole: 'codebase-scanner' as CodingRole, model: modelMap['codebase-scanner'] ?? '' },
      { id: 'architecture-design', codingRole: 'architect' as CodingRole, model: modelMap['architect'] ?? '' },
      { id: 'impl-placeholder', codingRole: 'implementer' as CodingRole, model: modelMap['implementer'] ?? '' },
      { id: 'integration-stitch', codingRole: 'stitcher' as CodingRole, model: modelMap['stitcher'] ?? '' },
      { id: 'test-generation', codingRole: 'test-writer' as CodingRole, model: modelMap['test-writer'] ?? '' },
      { id: 'code-review', codingRole: 'reviewer' as CodingRole, model: modelMap['reviewer'] ?? '' },
      { id: 'summary-report', codingRole: 'reporter' as CodingRole, model: modelMap['reporter'] ?? '' },
    ];

    return this.budgetAllocator.allocate(template, stubProfile, stubNodes);
  }

  private buildModelAssignments(
    nodes: WorkflowNode[],
  ): Map<string, { model: string; thinking: { type: string } }> {
    const map = new Map<string, { model: string; thinking: { type: string } }>();
    for (const node of nodes) {
      if (node.codingConfig) {
        const model = node.codingConfig.model ?? node.codingAgent?.model ?? node.agent?.model ?? '';
        const role = node.codingConfig.codingRole;
        const thinkingMode =
          role === 'codebase-scanner' || role === 'validator' || role === 'reporter'
            ? 'disabled'
            : 'adaptive';
        map.set(node.id, { model, thinking: { type: thinkingMode } });
      }
    }
    return map;
  }

  private hasFanOutPlaceholder(nodes: WorkflowNode[]): boolean {
    return nodes.some((n) => n.id === 'impl-placeholder');
  }
}
