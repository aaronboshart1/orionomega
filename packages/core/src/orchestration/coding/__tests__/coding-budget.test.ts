/**
 * @module __tests__/coding-budget
 * Unit tests for CodingBudgetAllocator and its pure helpers —
 * complexityMultiplier, estimateTokenBudget, allocate(), adjustForRetry().
 */

import { describe, it, expect } from 'vitest';
import {
  CodingBudgetAllocator,
  complexityMultiplier,
  estimateTokenBudget,
  type NodeDescriptor,
} from '../coding-budget.js';
import type { CodebaseScanOutput } from '../coding-types.js';

function makeProfile(
  files: Array<{ complexity: 'low' | 'medium' | 'high'; linesOfCode?: number }>,
  overrides: Partial<CodebaseScanOutput> = {},
): CodebaseScanOutput {
  return {
    language: 'typescript',
    framework: null,
    testFramework: null,
    buildSystem: null,
    lintCommand: null,
    projectStructure: '',
    relevantFiles: files.map((f, i) => ({
      path: `src/file${i}.ts`,
      role: 'source' as const,
      complexity: f.complexity,
      linesOfCode: f.linesOfCode ?? 100,
    })),
    entryPoints: [],
    dependencies: {},
    ...overrides,
  };
}

function makeNodes(roles: Array<{ id: string; codingRole: string }>): NodeDescriptor[] {
  return roles.map((r) => ({
    id: r.id,
    codingRole: r.codingRole as NodeDescriptor['codingRole'],
    model: 'claude-sonnet-4-6',
  }));
}

const standardNodes = makeNodes([
  { id: 'codebase-scan', codingRole: 'codebase-scanner' },
  { id: 'architecture-design', codingRole: 'architect' },
  { id: 'impl-placeholder', codingRole: 'implementer' },
  { id: 'integration-stitch', codingRole: 'stitcher' },
  { id: 'test-generation', codingRole: 'test-writer' },
  { id: 'validation-loop', codingRole: 'validator' },
  { id: 'summary-report', codingRole: 'reporter' },
]);

const mediumProfile = makeProfile(Array(20).fill({ complexity: 'medium' }));

describe('complexityMultiplier', () => {
  it('floors at 0.5 for an empty file list', () => {
    expect(complexityMultiplier(makeProfile([]))).toBe(0.5);
  });

  it('lands near 1.0 for 20 medium-complexity files', () => {
    const mult = complexityMultiplier(makeProfile(Array(20).fill({ complexity: 'medium' })));
    expect(mult).toBeGreaterThan(0.9);
    expect(mult).toBeLessThan(1.1);
  });

  it('stays positive but below 1.0 for a single low-complexity file', () => {
    const mult = complexityMultiplier(makeProfile([{ complexity: 'low' }]));
    expect(mult).toBeGreaterThan(0);
    expect(mult).toBeLessThan(1.0);
  });

  it('caps at 3.0 for many high-complexity files', () => {
    expect(complexityMultiplier(makeProfile(Array(40).fill({ complexity: 'high' })))).toBe(3.0);
  });

  it('lands near 0.5 for 10 medium files', () => {
    const mult = complexityMultiplier(makeProfile(Array(10).fill({ complexity: 'medium' })));
    expect(mult).toBeGreaterThan(0.4);
    expect(mult).toBeLessThan(0.6);
  });
});

describe('estimateTokenBudget', () => {
  it('gives the validator role no token budget', () => {
    expect(estimateTokenBudget('validator', 1.0, 'claude-sonnet-4-6')).toBe(0);
  });

  it('scales a $1 architect budget into a sane token range for sonnet', () => {
    const tokens = estimateTokenBudget('architect', 1.0, 'claude-sonnet-4-6');
    expect(tokens).toBeGreaterThan(100_000);
    expect(tokens).toBeLessThan(1_000_000);
  });

  it('buys more tokens per dollar on haiku than on sonnet', () => {
    const haiku = estimateTokenBudget('codebase-scanner', 1.0, 'claude-haiku-4-5');
    const sonnet = estimateTokenBudget('codebase-scanner', 1.0, 'claude-sonnet-4-6');
    expect(haiku).toBeGreaterThan(sonnet);
  });
});

