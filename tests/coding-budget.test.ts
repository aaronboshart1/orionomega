/**
 * Unit tests for CodingBudgetAllocator and its pure helper functions.
 *
 * Covers: complexityMultiplier, estimateMaxTurns, estimateTokenBudget,
 * CodingBudgetAllocator.allocate(), and CodingBudgetAllocator.adjustForRetry().
 */

import {
  suite, section, assert, assertEq, assertApprox, assertGt, assertLt, printSummary,
} from './test-harness.js';
import {
  CodingBudgetAllocator,
  complexityMultiplier,
  estimateMaxTurns,
  estimateTokenBudget,
  type NodeDescriptor,
} from '../packages/core/src/orchestration/coding/coding-budget.js';
import type { CodebaseScanOutput } from '../packages/core/src/orchestration/coding/coding-types.js';

suite('CodingBudgetAllocator Unit Tests');

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Section 1: complexityMultiplier ───────────────────────────────────────────

section('1. complexityMultiplier()');

{
  const empty = makeProfile([]);
  assertEq(
    complexityMultiplier(empty),
    0.5,
    '1.1 empty file list → 0.5 (minimum)',
  );
}

{
  // 20 medium-complexity files → fileScale=1.0, complexityScale=1.0 → 1.0
  const profile = makeProfile(Array(20).fill({ complexity: 'medium' }));
  assertApprox(
    complexityMultiplier(profile),
    0.9, 1.1,
    '1.2 20 medium-complexity files → ~1.0',
  );
}

{
  // 1 low-complexity file → small fileScale, low complexityScale
  const profile = makeProfile([{ complexity: 'low' }]);
  const mult = complexityMultiplier(profile);
  assertGt(0.5, 0.0, '1.3 single low-complexity file mult is positive');
  assertLt(mult, 1.0, '1.3 single low-complexity file mult < 1.0');
}

{
  // 40 high-complexity files → would be 2.0 × 1.5 = 3.0 but capped at 3.0
  const profile = makeProfile(Array(40).fill({ complexity: 'high' }));
  assertEq(complexityMultiplier(profile), 3.0, '1.4 many high-complexity files → 3.0 (maximum)');
}

{
  // 10 medium files → fileScale=0.5, complexityScale=1.0 → 0.5 (below min of 0.5)
  // Actually: fileScale = min(10/20, 2.0) = 0.5; complexityScale = 2/2 = 1.0
  // result = max(0.5, min(0.5 * 1.0, 3.0)) = max(0.5, 0.5) = 0.5
  const profile = makeProfile(Array(10).fill({ complexity: 'medium' }));
  assertApprox(complexityMultiplier(profile), 0.4, 0.6, '1.5 10 medium files → ~0.5');
}

// ── Section 2: estimateMaxTurns ───────────────────────────────────────────────

section('2. estimateMaxTurns()');

{
  assertEq(
    estimateMaxTurns('validator', 1.0, 'claude-sonnet-4-6'),
    0,
    '2.1 validator role always returns 0 turns',
  );
}

{
  // Sonnet: $3/M tokens. Implementer: 8000 tokens/turn → $0.024/turn
  // budgetUsd=1.0 → turns = floor(1.0 / 0.024) ≈ 41, clamped to [5,100]
  const turns = estimateMaxTurns('implementer', 1.0, 'claude-sonnet-4-6');
  assertGt(turns, 5, '2.2 implementer/sonnet turns > 5 for $1 budget');
  assertLt(turns, 101, '2.2 implementer/sonnet turns ≤ 100');
}

{
  // Haiku: $0.80/M tokens. Implementer: 8000 tokens/turn → $0.0064/turn
  // budgetUsd=1.0 → turns = floor(1.0 / 0.0064) ≈ 156, clamped to 100
  const haiku = estimateMaxTurns('implementer', 1.0, 'claude-haiku-4-5');
  const sonnet = estimateMaxTurns('implementer', 1.0, 'claude-sonnet-4-6');
  assertGt(haiku, sonnet, '2.3 haiku gets more turns per dollar than sonnet');
}

