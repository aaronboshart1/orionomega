/**
 * @module orchestration/coding/coding-budget
 * Complexity-weighted token budget allocation for Coding Mode workflows.
 *
 * Distributes a total USD budget across DAG nodes using role-based weights
 * scaled by the codebase complexity profile. Enforces per-node guardrails
 * (minimums and maximums) and reserves 15% for retries and re-planning.
 */

import type {
  CodingRole,
  CodingDAGTemplate,
  CodebaseScanOutput,
  BudgetAllocation,
  NodeBudget,
} from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('coding-budget');

// ── Role Weights ─────────────────────────────────────────────────────────────

/** Fraction of total workflow budget allocated to each role. Must sum to 0.85 (15% reserved). */
const ROLE_BUDGET_WEIGHTS: Record<CodingRole, number> = {
  'codebase-scanner': 0.05,
  'architect':        0.10,
  'implementer':      0.35,  // Split evenly across N parallel chunks
  'stitcher':         0.10,
  'test-writer':      0.15,
  'validator':        0.00,  // TOOL node — no LLM cost
  'reviewer':         0.08,
  'reporter':         0.02,
};

const RESERVE_FRACTION = 0.15;

// ── Guardrails ────────────────────────────────────────────────────────────────

const MIN_PER_NODE_USD: Partial<Record<CodingRole, number>> = {
  'codebase-scanner': 0.05,
  'architect':        0.10,
  'implementer':      0.20,
  'stitcher':         0.15,
  'test-writer':      0.15,
  'reviewer':         0.10,
  'reporter':         0.03,
};

const MAX_PER_NODE_USD: Partial<Record<CodingRole, number>> = {
  'codebase-scanner': 0.50,
  'architect':        1.50,
  'implementer':      3.00,
  'stitcher':         2.00,
  'test-writer':      2.50,
  'reviewer':         1.50,
  'reporter':         0.30,
};

const MAX_WORKFLOW_BUDGET_USD = 25.00;

// ── Token/Turn Estimation ─────────────────────────────────────────────────────

/** Average total tokens (input + output) consumed per agentic turn, by role. */
const AVG_TOKENS_PER_TURN: Record<CodingRole, number> = {
  'codebase-scanner': 3_000,
  'architect':        5_000,
  'implementer':      8_000,
  'stitcher':         6_000,
  'test-writer':      7_000,
  'validator':        0,
  'reviewer':         4_000,
  'reporter':         2_000,
};

/** Per-model-tier cost rates (USD per million tokens). */
export interface ModelCostRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Accurate per-model-tier pricing (as of 2026 Anthropic pricing).
 * Separate input/output rates for precise cost calculation.
 */
