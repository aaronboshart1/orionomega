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
import {
  expandFanOut,
  analyzeFanOutComplexity,
  subdivideHighComplexityChunks,
  type FanOutComplexityReport,
  type SubdivisionReport,
} from './fanout-expansion.js';
import type { FanOutDecision } from './coding-types.js';
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
   * @param opts - Optional planning context (e.g. prior decisions recalled
   *   from Hindsight to thread into the architect prompt).
   * @returns CodingPlannerOutput with nodes, budget, and model assignments.
   */
  plan(
    task: string,
    template: CodingDAGTemplate,
    profile: CodebaseScanOutput,
    opts?: { priorDecisions?: string[] },
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
      priorDecisions: opts?.priorDecisions,
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
   * Task #174 — Materialize the fan-out placeholder using the
   * architect's {@link FanOutDecision}.
   *
   * This is the production wire-up of `expandFanOut` +
   * `analyzeFanOutComplexity`: the orchestrator calls it after
   * receiving the architect's decision, before dispatching workers.
   *
   * Returns a fresh {@link CodingPlannerOutput} with the
   * `impl-placeholder` replaced by N concrete `impl-chunk-<id>` nodes
   * (carrying inter-phase `dependsOn` edges) and `fanOutPending`
   * cleared. The companion `complexity` report logs per-chunk
   * complexity and signals when a one-shot architect re-plan should
   * be requested before dispatching (the `requiresReplan` flag, capped
   * at one pass via `alreadyReplanned`).
   *
   * Behaviour notes:
   *   - When `fanOutPending` is already false (no placeholder), the
   *     output is returned unchanged with `complexity` still computed
   *     so the dispatch log line is always present.
   *   - The expanded nodes get fresh per-chunk model assignments
   *     inherited from the placeholder (so model resolution stays
   *     consistent), refreshed via `buildModelAssignments`.
   */
  materializeFanOut(
    output: CodingPlannerOutput,
    decision: FanOutDecision,
    options: { alreadyReplanned?: boolean } = {},
  ): CodingPlannerOutput & {
    complexity: FanOutComplexityReport;
    subdivision: SubdivisionReport;
    effectiveDecision: FanOutDecision;
  } {
    // Task #178 — deterministic in-code subdivision of `high`-complexity
    // chunks runs BEFORE the placeholder is expanded into worker nodes.
    // The cap is the same `alreadyReplanned` flag the caller would use
    // to short-circuit the LLM re-plan, so a single dispatch can never
    // recurse into another subdivision pass.
    const { decision: effectiveDecision, report: subdivision } =
      subdivideHighComplexityChunks(decision, options);

    // Complexity analysis runs against the POST-subdivision decision so
    // the dispatch log line and `requiresReplan` flag reflect what the
    // executor will actually see. (After deterministic subdivision the
    // `high` chunks are gone, so `requiresReplan` is naturally false —
    // exactly what we want: no LLM re-plan needed.)
    const complexity = analyzeFanOutComplexity(effectiveDecision, options);

    if (!output.fanOutPending) {
      return { ...output, complexity, subdivision, effectiveDecision };
    }

    const expanded = expandFanOut({ template: output.nodes, decision: effectiveDecision });
    const modelAssignments = this.buildModelAssignments(expanded);

    log.info(
      `CodingPlanner.materializeFanOut: chunks(in)=${decision.chunks.length} ` +
        `chunks(post-subdivide)=${effectiveDecision.chunks.length} ` +
        `splits=${subdivision.splits.length} ` +
        `nodes(before)=${output.nodes.length} nodes(after)=${expanded.length} ` +
        `requiresReplan=${complexity.requiresReplan}`,
    );

    return {
      ...output,
      nodes: expanded,
      modelAssignments,
      fanOutPending: false,
      complexity,
      subdivision,
      effectiveDecision,
    };
  }

  /**
   * Task #174 — Capped one-shot re-plan dispatch path.
   *
   * Wraps {@link materializeFanOut} with the LLM re-plan control flow.
   *
   * Task #178 update: deterministic in-code subdivision now runs inside
   * `materializeFanOut` BEFORE complexity analysis, which removes the
   * `high` tag from oversized chunks proactively. As a result, the
   * `requiresReplan` branch of this helper is dormant in normal flow —
   * the architect callback is invoked exactly once and `replanned`
   * comes back `false` for the common case. The replan branch only
   * fires when the deterministic safety net itself was bypassed (e.g.
   * a future caller passes `{ alreadyReplanned: true }` into
   * `materializeFanOut` upstream); the wrapper is preserved for
   * back-compat and as a defense-in-depth fallback.
   *
   * Behavior when the replan branch IS triggered: re-invokes
   * `requestArchitectDecision` exactly once with the generated
   * `replanInstruction`, then re-materializes with
   * `alreadyReplanned: true` so a second high tag is dispatched as-is
   * (no recursion). The returned object reports the final expanded
   * plan, both decisions, and whether a re-plan happened.
   *
   * `requestArchitectDecision(prevDecision, replanInstruction)` is the
   * production callback that runs the architect step. The first call
   * is invoked with `(null, null)`; the second (only when re-planning)
   * is invoked with the prior decision and the replan instruction so
   * the architect has the full context for subdivision. Async or
   * sync callbacks are both supported.
   */
  async materializeFanOutWithReplan(
    output: CodingPlannerOutput,
    requestArchitectDecision: (
      prev: FanOutDecision | null,
      replanInstruction: string | null,
    ) => Promise<FanOutDecision> | FanOutDecision,
  ): Promise<{
    plan: CodingPlannerOutput & { complexity: FanOutComplexityReport };
    initialDecision: FanOutDecision;
    finalDecision: FanOutDecision;
    replanned: boolean;
  }> {
    const initialDecision = await requestArchitectDecision(null, null);
    const first = this.materializeFanOut(output, initialDecision);
    if (!first.complexity.requiresReplan) {
      return {
        plan: first,
        initialDecision,
        finalDecision: initialDecision,
        replanned: false,
      };
    }

    log.info(
      `materializeFanOutWithReplan: re-planning due to high-complexity chunks: ` +
        `${first.complexity.highComplexityIds.join(', ')}`,
    );
    const replannedDecision = await requestArchitectDecision(
      initialDecision,
      first.complexity.replanInstruction,
    );
    const second = this.materializeFanOut(output, replannedDecision, { alreadyReplanned: true });
    return {
      plan: second,
      initialDecision,
      finalDecision: replannedDecision,
      replanned: true,
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