{
  // Opus: $15/M tokens. Same budget → fewer turns
  const opus = estimateMaxTurns('architect', 0.5, 'claude-opus-4-6');
  const sonnet = estimateMaxTurns('architect', 0.5, 'claude-sonnet-4-6');
  assertLt(opus, sonnet, '2.4 opus gets fewer turns per dollar than sonnet');
}

{
  // Minimum clamp: very small budget → at least 5 turns
  const turns = estimateMaxTurns('reporter', 0.001, 'claude-sonnet-4-6');
  assertEq(turns, 5, '2.5 tiny budget → clamped to minimum 5 turns');
}

// ── Section 3: estimateTokenBudget ────────────────────────────────────────────

section('3. estimateTokenBudget()');

{
  assertEq(
    estimateTokenBudget('validator', 1.0, 'claude-sonnet-4-6'),
    0,
    '3.1 validator role returns 0 token budget',
  );
}

{
  // Sonnet: $3/M tokens. budgetUsd=1.0 → (1.0 / 3.0) * 1M * 0.6 = 200,000 tokens
  const tokens = estimateTokenBudget('architect', 1.0, 'claude-sonnet-4-6');
  assertGt(tokens, 100_000, '3.2 architect/sonnet token budget > 100k for $1');
  assertLt(tokens, 1_000_000, '3.2 architect/sonnet token budget < 1M for $1');
}

{
  // Haiku is cheaper → more tokens per dollar
  const haiku = estimateTokenBudget('codebase-scanner', 1.0, 'claude-haiku-4-5');
  const sonnet = estimateTokenBudget('codebase-scanner', 1.0, 'claude-sonnet-4-6');
  assertGt(haiku, sonnet, '3.3 haiku produces more tokens per dollar than sonnet');
}

// ── Section 4: CodingBudgetAllocator.allocate() ───────────────────────────────

section('4. CodingBudgetAllocator.allocate()');

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

{
  const allocator = new CodingBudgetAllocator();
  const result = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

  assertEq(result.perNode.size, 7, '4.1 allocate returns budget for all 7 nodes');
  assert(result.perNode.has('codebase-scan'), '4.1 codebase-scan has a budget entry');
  assert(result.perNode.has('summary-report'), '4.1 summary-report has a budget entry');
}

{
  const allocator = new CodingBudgetAllocator();
  const result = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

  // Reserve should be ~15% of total
  const totalBefore = result.estimated;
  assertGt(totalBefore, 0, '4.2 estimated total is positive');
  assertGt(result.reserve, 0, '4.2 reserve is positive');

  // Reserve ≈ 15% of raw total (before clamping)
  // With medium 20-file profile, complexityMultiplier ≈ 1.0
  // Default budget for feature-implementation = $10, reserve = $1.5
  assertApprox(result.reserve, 1.0, 2.5, '4.2 reserve is approximately 15% of budget');
}

{
  const allocator = new CodingBudgetAllocator();
  const result = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

  // Validator has weight=0 → raw budget = 0 → clamped to 0 minimum (no entry in MIN map)
  const validatorBudget = result.perNode.get('validation-loop');
  assertEq(validatorBudget?.maxBudgetUsd, 0, '4.3 validator node gets $0 budget (TOOL node)');
  assertEq(validatorBudget?.maxTurns, 0, '4.3 validator node gets 0 turns');
}

{
  const allocator = new CodingBudgetAllocator();
  const result = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

  // Implementer weight is 0.35 — largest allocation
  const implBudget = result.perNode.get('impl-placeholder')?.maxBudgetUsd ?? 0;
  const scanBudget = result.perNode.get('codebase-scan')?.maxBudgetUsd ?? 0;
  assertGt(implBudget, scanBudget, '4.4 implementer gets more budget than scanner');
}

