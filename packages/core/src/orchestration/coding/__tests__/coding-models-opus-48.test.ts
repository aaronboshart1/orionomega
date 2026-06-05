/**
 * @module orchestration/coding/__tests__/coding-models-opus-48
 *
 * Opus 4.8 compatibility tests for CodingModelResolver.
 *
 * Covers:
 * - resolve() selects claude-opus-4-8 for opus-tier roles when it is available
 * - resolve() always returns thinking.type === 'adaptive' for thinking-enabled roles
 * - resolve() returns thinking.type === 'disabled' for thinking-off roles
 * - resolve() returns the correct effort level per role
 * - resolve() attaches thinking.budgetTokens for thinking-enabled roles
 * - Backward compatibility: existing logic still works with a legacy model list
 * - Config overrides are respected and still use adaptive thinking
 */

import { describe, it, expect } from 'vitest';
import { CodingModelResolver } from '../coding-models.js';
import type { DiscoveredModel } from '../../../models/model-discovery.js';
import type { ModelResolutionContext } from '../coding-models.js';
import type { CodebaseScanOutput } from '../coding-types.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeModel(
  id: string,
  tier: DiscoveredModel['tier'],
  createdAt = '2026-01-01T00:00:00Z',
): DiscoveredModel {
  return { id, displayName: id, createdAt, tier };
}

/** Minimal CodebaseScanOutput satisfying all required fields. */
const emptyProfile: CodebaseScanOutput = {
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

/** Context for a small low-complexity codebase. */
const baseContext: ModelResolutionContext = { profile: emptyProfile };

// Model fixtures — opus-4-8 placed first (newest).
const opus48  = makeModel('claude-opus-4-8',          'opus',   '2026-06-01T00:00:00Z');
const opus46  = makeModel('claude-opus-4-6',          'opus',   '2025-06-01T00:00:00Z');
const sonnet46 = makeModel('claude-sonnet-4-6',       'sonnet', '2025-06-01T00:00:00Z');
const haiku45  = makeModel('claude-haiku-4-5-20251001','haiku',  '2025-10-01T00:00:00Z');

const allModels = [opus48, opus46, sonnet46, haiku45];

// ── Model selection ───────────────────────────────────────────────────────────

describe('CodingModelResolver — Opus 4.8 selection for opus-tier roles', () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
  });

  it('selects claude-opus-4-8 for reviewer (always opus, picks newest first)', () => {
    expect(resolver.resolve('reviewer', baseContext).model).toBe('claude-opus-4-8');
  });

  it('selects claude-opus-4-8 for debugger (always opus, picks newest first)', () => {
    expect(resolver.resolve('debugger', baseContext).model).toBe('claude-opus-4-8');
  });
});

// ── Thinking type — must be 'adaptive', never 'enabled' ──────────────────────

describe("CodingModelResolver — thinking.type is 'adaptive' for all thinking-enabled roles", () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
  });

  const thinkingRoles = [
    'architect', 'implementer', 'stitcher', 'test-writer', 'reviewer', 'debugger',
  ] as const;

  for (const role of thinkingRoles) {
    it(`${role} returns thinking.type === 'adaptive'`, () => {
      const result = resolver.resolve(role, baseContext);
      expect(result.thinking.type).toBe('adaptive');
    });
  }
});

describe("CodingModelResolver — thinking.type is 'disabled' for non-thinking roles", () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
  });

  it("codebase-scanner has thinking.type === 'disabled'", () => {
    expect(resolver.resolve('codebase-scanner', baseContext).thinking.type).toBe('disabled');
  });

  it("reporter has thinking.type === 'disabled'", () => {
    expect(resolver.resolve('reporter', baseContext).thinking.type).toBe('disabled');
  });
});

// ── Effort levels ─────────────────────────────────────────────────────────────