export const MODEL_COST_RATES: Record<string, ModelCostRate> = {
  haiku:  { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  sonnet: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  opus:   { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
};

/** Blended cost per million tokens for backward-compatible budget estimation. */
const MODEL_COST_PER_MILLION_TOKENS: Record<string, number> = {
  haiku:  1.60,    // weighted blend: 60% input + 40% output
  sonnet: 7.80,    // weighted blend: 60% input + 40% output
  opus:   39.00,   // weighted blend: 60% input + 40% output
};

/**
 * Calculate precise cost from token counts using per-tier rates.
 * @param model - Model ID string (matched to tier by keyword).
 * @param inputTokens - Number of input tokens.
 * @param outputTokens - Number of output tokens.
 * @param cacheReadTokens - Number of cache read tokens.
 * @param cacheWriteTokens - Number of cache write/creation tokens.
 * @returns Cost in USD.
 */
export function calculateTokenCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const tier = resolveModelTier(model);
  const rates = MODEL_COST_RATES[tier] ?? MODEL_COST_RATES.sonnet;
  return (
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output +
    (cacheReadTokens / 1_000_000) * rates.cacheRead +
    (cacheWriteTokens / 1_000_000) * rates.cacheWrite
  );
}

// ── Template Default Budgets (USD) ────────────────────────────────────────────

const TEMPLATE_DEFAULT_BUDGETS: Record<CodingDAGTemplate, number> = {
  'feature-implementation': 10.00,
  'bug-fix':                5.00,
  'refactor':               8.00,
  'test-suite':             6.00,
  'review-iterate':         6.00,
};

// ── Node descriptor (minimal shape needed here) ───────────────────────────────

export interface NodeDescriptor {
  id: string;
  codingRole: CodingRole;
  model: string;  // Resolved model ID (used to pick cost tier)
}

// ── Allocator ─────────────────────────────────────────────────────────────────

export class CodingBudgetAllocator {
  private readonly budgetMultiplier: number;
  private readonly totalBudgetOverride?: number;

  constructor(opts: { budgetMultiplier?: number; totalBudgetUsd?: number } = {}) {
    this.budgetMultiplier = opts.budgetMultiplier ?? 1.0;
    this.totalBudgetOverride = opts.totalBudgetUsd;
  }

  /**
   * Allocate budget across all nodes in a coding DAG.
   *
   * @param template - The selected DAG template (determines default total budget).
   * @param profile - Codebase complexity profile from the scanner node.
   * @param nodes - Descriptor array of nodes (with resolved model IDs).
   * @returns BudgetAllocation with per-node NodeBudget instances.
   */
  allocate(
    template: CodingDAGTemplate,
    profile: CodebaseScanOutput,
    nodes: NodeDescriptor[],
  ): BudgetAllocation {
    // 1. Determine raw total budget
    const rawTotal = this.totalBudgetOverride
      ?? TEMPLATE_DEFAULT_BUDGETS[template];

    // 2. Apply complexity multiplier and user multiplier
    const complexMult = complexityMultiplier(profile);
    const totalBudget = Math.min(
      rawTotal * complexMult * this.budgetMultiplier,
      MAX_WORKFLOW_BUDGET_USD,
    );

    log.debug(
      `Budget: raw=${rawTotal} complexity×=${complexMult.toFixed(2)} ` +
      `user×=${this.budgetMultiplier} → total=${totalBudget.toFixed(2)} USD`,
    );

    // 3. Reserve 15%
    const reserve = totalBudget * RESERVE_FRACTION;
    const spendable = totalBudget - reserve;

    // 4. Count implementer nodes for fair splitting
    const implementerCount = nodes.filter((n) => n.codingRole === 'implementer').length || 1;

    // 5. Allocate per-node
    const perNode = new Map<string, NodeBudget>();
    let allocated = 0;

    for (const node of nodes) {
      const role = node.codingRole;
      let weight = ROLE_BUDGET_WEIGHTS[role] ?? 0;

      // Split implementer weight evenly across all implementer nodes
      if (role === 'implementer') {
        weight = weight / implementerCount;
      }

      const rawBudget = spendable * weight;

      // Apply guardrails
      const minBudget = MIN_PER_NODE_USD[role] ?? 0;
      const maxBudget = MAX_PER_NODE_USD[role] ?? rawBudget;
      const clampedBudget = Math.max(minBudget, Math.min(rawBudget, maxBudget));

      const maxTurns = estimateMaxTurns(role, clampedBudget, node.model);
      const tokenBudget = estimateTokenBudget(role, clampedBudget, node.model);

      perNode.set(node.id, {
        maxBudgetUsd: clampedBudget,
        maxTurns,
        tokenBudget,
        model: node.model,
      });

      allocated += clampedBudget;
    }

    log.info(
      `Budget allocated: ${nodes.length} nodes, ` +
      `${allocated.toFixed(2)} USD active, ` +
      `${reserve.toFixed(2)} USD reserve`,
    );

    return { perNode, reserve, estimated: allocated + reserve };
  }

  /**
   * Adjust a single node's budget for a retry attempt.
   * Draws from the reserve and increases the node's budget by 50%, capped at the
   * role maximum.
   *
   * @param allocation - Current allocation to mutate.
   * @param failedNodeId - ID of the node to adjust.
   * @param role - The role of the failed node.
   * @param attempt - Retry attempt number (1-indexed).
   * @returns Updated BudgetAllocation.
   */
  adjustForRetry(
    allocation: BudgetAllocation,
    failedNodeId: string,
    role: CodingRole,
    attempt: number,
  ): BudgetAllocation {
    const existing = allocation.perNode.get(failedNodeId);
    if (!existing) return allocation;

    // Draw from reserve (up to 25% of reserve per retry)
    const drawFraction = 0.25;
    const draw = Math.min(allocation.reserve * drawFraction, allocation.reserve);

    const maxBudget = MAX_PER_NODE_USD[role] ?? existing.maxBudgetUsd * 2;
    const newBudget = Math.min(existing.maxBudgetUsd + draw, maxBudget);

    const newAllocation: BudgetAllocation = {
      reserve: allocation.reserve - (newBudget - existing.maxBudgetUsd),
      estimated: allocation.estimated,
      perNode: new Map(allocation.perNode),
    };

    newAllocation.perNode.set(failedNodeId, {
      ...existing,
      maxBudgetUsd: newBudget,
      maxTurns: Math.floor(existing.maxTurns * (1 + 0.3 * attempt)),
    });

    log.debug(
      `Retry budget adjustment: node=${failedNodeId} ` +
      `budget ${existing.maxBudgetUsd.toFixed(2)} → ${newBudget.toFixed(2)} USD, ` +
      `reserve: ${allocation.reserve.toFixed(2)} → ${newAllocation.reserve.toFixed(2)}`,
    );

    return newAllocation;
  }
}

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Computes a complexity multiplier based on the codebase profile.
 * Ranges from 0.5 (tiny trivial codebase) to 3.0 (large, complex codebase).
 */
export function complexityMultiplier(profile: CodebaseScanOutput): number {
  const fileCount = profile.relevantFiles.length;
  if (fileCount === 0) return 0.5;

  const complexityMap: Record<'low' | 'medium' | 'high', number> = { low: 1, medium: 2, high: 3 };
  const avgComplexity =
    profile.relevantFiles.reduce(
      (sum, f) => sum + complexityMap[f.complexity],
      0,
    ) / fileCount;

  const fileScale = Math.min(fileCount / 20, 2.0);   // 20 files = 1.0×
  const complexityScale = avgComplexity / 2;          // medium = 1.0×

  return Math.max(0.5, Math.min(fileScale * complexityScale, 3.0));
}

/**
 * Estimates the maximum number of agentic turns for a node given its budget.
 * Clamps to [5, 100].
 */
export function estimateMaxTurns(
  role: CodingRole,
  budgetUsd: number,
  model: string,
): number {
  if (role === 'validator') return 0;

  const tier = resolveModelTier(model);
  const costPerMillion = MODEL_COST_PER_MILLION_TOKENS[tier] ?? 3.00;
  const avgTokens = AVG_TOKENS_PER_TURN[role];

  if (avgTokens === 0 || costPerMillion === 0) return 0;

  const costPerTurn = (avgTokens / 1_000_000) * costPerMillion;
  return Math.max(5, Math.min(Math.floor(budgetUsd / costPerTurn), 100));
}

/**
 * Estimates input token budget for a node.
 * Used as a soft context window hint (not a hard limit).
 */
export function estimateTokenBudget(
  role: CodingRole,
  budgetUsd: number,
  model: string,
): number {
  if (role === 'validator') return 0;

  const tier = resolveModelTier(model);
  const rates = MODEL_COST_RATES[tier] ?? MODEL_COST_RATES.sonnet;

  // Estimate input tokens the budget can cover using the input cost rate
  return Math.floor((budgetUsd / rates.input) * 1_000_000 * 0.6);
}

function resolveModelTier(modelId: string): 'haiku' | 'sonnet' | 'opus' {
  const lower = modelId.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}
