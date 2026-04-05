/**
 * Unit tests for CodingModelResolver.
 *
 * Covers: config overrides, validator role, tier selection with mock models,
 * upgrade/downgrade conditions, and resolveAll().
 */

import {
  suite, section, assert, assertEq, printSummary,
} from './test-harness.js';
import { CodingModelResolver } from '../packages/core/src/orchestration/coding/coding-models.js';
import type {
  CodingRole,
  CodebaseScanOutput,
} from '../packages/core/src/orchestration/coding/coding-types.js';
import type { DiscoveredModel } from '../packages/core/src/models/model-discovery.js';

suite('CodingModelResolver Unit Tests');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProfile(
  complexity: 'low' | 'medium' | 'high',
  fileCount: number,
  linesOfCode = 100,
): CodebaseScanOutput {
  return {
    language: 'typescript',
    framework: null,
    testFramework: null,
    buildSystem: null,
    lintCommand: null,
    projectStructure: '',
    relevantFiles: Array(fileCount).fill({
      path: 'src/file.ts',
      role: 'source',
      complexity,
      linesOfCode,
    }),
    entryPoints: [],
    dependencies: {},
  };
}

function makeModel(id: string): DiscoveredModel {
  const lower = id.toLowerCase();
  const tier: DiscoveredModel['tier'] =
    lower.includes('opus') ? 'opus' :
    lower.includes('sonnet') ? 'sonnet' :
    lower.includes('haiku') ? 'haiku' : 'unknown';
  return {
    id,
    displayName: id,
    createdAt: '2025-01-01T00:00:00Z',
    tier,
  };
}

const MOCK_MODELS: DiscoveredModel[] = [
  makeModel('claude-opus-4-6'),
  makeModel('claude-sonnet-4-6'),
  makeModel('claude-haiku-4-5'),
];

const FALLBACK = 'claude-sonnet-4-6';

const mediumProfile = makeProfile('medium', 20);
const highProfile = makeProfile('high', 120, 600);
const lowProfile = makeProfile('low', 5, 50);

const medCtx = { profile: mediumProfile };
const highCtx = { profile: highProfile };
const lowCtx = { profile: lowProfile };

// ── Section 1: Config overrides ───────────────────────────────────────────────

section('1. Config overrides');

