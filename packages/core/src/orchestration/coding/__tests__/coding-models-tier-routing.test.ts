/**
 * @module orchestration/coding/__tests__/coding-models-tier-routing
 *
 * Complexity-aware tier routing tests for CodingModelResolver (Task #245).
 *
 * Covers:
 * - Low-complexity codebases route implementer/architect/stitcher to the cheap
 *   (haiku) tier when routing is enabled (the default).
 * - High-complexity / large / security-relevant phases still escalate to opus.
 * - Disabling tierRouting keeps every role on its preferred (sonnet) tier.
 * - The explicit test-writer downgrade is unaffected by the routing flag.
 */

import { describe, it, expect } from 'vitest';
import { CodingModelResolver } from '../coding-models.js';
import type { DiscoveredModel } from '../../../models/model-discovery.js';
import type { ModelResolutionContext } from '../coding-models.js';
import type { CodebaseScanOutput } from '../coding-types.js';

function makeModel(
  id: string,
  tier: DiscoveredModel['tier'],
  createdAt = '2026-01-01T00:00:00Z',
): DiscoveredModel {
  return { id, displayName: id, createdAt, tier };
}

const opus48 = makeModel('claude-opus-4-8', 'opus', '2026-06-01T00:00:00Z');
const sonnet46 = makeModel('claude-sonnet-4-6', 'sonnet', '2025-06-01T00:00:00Z');
const haiku45 = makeModel('claude-haiku-4-5-20251001', 'haiku', '2025-10-01T00:00:00Z');
const allModels = [opus48, sonnet46, haiku45];

const baseProfile: CodebaseScanOutput = {
  language: 'TypeScript',
  framework: null,
  testFramework: null,
  buildSystem: null,
  lintCommand: null,
  projectStructure: '',
  relevantFiles: [],
  entryPoints: [],
  dependencies: {},
};

/** A small, low-complexity codebase context (eligible for cheap-tier routing). */
const lowComplexityContext: ModelResolutionContext = {
  profile: {
    ...baseProfile,
    relevantFiles: [
      { path: 'src/a.ts', role: 'source', complexity: 'low', linesOfCode: 40 },
      { path: 'src/b.ts', role: 'source', complexity: 'low', linesOfCode: 60 },
    ],
  },
};

/** A high-complexity context with a large file (escalation territory). */
const highComplexityContext: ModelResolutionContext = {
  profile: {
    ...baseProfile,
    relevantFiles: [
      { path: 'src/big.ts', role: 'source', complexity: 'high', linesOfCode: 900 },
      { path: 'src/c.ts', role: 'source', complexity: 'high', linesOfCode: 700 },
    ],
  },
};

describe('CodingModelResolver — complexity-aware tier routing (enabled by default)', () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
  });

  for (const role of ['implementer', 'architect', 'stitcher'] as const) {
    it(`routes ${role} to haiku on a low-complexity codebase`, () => {
      expect(resolver.resolve(role, lowComplexityContext).model).toBe(
        'claude-haiku-4-5-20251001',
      );
    });
  }

  it('keeps implementer on sonnet for a low-complexity codebase that has a large file', () => {
    const ctx: ModelResolutionContext = {
      profile: {
        ...baseProfile,
        relevantFiles: [
          { path: 'src/a.ts', role: 'source', complexity: 'low', linesOfCode: 40 },
          { path: 'src/huge.ts', role: 'source', complexity: 'low', linesOfCode: 900 },
        ],
      },
    };
    expect(resolver.resolve('implementer', ctx).model).toBe('claude-sonnet-4-6');
  });

  it('does not route to cheap tier when the work is security-relevant', () => {
    const ctx: ModelResolutionContext = { ...lowComplexityContext, securityRelevant: true };
    // architect upgrades on security-relevant work → opus, never haiku.
    expect(resolver.resolve('architect', ctx).model).toBe('claude-opus-4-8');
    // implementer stays on its preferred sonnet (no downgrade, no upgrade).
    expect(resolver.resolve('implementer', ctx).model).toBe('claude-sonnet-4-6');
  });
});

describe('CodingModelResolver — high complexity still escalates', () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
  });

  it('escalates architect to opus on a high-complexity codebase', () => {
    expect(resolver.resolve('architect', highComplexityContext).model).toBe('claude-opus-4-8');
  });

  it('escalates implementer to opus on a high-complexity codebase with large files', () => {
    expect(resolver.resolve('implementer', highComplexityContext).model).toBe('claude-opus-4-8');
  });
});

describe('CodingModelResolver — tierRouting disabled keeps preferred tier', () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
    tierRoutingEnabled: false,
  });

  for (const role of ['implementer', 'architect', 'stitcher'] as const) {
    it(`keeps ${role} on sonnet for a low-complexity codebase`, () => {
      expect(resolver.resolve(role, lowComplexityContext).model).toBe('claude-sonnet-4-6');
    });
  }

  it('still escalates to opus on high complexity even with routing disabled', () => {
    expect(resolver.resolve('architect', highComplexityContext).model).toBe('claude-opus-4-8');
  });
});

describe('CodingModelResolver — explicit test-writer downgrade independent of routing', () => {
  const lowWithFramework: ModelResolutionContext = {
    profile: { ...lowComplexityContext.profile, testFramework: 'vitest' },
  };

  it('downgrades test-writer to haiku even when tierRouting is disabled', () => {
    const resolver = new CodingModelResolver({
      discoveredModels: allModels,
      fallbackModel: 'claude-sonnet-4-6',
      tierRoutingEnabled: false,
    });
    expect(resolver.resolve('test-writer', lowWithFramework).model).toBe(
      'claude-haiku-4-5-20251001',
    );
  });
});
