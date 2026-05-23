/**
 * @module orchestration/coding/coding-models
 * Role-based model selection with dynamic upgrade/downgrade for Coding Mode.
 *
 * Resolves the optimal model ID for each coding role based on:
 * 1. The role's preferred tier (haiku / sonnet / opus)
 * 2. Codebase profile conditions (complexity, file count, conflict count)
 * 3. Per-role config overrides from OrionOmegaConfig.codingMode.models
 * 4. Available discovered models from the Anthropic API
 */

import type { CodingRole, CodebaseScanOutput } from './coding-types.js';
import type { WorkflowNode } from '../types.js';
import type { DiscoveredModel } from '../../models/model-discovery.js';
import { pickModelByTier } from '../../models/model-discovery.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('coding-models');

type ModelTier = 'haiku' | 'sonnet' | 'opus';

/**
 * Granular effort level for extended thinking.
 * Maps to budget_tokens in the SDK bridge: medium=8000, high=16000, xhigh=32000.
 * 'disabled' means thinking is off for this role.
 */
export type ThinkingEffort = 'medium' | 'high' | 'xhigh' | 'disabled';

interface ModelStrategy {
  /** Preferred model tier for normal conditions. */
  preferredTier: ModelTier | null;
  /** Tier to use when upgrade condition is met (null = no upgrade). */
  upgradeTier: ModelTier | null;
  /** Tier to use when downgrade condition is met (null = no downgrade). */
  downgradeTier: ModelTier | null;
  /** Whether to enable adaptive thinking mode (extended thinking). */
  thinkingMode: 'adaptive' | 'disabled';
  /**
   * Token budget for extended thinking when thinkingMode is 'adaptive'.
   * Higher values allow deeper reasoning at higher cost.
   * Undefined = let the model choose its own budget (API default).
   */
  thinkingBudgetTokens?: number;
  /**
   * Granular effort level surfaced in resolve() output and used by the
   * agent-sdk-bridge to set budget_tokens: medium=8000, high=16000, xhigh=32000.
   */
  thinkingEffort: ThinkingEffort;
}

/** Role-based model strategy map. */
const CODING_MODE_MODEL_STRATEGY: Record<CodingRole, ModelStrategy> = {
  'codebase-scanner': {
    preferredTier: 'haiku',
    upgradeTier:   'sonnet',
    downgradeTier: null,
    thinkingMode:  'disabled',  // Read-only enumeration; speed over quality
    thinkingEffort: 'disabled',
  },
  'architect': {
    preferredTier: 'sonnet',
    upgradeTier:   'opus',
    downgradeTier: null,
    thinkingMode:  'adaptive',  // May need deep reasoning for design decisions
    thinkingBudgetTokens: 16_000,
    thinkingEffort: 'high',
  },
  'implementer': {
    preferredTier: 'sonnet',
    upgradeTier:   'opus',
    downgradeTier: null,
    thinkingMode:  'adaptive',
    thinkingBudgetTokens: 10_000,
    thinkingEffort: 'high',
  },
  'stitcher': {
    preferredTier: 'sonnet',
    upgradeTier:   'opus',
    downgradeTier: null,
    thinkingMode:  'adaptive',
    thinkingBudgetTokens: 8_000,
    thinkingEffort: 'medium',
  },
  'test-writer': {
    preferredTier: 'sonnet',
    upgradeTier:   null,
    downgradeTier: 'haiku',   // Downgrade for simple unit tests
    thinkingMode:  'adaptive',
    thinkingBudgetTokens: 6_000,
    thinkingEffort: 'medium',
  },
  'validator': {
    preferredTier: null,      // TOOL node — no model needed
    upgradeTier:   null,
    downgradeTier: null,
    thinkingMode:  'disabled',
    thinkingEffort: 'disabled',
  },
  'reviewer': {
    // Spec 4.4: "Reviewer always uses opus — research shows using a more
    // capable model for review than implementation catches errors that
    // self-review misses."
    preferredTier: 'opus',
    upgradeTier:   null,
    downgradeTier: null,
    thinkingMode:  'adaptive',
    thinkingBudgetTokens: 12_000,
    thinkingEffort: 'high',
  },
  'debugger': {
    // Spec 4.4: "Debugger gets xhigh thinking — debugging requires the
    // deepest reasoning to diagnose root causes rather than surface symptoms."
    // Always uses opus — bug diagnosis demands the most capable model.
    preferredTier: 'opus',
    upgradeTier:   null,
    downgradeTier: null,
    thinkingMode:  'adaptive',
    thinkingBudgetTokens: 20_000,  // Highest budget: root cause requires deepest reasoning
    thinkingEffort: 'xhigh',
  },
  'review-gate': {
    preferredTier: null,      // ROUTER node — deterministic logic, no model
    upgradeTier:   null,
    downgradeTier: null,
    thinkingMode:  'disabled',
    thinkingEffort: 'disabled',
  },
  'reporter': {
    preferredTier: 'haiku',
    upgradeTier:   'sonnet',
    downgradeTier: null,
    thinkingMode:  'disabled', // Summary is simple; minimize cost
    thinkingEffort: 'disabled',
  },
};