{
  const resolver = new CodingModelResolver({
    overrides: { 'implementer': 'custom-impl-model' },
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  const result = resolver.resolve('implementer', medCtx);
  assertEq(result.model, 'custom-impl-model', '1.1 override takes precedence over tier resolution');
}

{
  // Override for one role should not affect others
  const resolver = new CodingModelResolver({
    overrides: { 'implementer': 'custom-impl-model' },
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  const architect = resolver.resolve('architect', medCtx);
  assert(architect.model !== 'custom-impl-model', '1.2 override for implementer does not affect architect');
}

{
  // Override with all roles
  const allOverrides: Partial<Record<CodingRole, string>> = {
    'codebase-scanner': 'model-a',
    'architect': 'model-b',
    'implementer': 'model-c',
  };
  const resolver = new CodingModelResolver({
    overrides: allOverrides,
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  assertEq(resolver.resolve('codebase-scanner', medCtx).model, 'model-a', '1.3 scanner override');
  assertEq(resolver.resolve('architect', medCtx).model, 'model-b', '1.3 architect override');
  assertEq(resolver.resolve('implementer', medCtx).model, 'model-c', '1.3 implementer override');
}

// ── Section 2: Validator role ─────────────────────────────────────────────────

section('2. Validator role (TOOL node — no model)');

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  const result = resolver.resolve('validator', medCtx);
  assertEq(result.model, '', '2.1 validator resolves to empty model string');
  assertEq(result.thinking.type, 'disabled', '2.2 validator thinking mode is disabled');
}

// ── Section 3: Tier selection with mock discovered models ─────────────────────

section('3. Tier selection with mock models');

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // codebase-scanner prefers haiku tier
  const result = resolver.resolve('codebase-scanner', medCtx);
  assertEq(result.model, 'claude-haiku-4-5', '3.1 scanner uses haiku tier model');
  assertEq(result.thinking.type, 'disabled', '3.1 scanner thinking mode disabled (fast scan)');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // architect prefers sonnet tier (no upgrade with medium complexity, <100 files)
  const result = resolver.resolve('architect', medCtx);
  assertEq(result.model, 'claude-sonnet-4-6', '3.2 architect uses sonnet tier for medium profile');
  assertEq(result.thinking.type, 'adaptive', '3.2 architect thinking mode is adaptive');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // reporter prefers haiku tier
  const result = resolver.resolve('reporter', medCtx);
  assertEq(result.model, 'claude-haiku-4-5', '3.3 reporter uses haiku tier');
  assertEq(result.thinking.type, 'disabled', '3.3 reporter thinking mode disabled');
}

// ── Section 4: Upgrade conditions ────────────────────────────────────────────

section('4. Upgrade conditions');

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // architect upgrades when fileCount > 100 OR avgComplexity >= 2.5 (majority 'high')
  // highProfile has 120 files → upgrades
  const result = resolver.resolve('architect', highCtx);
  assertEq(result.model, 'claude-opus-4-6', '4.1 architect upgrades to opus with >100 files');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // implementer upgrades when high complexity AND some files > 500 LOC
  const result = resolver.resolve('implementer', highCtx);
  assertEq(result.model, 'claude-opus-4-6', '4.2 implementer upgrades to opus with high complexity + large files');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // stitcher upgrades when conflictCount > 3
  const conflictCtx = { profile: mediumProfile, conflictCount: 5 };
  const result = resolver.resolve('stitcher', conflictCtx);
  assertEq(result.model, 'claude-opus-4-6', '4.3 stitcher upgrades to opus with >3 conflicts');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // stitcher does NOT upgrade with conflictCount <= 3
  const noConflictCtx = { profile: mediumProfile, conflictCount: 2 };
  const result = resolver.resolve('stitcher', noConflictCtx);
  assertEq(result.model, 'claude-sonnet-4-6', '4.4 stitcher stays at sonnet with <=3 conflicts');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // reviewer upgrades when securityRelevant=true
  const securityCtx = { profile: mediumProfile, securityRelevant: true };
  const result = resolver.resolve('reviewer', securityCtx);
  assertEq(result.model, 'claude-opus-4-6', '4.5 reviewer upgrades to opus for security-relevant code');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // reporter upgrades when fileCount > 50
  const bigProfile = makeProfile('medium', 60);
  const result = resolver.resolve('reporter', { profile: bigProfile });
  assertEq(result.model, 'claude-sonnet-4-6', '4.6 reporter upgrades from haiku to sonnet with >50 files');
}

// ── Section 5: Downgrade conditions ──────────────────────────────────────────

section('5. Downgrade conditions');

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // test-writer downgrades to haiku when low complexity AND testFramework is set
  const lowWithFramework: CodebaseScanOutput = {
    ...lowProfile,
    testFramework: 'jest',
  };
  const result = resolver.resolve('test-writer', { profile: lowWithFramework });
  assertEq(result.model, 'claude-haiku-4-5', '5.1 test-writer downgrades to haiku for low-complexity + test framework');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // test-writer does NOT downgrade when testFramework is null (even if low complexity)
  const lowNoFramework: CodebaseScanOutput = {
    ...lowProfile,
    testFramework: null,
  };
  const result = resolver.resolve('test-writer', { profile: lowNoFramework });
  assertEq(result.model, 'claude-sonnet-4-6', '5.2 test-writer stays sonnet when no test framework');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // test-writer does NOT downgrade for medium complexity (even with test framework)
  const medWithFramework: CodebaseScanOutput = {
    ...mediumProfile,
    testFramework: 'vitest',
  };
  const result = resolver.resolve('test-writer', { profile: medWithFramework });
  assertEq(result.model, 'claude-sonnet-4-6', '5.3 test-writer stays sonnet for medium complexity');
}

// ── Section 6: Fallback when no discovered models ─────────────────────────────

section('6. Fallback with no discovered models');

{
  const resolver = new CodingModelResolver({
    discoveredModels: [],
    fallbackModel: 'my-fallback-model',
  });

  // All non-validator roles should fall back to the configured fallback
  for (const role of ['codebase-scanner', 'architect', 'implementer', 'reporter'] as CodingRole[]) {
    const result = resolver.resolve(role, medCtx);
    assertEq(result.model, 'my-fallback-model', `6.1 ${role} uses fallback when no models discovered`);
  }
}

// ── Section 7: resolveAll() ──────────────────────────────────────────────────

section('7. resolveAll()');

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  const nodes = [
    { id: 'scan', codingRole: 'codebase-scanner' as CodingRole },
    { id: 'arch', codingRole: 'architect' as CodingRole },
    { id: 'impl', codingRole: 'implementer' as CodingRole },
    { id: 'valid', codingRole: 'validator' as CodingRole },
  ];

  const assignments = resolver.resolveAll(nodes, medCtx);
  assertEq(assignments.size, 4, '7.1 resolveAll returns entry for each node');
  assert(assignments.has('scan'), '7.2 scan has assignment');
  assert(assignments.has('arch'), '7.2 arch has assignment');
  assert(assignments.has('impl'), '7.2 impl has assignment');
  assert(assignments.has('valid'), '7.2 valid has assignment');

  assertEq(assignments.get('valid')?.model, '', '7.3 validator node has empty model');
  assertEq(assignments.get('scan')?.model, 'claude-haiku-4-5', '7.3 scanner is haiku tier');
}

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  // Empty nodes
  const assignments = resolver.resolveAll([], medCtx);
  assertEq(assignments.size, 0, '7.4 resolveAll with no nodes returns empty map');
}

// ── Section 8: Thinking mode correctness ──────────────────────────────────────

section('8. Thinking mode per role');

{
  const resolver = new CodingModelResolver({
    discoveredModels: MOCK_MODELS,
    fallbackModel: FALLBACK,
  });

  const disabledRoles: CodingRole[] = ['codebase-scanner', 'validator', 'reporter'];
  const adaptiveRoles: CodingRole[] = ['architect', 'implementer', 'stitcher', 'test-writer', 'reviewer'];

  for (const role of disabledRoles) {
    const r = resolver.resolve(role, medCtx);
    assertEq(r.thinking.type, 'disabled', `8.1 ${role} thinking mode is disabled`);
  }

  for (const role of adaptiveRoles) {
    const r = resolver.resolve(role, medCtx);
    assertEq(r.thinking.type, 'adaptive', `8.2 ${role} thinking mode is adaptive`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const ok = printSummary('CodingModelResolver');
if (!ok) process.exit(1);
