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
import type { DiscoveredModel } from '../../models/model-discovery.js';
import { pickModelByTier } from '../../models/model-discovery.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('coding-models');

type ModelTier = 'haiku' | 'sonnet' | 'opus';

interface ModelStrategy {
  /** Preferred model tier for normal conditions. */
  preferredTier: ModelTier | null;
  /** Tier to use when upgrade condition is met (null = no upgrade). */
  upgradeTier: ModelTier | null;
  /** Tier to use when downgrade condition is met (null = no downgrade). */
  downgradeTier: ModelTier | null;
  /** Whether to enable adaptive thinking mode (extended thinking). */
  thinkingMode: 'adaptive' | 'disabled';
}

/** Role-based model strategy map. */
const CODING_MODE_MODEL_STRATEGY: Record<CodingRole, ModelStrategy> = {
  'codebase-scanner': {
    preferredTier: 'haiku',
    upgradeTier:   'sonnet',
    downgradeTier: null,
    thinkingMode:  'disabled',  // Read-only enumeration; speed over quality
  },
  'architect': {
    preferredTier: 'sonnet',
    upgradeTier:   'opus',
    downgradeTier: null,
    thinkingMode:  'adaptive',  // May need deep reasoning for design decisions
  },
  'implementer': {
    preferredTier: 'sonnet',
    upgradeTier:   'opus',
    downgradeTier: null,
    thinkingMode:  'adaptive',
  },
  'stitcher': {
    preferredTier: 'sonnet',
    upgradeTier:   'opus',
    downgradeTier: null,
    thinkingMode:  'adaptive',
  },
  'test-writer': {
    preferredTier: 'sonnet',
    upgradeTier:   null,
    downgradeTier: 'haiku',   // Downgrade for simple unit tests
    thinkingMode:  'adaptive',
  },
  'validator': {
    preferredTier: null,      // TOOL node — no model needed
    upgradeTier:   null,
    downgradeTier: null,
    thinkingMode:  'disabled',
  },
  'reviewer': {
    preferredTier: 'sonnet',
    upgradeTier:   'opus',
    downgradeTier: null,
    thinkingMode:  'adaptive',
  },
  'reporter': {
    preferredTier: 'haiku',
    upgradeTier:   'sonnet',
    downgradeTier: null,
    thinkingMode:  'disabled', // Summary is simple; minimize cost
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
  ): { model: string; thinking: { type: string } } {
    // 1. Check config override
    const override = this.overrides[role];
    if (override) {
      log.debug(`Role ${role}: using config override → ${override}`);
      return {
        model: override,
        thinking: { type: CODING_MODE_MODEL_STRATEGY[role].thinkingMode },
      };
    }

    const strategy = CODING_MODE_MODEL_STRATEGY[role];

    // TOOL node (validator) — no model
    if (strategy.preferredTier === null) {
      return { model: '', thinking: { type: 'disabled' } };
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
      thinking: { type: strategy.thinkingMode },
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
    const { profile, conflictCount = 0, securityRelevant = false } = ctx;
    const fileCount = profile.relevantFiles.length;
    const avgComplexity = this.avgComplexity(profile);
    const highComplexity = avgComplexity >= 2.5; // majority 'high'

    switch (role) {
      case 'architect':
        return highComplexity || fileCount > 100;
      case 'implementer':
        return highComplexity && profile.relevantFiles.some((f) => f.linesOfCode > 500);
      case 'stitcher':
        return conflictCount > 3;
      case 'reviewer':
        return securityRelevant || highComplexity;
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