{
  // With 3 implementer nodes, budget is split evenly
  const threeImplNodes = makeNodes([
    { id: 'impl-0', codingRole: 'implementer' },
    { id: 'impl-1', codingRole: 'implementer' },
    { id: 'impl-2', codingRole: 'implementer' },
  ]);
  const allocator = new CodingBudgetAllocator();
  const result = allocator.allocate('bug-fix', mediumProfile, threeImplNodes);

  const b0 = result.perNode.get('impl-0')?.maxBudgetUsd ?? 0;
  const b1 = result.perNode.get('impl-1')?.maxBudgetUsd ?? 0;
  const b2 = result.perNode.get('impl-2')?.maxBudgetUsd ?? 0;
  assertApprox(b0, b1 - 0.01, b1 + 0.01, '4.5 implementer budgets are equal (split evenly)');
  assertApprox(b0, b2 - 0.01, b2 + 0.01, '4.5 implementer budgets are equal (split evenly)');
}

{
  // Budget multiplier scales up allocation
  const allocator1 = new CodingBudgetAllocator({ budgetMultiplier: 1.0 });
  const allocator2 = new CodingBudgetAllocator({ budgetMultiplier: 2.0 });
  const r1 = allocator1.allocate('feature-implementation', mediumProfile, standardNodes);
  const r2 = allocator2.allocate('feature-implementation', mediumProfile, standardNodes);

  assertGt(r2.estimated, r1.estimated, '4.6 2× budget multiplier increases total estimated spend');
}

{
  // Total budget override
  const allocator = new CodingBudgetAllocator({ totalBudgetUsd: 3.0 });
  const result = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

  // With medium complexity (mult≈1.0) and $3 total: reserve = $0.45, spend = $2.55
  assertLt(result.estimated, 5.0, '4.7 totalBudgetUsd override caps spend');
}

{
  // Bug-fix template has lower default ($5 vs $10)
  const allocBugFix = new CodingBudgetAllocator();
  const allocFeature = new CodingBudgetAllocator();
  const rBug = allocBugFix.allocate('bug-fix', mediumProfile, standardNodes);
  const rFeat = allocFeature.allocate('feature-implementation', mediumProfile, standardNodes);

  assertLt(rBug.estimated, rFeat.estimated, '4.8 bug-fix template has lower default budget than feature-implementation');
}

// ── Section 5: CodingBudgetAllocator.adjustForRetry() ────────────────────────

section('5. adjustForRetry()');

{
  const allocator = new CodingBudgetAllocator();
  const allocation = allocator.allocate('feature-implementation', mediumProfile, standardNodes);
  const origReserve = allocation.reserve;

  const implBefore = allocation.perNode.get('impl-placeholder')?.maxBudgetUsd ?? 0;
  const adjusted = allocator.adjustForRetry(allocation, 'impl-placeholder', 'implementer', 1);

  const implAfter = adjusted.perNode.get('impl-placeholder')?.maxBudgetUsd ?? 0;
  assertGt(implAfter, implBefore, '5.1 adjustForRetry increases node budget');
  assertLt(adjusted.reserve, origReserve, '5.1 adjustForRetry draws from reserve');
}

{
  const allocator = new CodingBudgetAllocator();
  const allocation = allocator.allocate('feature-implementation', mediumProfile, standardNodes);

  // adjustForRetry on unknown node returns original
  const unchanged = allocator.adjustForRetry(allocation, 'nonexistent-node', 'implementer', 1);
  assertEq(
    unchanged.perNode.get('impl-placeholder')?.maxBudgetUsd,
    allocation.perNode.get('impl-placeholder')?.maxBudgetUsd,
    '5.2 adjustForRetry on unknown node is a no-op',
  );
}

{
  const allocator = new CodingBudgetAllocator();
  const allocation = allocator.allocate('feature-implementation', mediumProfile, standardNodes);
  const origTurns = allocation.perNode.get('codebase-scan')?.maxTurns ?? 0;

  const adjusted = allocator.adjustForRetry(allocation, 'codebase-scan', 'codebase-scanner', 2);
  const newTurns = adjusted.perNode.get('codebase-scan')?.maxTurns ?? 0;
  assertGt(newTurns, origTurns, '5.3 adjustForRetry increases maxTurns on retry');
}

// ── Summary ───────────────────────────────────────────────────────────────────

const ok = printSummary('CodingBudgetAllocator');
if (!ok) process.exit(1);