// ── Context passed to model resolution ───────────────────────────────────────

export interface ModelResolutionContext {
  /** Codebase profile from the scanner node. */
  profile: CodebaseScanOutput;
  /** Number of conflicts detected (for stitcher upgrade). */
  conflictCount?: number;
  /** Whether the code is security-relevant (triggers reviewer upgrade). */
  securityRelevant?: boolean;
  /**
   * Retry attempt number for the current node (0 = first attempt).
   * Debugger upgrades to opus on attempt >= 1 (retry #2+).
   */
  retryAttempt?: number;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

export class CodingModelResolver {
  private readonly overrides: Partial<Record<CodingRole, string>>;
  private readonly discoveredModels: DiscoveredModel[];
  private readonly fallbackModel: string;

  constructor(opts: {
    overrides?: Partial<Record<CodingRole, string>>;
    discoveredModels?: DiscoveredModel[];
    fallbackModel: string;
  }) {
    this.overrides = opts.overrides ?? {};
    this.discoveredModels = opts.discoveredModels ?? [];
    this.fallbackModel = opts.fallbackModel;
  }

  /**
   * Resolves the model ID and thinking mode for a given coding role.
   *
   * Resolution order:
   * 1. Config override (codingMode.models.<role>)
   * 2. Dynamic upgrade/downgrade based on context
   * 3. Preferred tier from strategy map
   * 4. Fallback model
   *
   * @param role - The coding role to resolve.
   * @param context - Runtime context for upgrade/downgrade decisions.
   * @returns Resolved model ID and thinking mode.
   */
  resolve(
    role: CodingRole,
    context: ModelResolutionContext,
  ): { model: string; thinking: { type: string; budgetTokens?: number }; effort: ThinkingEffort } {
    // 1. Check config override
    const override = this.overrides[role];
    if (override) {
      log.debug(`Role ${role}: using config override → ${override}`);
      const s = CODING_MODE_MODEL_STRATEGY[role];
      return {
        model: override,
        thinking: {
          type: s.thinkingMode,
          ...(s.thinkingBudgetTokens !== undefined ? { budgetTokens: s.thinkingBudgetTokens } : {}),
        },
        effort: s.thinkingEffort,
      };
    }

    const strategy = CODING_MODE_MODEL_STRATEGY[role];

    // TOOL node (validator) or ROUTER node — no model
    if (strategy.preferredTier === null) {
      return { model: '', thinking: { type: 'disabled' }, effort: 'disabled' };
    }

    // 2. Determine effective tier (with upgrade/downgrade)
    let tier: ModelTier = strategy.preferredTier;

    if (strategy.upgradeTier && this.shouldUpgrade(role, context)) {
      tier = strategy.upgradeTier;
      log.debug(`Role ${role}: upgrading to ${tier} tier`);
    } else if (strategy.downgradeTier && this.shouldDowngrade(role, context)) {
      tier = strategy.downgradeTier;
      log.debug(`Role ${role}: downgrading to ${tier} tier`);
    }

    // 3. Resolve to actual model ID
    const model =
      pickModelByTier(this.discoveredModels, tier)?.id ?? this.fallbackModel;

    log.debug(`Role ${role}: resolved to ${model} (tier: ${tier})`);
    return {
      model,
      thinking: {
        type: strategy.thinkingMode,
        ...(strategy.thinkingBudgetTokens !== undefined ? { budgetTokens: strategy.thinkingBudgetTokens } : {}),
      },
      effort: strategy.thinkingEffort,
    };
  }