describe('CodingBudgetAllocator.allocate', () => {
  it('returns a budget entry for every node', () => {
    const result = new CodingBudgetAllocator().allocate('feature-implementation', mediumProfile, standardNodes);

    expect(result.perNode.size).toBe(7);
    expect(result.perNode.has('codebase-scan')).toBe(true);
    expect(result.perNode.has('summary-report')).toBe(true);
  });

  it('holds back a positive reserve alongside a positive estimate', () => {
    const result = new CodingBudgetAllocator().allocate('feature-implementation', mediumProfile, standardNodes);

    expect(result.estimated).toBeGreaterThan(0);
    expect(result.reserve).toBeGreaterThan(0);
    // ~15% of the $10 feature-implementation default at complexity multiplier ≈ 1.0.
    expect(result.reserve).toBeGreaterThan(1.0);
    expect(result.reserve).toBeLessThan(2.5);
  });

  it('gives the validator (a TOOL node) a $0 budget', () => {
    const result = new CodingBudgetAllocator().allocate('feature-implementation', mediumProfile, standardNodes);

    expect(result.perNode.get('validation-loop')?.maxBudgetUsd).toBe(0);
  });

  it('weights the implementer above the scanner', () => {
    const result = new CodingBudgetAllocator().allocate('feature-implementation', mediumProfile, standardNodes);

    const impl = result.perNode.get('impl-placeholder')?.maxBudgetUsd ?? 0;
    const scan = result.perNode.get('codebase-scan')?.maxBudgetUsd ?? 0;
    expect(impl).toBeGreaterThan(scan);
  });

  it('splits the implementer budget evenly across parallel implementer nodes', () => {
    const threeImplNodes = makeNodes([
      { id: 'impl-0', codingRole: 'implementer' },
      { id: 'impl-1', codingRole: 'implementer' },
      { id: 'impl-2', codingRole: 'implementer' },
    ]);
    const result = new CodingBudgetAllocator().allocate('bug-fix', mediumProfile, threeImplNodes);

    const b0 = result.perNode.get('impl-0')?.maxBudgetUsd ?? 0;
    const b1 = result.perNode.get('impl-1')?.maxBudgetUsd ?? 0;
    const b2 = result.perNode.get('impl-2')?.maxBudgetUsd ?? 0;
    expect(b0).toBeCloseTo(b1, 2);
    expect(b0).toBeCloseTo(b2, 2);
  });

  it('scales total spend with the budget multiplier', () => {
    const r1 = new CodingBudgetAllocator({ budgetMultiplier: 1.0 })
      .allocate('feature-implementation', mediumProfile, standardNodes);
    const r2 = new CodingBudgetAllocator({ budgetMultiplier: 2.0 })
      .allocate('feature-implementation', mediumProfile, standardNodes);

    expect(r2.estimated).toBeGreaterThan(r1.estimated);
  });

  it('caps spend via the totalBudgetUsd override', () => {
    const result = new CodingBudgetAllocator({ totalBudgetUsd: 3.0 })
      .allocate('feature-implementation', mediumProfile, standardNodes);

    expect(result.estimated).toBeLessThan(5.0);
  });

  it('defaults bug-fix to a smaller budget than feature-implementation', () => {
    const rBug = new CodingBudgetAllocator().allocate('bug-fix', mediumProfile, standardNodes);
    const rFeat = new CodingBudgetAllocator().allocate('feature-implementation', mediumProfile, standardNodes);

    expect(rBug.estimated).toBeLessThan(rFeat.estimated);
  });
});

describe('CodingBudgetAllocator.adjustForRetry', () => {
  it('raises the retried node budget by drawing from the reserve', () => {
    const allocator = new CodingBudgetAllocator();
    const allocation = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

    const before = allocation.perNode.get('impl-placeholder')?.maxBudgetUsd ?? 0;
    const adjusted = allocator.adjustForRetry(allocation, 'impl-placeholder', 'implementer', 1);

    expect(adjusted.perNode.get('impl-placeholder')?.maxBudgetUsd ?? 0).toBeGreaterThan(before);
    expect(adjusted.reserve).toBeLessThan(allocation.reserve);
  });

  it('is a no-op for an unknown node', () => {
    const allocator = new CodingBudgetAllocator();
    const allocation = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

    const unchanged = allocator.adjustForRetry(allocation, 'nonexistent-node', 'implementer', 1);

    expect(unchanged.perNode.get('impl-placeholder')?.maxBudgetUsd)
      .toBe(allocation.perNode.get('impl-placeholder')?.maxBudgetUsd);
  });
});