describe('CodingModelResolver — effort levels per role', () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
  });

  it("debugger effort is 'xhigh' (deepest thinking budget)", () => {
    expect(resolver.resolve('debugger', baseContext).effort).toBe('xhigh');
  });

  it("reviewer effort is 'high'", () => {
    expect(resolver.resolve('reviewer', baseContext).effort).toBe('high');
  });

  it("architect effort is 'high'", () => {
    expect(resolver.resolve('architect', baseContext).effort).toBe('high');
  });

  it("stitcher effort is 'medium'", () => {
    expect(resolver.resolve('stitcher', baseContext).effort).toBe('medium');
  });

  it("implementer effort is 'high'", () => {
    expect(resolver.resolve('implementer', baseContext).effort).toBe('high');
  });

  it("test-writer effort is 'medium'", () => {
    expect(resolver.resolve('test-writer', baseContext).effort).toBe('medium');
  });

  it("codebase-scanner effort is 'disabled'", () => {
    expect(resolver.resolve('codebase-scanner', baseContext).effort).toBe('disabled');
  });

  it("reporter effort is 'disabled'", () => {
    expect(resolver.resolve('reporter', baseContext).effort).toBe('disabled');
  });
});

// ── Thinking budget tokens ────────────────────────────────────────────────────

describe('CodingModelResolver — thinking.budgetTokens per role', () => {
  const resolver = new CodingModelResolver({
    discoveredModels: allModels,
    fallbackModel: 'claude-sonnet-4-6',
  });

  it('debugger has the highest budget (20000)', () => {
    const result = resolver.resolve('debugger', baseContext);
    expect(result.thinking.budgetTokens).toBe(20_000);
  });

  it('reviewer has 12000 budget tokens', () => {
    expect(resolver.resolve('reviewer', baseContext).thinking.budgetTokens).toBe(12_000);
  });

  it('architect has 16000 budget tokens', () => {
    expect(resolver.resolve('architect', baseContext).thinking.budgetTokens).toBe(16_000);
  });

  it('implementer has 10000 budget tokens', () => {
    expect(resolver.resolve('implementer', baseContext).thinking.budgetTokens).toBe(10_000);
  });

  it('stitcher has 8000 budget tokens', () => {
    expect(resolver.resolve('stitcher', baseContext).thinking.budgetTokens).toBe(8_000);
  });

  it('test-writer has 6000 budget tokens', () => {
    expect(resolver.resolve('test-writer', baseContext).thinking.budgetTokens).toBe(6_000);
  });

  it('codebase-scanner has no budget tokens (thinking disabled)', () => {
    expect(resolver.resolve('codebase-scanner', baseContext).thinking.budgetTokens).toBeUndefined();
  });

  it('reporter has no budget tokens (thinking disabled)', () => {
    expect(resolver.resolve('reporter', baseContext).thinking.budgetTokens).toBeUndefined();
  });
});

// ── Backward compatibility — legacy model list without opus-4-8 ──────────────

describe('CodingModelResolver — backward compatibility (no opus-4-8)', () => {
  const legacyModels = [opus46, sonnet46, haiku45];
  const resolver = new CodingModelResolver({
    discoveredModels: legacyModels,
    fallbackModel: 'claude-opus-4-6',
  });

  it('selects claude-opus-4-6 for reviewer when only 4-6 is available', () => {
    expect(resolver.resolve('reviewer', baseContext).model).toBe('claude-opus-4-6');
  });

  it('still uses adaptive thinking for reviewer with legacy models', () => {
    expect(resolver.resolve('reviewer', baseContext).thinking.type).toBe('adaptive');
  });

  it('selects haiku for codebase-scanner (preferred tier)', () => {
    expect(resolver.resolve('codebase-scanner', baseContext).model).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('upgrades codebase-scanner to sonnet for a large codebase (>100 files)', () => {
    const largeFiles = Array.from({ length: 101 }, (_, i) => ({
      path: `src/file${i}.ts`,
      role: 'source' as const,
      complexity: 'low' as const,
      linesOfCode: 100,
    }));
    const largeContext: ModelResolutionContext = {
      profile: { ...emptyProfile, relevantFiles: largeFiles },
    };
    expect(resolver.resolve('codebase-scanner', largeContext).model).toBe('claude-sonnet-4-6');
  });
});

// ── Config overrides ──────────────────────────────────────────────────────────

describe('CodingModelResolver — config overrides', () => {
  it('respects a per-role model override and still returns adaptive thinking', () => {
    const resolver = new CodingModelResolver({
      discoveredModels: [sonnet46, haiku45],
      fallbackModel: 'claude-sonnet-4-6',
      overrides: { reviewer: 'claude-opus-4-8' },
    });
    const result = resolver.resolve('reviewer', baseContext);
    expect(result.model).toBe('claude-opus-4-8');
    // Thinking mode comes from the role strategy, not the overridden model.
    expect(result.thinking.type).toBe('adaptive');
  });
});