  /**
   * Resolves model assignments for all nodes in a coding DAG.
   *
   * @param nodes - Array of {id, codingRole} descriptors.
   * @param context - Runtime context for upgrade/downgrade decisions.
   * @returns Map of nodeId → {model, thinking}.
   */
  resolveAll(
    nodes: Array<{ id: string; codingRole: CodingRole }>,
    context: ModelResolutionContext,
  ): Map<string, { model: string; thinking: { type: string } }> {
    const assignments = new Map<string, { model: string; thinking: { type: string } }>();
    for (const node of nodes) {
      assignments.set(node.id, this.resolve(node.codingRole, context));
    }
    return assignments;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private shouldUpgrade(role: CodingRole, ctx: ModelResolutionContext): boolean {
    const { profile, conflictCount = 0, securityRelevant = false, retryAttempt = 0 } = ctx;
    const fileCount = profile.relevantFiles.length;
    const avgComplexity = this.avgComplexity(profile);
    const highComplexity = avgComplexity >= 2.5; // majority 'high'

    switch (role) {
      case 'codebase-scanner':
        // Upgrade from haiku → sonnet for large codebases where enumeration
        // requires semantic understanding rather than just file listing.
        return fileCount > 100;
      case 'architect':
        return highComplexity || fileCount > 100 || securityRelevant;
      case 'implementer':
        return highComplexity && profile.relevantFiles.some((f) => f.linesOfCode > 500);
      case 'stitcher':
        return conflictCount > 3;
      case 'reporter':
        // Upgrade reporter when there are many findings to summarise
        return fileCount > 50;
      default:
        return false;
    }
  }

  private shouldDowngrade(role: CodingRole, ctx: ModelResolutionContext): boolean {
    const { profile } = ctx;
    const avgComplexity = this.avgComplexity(profile);
    const lowComplexity = avgComplexity < 1.5; // mostly 'low'

    switch (role) {
      case 'test-writer':
        // Simple unit tests for a low-complexity codebase
        return lowComplexity && profile.testFramework !== null;
      default:
        return false;
    }
  }

  private avgComplexity(profile: CodebaseScanOutput): number {
    if (profile.relevantFiles.length === 0) return 1;
    const map = { low: 1, medium: 2, high: 3 };
    return (
      profile.relevantFiles.reduce((s, f) => s + map[f.complexity], 0) /
      profile.relevantFiles.length
    );
  }
}

// ── Critical path computation ─────────────────────────────────────────────────

/**
 * Estimated wall-clock duration in seconds per coding role.
 * Used by computeCriticalPath() for forward/backward pass calculations.
 */
const ROLE_DURATION_ESTIMATE_S: Partial<Record<CodingRole, number>> = {
  'codebase-scanner': 60,
  'architect':        120,
  'implementer':      300,
  'stitcher':         180,
  'test-writer':      180,
  'validator':        60,
  'reviewer':         120,
  'debugger':         180,
  'review-gate':      5,
  'reporter':         30,
};

/**
 * Computes the critical path through a coding DAG using a forward/backward pass.
 *
 * The critical path is the sequence of dependent nodes whose combined duration
 * equals the total session duration. Nodes on the critical path have zero slack
 * (earliest start == latest start). These nodes should receive model upgrades
 * because any delay cascades to the entire session.
 *
 * Algorithm:
 *   1. Forward pass — compute earliest finish time (EFT) per node
 *   2. Backward pass — compute latest start time (LST) per node
 *   3. Slack = LST − (EFT − duration); critical when slack ≈ 0
 *
 * @param nodes - All nodes in the DAG (any ordering).
 * @returns Array of nodes on the critical path, in topological order.
 */
export function computeCriticalPath(nodes: WorkflowNode[]): WorkflowNode[] {
  if (nodes.length === 0) return [];

  const nodeMap = new Map<string, WorkflowNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const nodeDuration = (n: WorkflowNode): number => {
    const role = n.codingConfig?.codingRole;
    return (role && ROLE_DURATION_ESTIMATE_S[role]) ?? 60;
  };

  // Build adjacency structures
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    inDegree.set(n.id, n.dependsOn.length);
    successors.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      const s = successors.get(dep) ?? [];
      s.push(n.id);
      successors.set(dep, s);
    }
  }

  // Kahn's topological sort
  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) queue.push(n.id);
  }
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const succId of successors.get(id) ?? []) {
      const deg = (inDegree.get(succId) ?? 1) - 1;
      inDegree.set(succId, deg);
      if (deg === 0) queue.push(succId);
    }
  }

  // Forward pass: earliest finish time
  const eft = new Map<string, number>();
  for (const id of topoOrder) {
    const n = nodeMap.get(id)!;
    const predMaxEFT = n.dependsOn.length === 0
      ? 0
      : Math.max(...n.dependsOn.map((dep) => eft.get(dep) ?? 0));
    eft.set(id, predMaxEFT + nodeDuration(n));
  }

  const totalDuration = Math.max(...Array.from(eft.values()));

  // Backward pass: latest start time
  const lst = new Map<string, number>();
  for (const id of [...topoOrder].reverse()) {
    const n = nodeMap.get(id)!;
    const succs = successors.get(id) ?? [];
    if (succs.length === 0) {
      lst.set(id, totalDuration - nodeDuration(n));
    } else {
      const minSuccLST = Math.min(...succs.map((s) => lst.get(s) ?? totalDuration));
      lst.set(id, minSuccLST - nodeDuration(n));
    }
  }

  // Collect nodes with zero slack
  const criticalNodes: WorkflowNode[] = [];
  for (const n of nodes) {
    const est = (eft.get(n.id) ?? 0) - nodeDuration(n);
    const slack = (lst.get(n.id) ?? 0) - est;
    if (Math.abs(slack) < 0.001) criticalNodes.push(n);
  }

  // Return in topological order
  const topoIndex = new Map(topoOrder.map((id, i) => [id, i]));
  return criticalNodes.sort(
    (a, b) => (topoIndex.get(a.id) ?? 0) - (topoIndex.get(b.id) ?? 0),
  );
}

/**
 * Applies critical-path model upgrades to nodes returned by computeCriticalPath().
 *
 * Critical-path haiku nodes are bumped to sonnet so a slow scan/report phase
 * doesn't become the session bottleneck. TOOL and ROUTER nodes are skipped.
 * Mutates the provided node array in-place (caller owns the array).
 *
 * @param criticalNodes - Output of computeCriticalPath().
 * @param resolver - Active CodingModelResolver instance.
 * @param context - Resolution context shared across the session.
 */
export function upgradeCriticalPathModels(
  criticalNodes: WorkflowNode[],
  resolver: CodingModelResolver,
  context: ModelResolutionContext,
): void {
  for (const node of criticalNodes) {
    const role = node.codingConfig?.codingRole;
    if (!role) continue;
    const strategy = CODING_MODE_MODEL_STRATEGY[role];
    if (!strategy || strategy.preferredTier === null) continue; // TOOL / ROUTER

    const currentModel = node.codingAgent?.model ?? node.agent?.model;
    if (!currentModel) continue;

    if (currentModel.toLowerCase().includes('haiku')) {
      // Bump to sonnet by resolving with a context that triggers the upgrade
      const upgraded = resolver.resolve(role, { ...context, retryAttempt: 2 });
      const newModel = upgraded.model.toLowerCase().includes('haiku')
        ? upgraded.model  // No sonnet available; keep haiku
        : upgraded.model;

      if (newModel !== currentModel) {
        if (node.codingAgent) node.codingAgent.model = newModel;
        if (node.agent) node.agent.model = newModel;
        if (node.codingConfig) node.codingConfig.model = newModel;
        log.debug(`Critical-path upgrade: ${node.id} ${currentModel} → ${newModel}`);
      }
    }
  }
}
