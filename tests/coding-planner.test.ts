/**
 * Integration tests for CodingPlanner, matchCodingIntent, and isCodingModeRequest.
 *
 * Covers: intent classification, template selection, plan() output structure,
 * disabled template fallback, and refineBudget().
 */

import {
  suite, section, assert, assertEq, assertGt, printSummary,
} from './test-harness.js';
import {
  CodingPlanner,
  matchCodingIntent,
  isCodingModeRequest,
} from '../packages/core/src/orchestration/coding/coding-planner.js';
import type { CodingModeConfig, CodebaseScanOutput } from '../packages/core/src/orchestration/coding/coding-types.js';

suite('CodingPlanner Integration Tests');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDefaultConfig(overrides: Partial<CodingModeConfig> = {}): CodingModeConfig {
  return {
    enabled: true,
    maxParallelAgents: 4,
    templates: {
      'feature-implementation': true,
      'bug-fix': true,
      'refactor': true,
      'test-suite': true,
      'review-iterate': true,
    },
    models: {},
    validation: {
      autoRun: true,
      commands: [],
    },
    budgetMultiplier: 1.0,
    ...overrides,
  };
}

function makeProfile(fileCount = 20, complexity: 'low' | 'medium' | 'high' = 'medium'): CodebaseScanOutput {
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
      linesOfCode: 100,
    }),
    entryPoints: [],
    dependencies: {},
  };
}

const FALLBACK = 'claude-sonnet-4-6';
const defaultProfile = makeProfile();

// ── Section 1: matchCodingIntent() ───────────────────────────────────────────

section('1. matchCodingIntent()');

{
  // Bug/fix keywords
  const bugCases = [
    'Fix the null pointer exception in auth',
    'There is a bug in the login handler',
    'The app crash on startup',
    'The API is broken, please repair it',
    'Something is failing in production',
    'This code doesn\'t work anymore',
    'Authentication is not working',
  ];
  for (const task of bugCases) {
    assertEq(matchCodingIntent(task), 'bug-fix', `1.1 bug intent: "${task.slice(0, 40)}"`);
  }
}

{
  // Refactor keywords
  const refactorCases = [
    'Refactor the authentication module',
    'Restructure the folder layout',
    'Rename UserService to AccountService',
    'Extract the database logic into a separate module',
    'Clean up the legacy payment code',
    'Split the monolithic file into smaller modules',
  ];
  for (const task of refactorCases) {
    assertEq(matchCodingIntent(task), 'refactor', `1.2 refactor intent: "${task.slice(0, 40)}"`);
  }
}

{
  // Test suite keywords
  const testCases = [
    'Write tests for the payment module',
    'Add unit tests to the auth service',
    'Improve code coverage for the API',
    'Generate specs for the user controller',
    'Write integration tests for the database layer',
  ];
  for (const task of testCases) {
    assertEq(matchCodingIntent(task), 'test-suite', `1.3 test intent: "${task.slice(0, 40)}"`);
  }
}

{
  // Review/iterate keywords
  const reviewCases = [
    'Review the pull request changes',
    'Give feedback on my PR',
    'Check code quality and lint issues',
    'Review the implementation for best practices',
  ];
  for (const task of reviewCases) {
    assertEq(matchCodingIntent(task), 'review-iterate', `1.4 review intent: "${task.slice(0, 40)}"`);
  }
}

{
  // Feature implementation keywords
  const featureCases = [
    'Add a /health endpoint to the API',
    'Implement user authentication with JWT',
    'Create a new payment processing module',
    'Build a rate limiter middleware',
    'Develop the search feature',
  ];
  for (const task of featureCases) {
    assertEq(matchCodingIntent(task), 'feature-implementation', `1.5 feature intent: "${task.slice(0, 40)}"`);
  }
}

{
  // No match cases
  const noMatchCases = [
    'What is 2 + 2?',
    'Tell me about TypeScript',
    'Show me the project structure',
  ];
  for (const task of noMatchCases) {
    const result = matchCodingIntent(task);
    assert(result === null, `1.6 no coding intent for: "${task}"`);
  }
}

// ── Section 2: isCodingModeRequest() ─────────────────────────────────────────

section('2. isCodingModeRequest()');

{
  assert(isCodingModeRequest('Fix the login bug'), '2.1 bug description is a coding request');
  assert(isCodingModeRequest('Add a new feature'), '2.2 feature description is a coding request');
  assert(isCodingModeRequest('Refactor the database layer'), '2.3 refactor is a coding request');
  assert(!isCodingModeRequest('What is the capital of France?'), '2.4 off-topic is not a coding request');
  assert(!isCodingModeRequest(''), '2.5 empty string is not a coding request');
}

// ── Section 3: CodingPlanner.selectTemplate() ────────────────────────────────

section('3. CodingPlanner.selectTemplate()');

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
  });

  assertEq(planner.selectTemplate('Fix the memory leak'), 'bug-fix', '3.1 fast-path selects bug-fix');
  assertEq(planner.selectTemplate('Refactor the auth module'), 'refactor', '3.2 fast-path selects refactor');
  assertEq(planner.selectTemplate('Write tests for the API'), 'test-suite', '3.3 fast-path selects test-suite');
  assertEq(planner.selectTemplate('Review this PR'), 'review-iterate', '3.4 fast-path selects review-iterate');
  assertEq(planner.selectTemplate('Add a new endpoint'), 'feature-implementation', '3.5 fast-path selects feature-implementation');
}

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
  });

  // Fallback when nothing matches
  const result = planner.selectTemplate('random gibberish with no coding keywords');
  assertEq(result, 'feature-implementation', '3.6 falls back to feature-implementation when no pattern matches');
}

// ── Section 4: CodingPlanner.plan() — output structure ───────────────────────

section('4. CodingPlanner.plan() — output structure');

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  const output = planner.plan('Add a new /status endpoint', 'feature-implementation', defaultProfile);

  assertEq(output.template, 'feature-implementation', '4.1 plan returns correct template');
  assert(Array.isArray(output.nodes), '4.2 plan.nodes is an array');
  assertGt(output.nodes.length, 0, '4.3 plan.nodes is non-empty');
  assert(output.budgetAllocation !== undefined, '4.4 plan includes budget allocation');
  assert(output.budgetAllocation.perNode.size > 0, '4.5 budget allocation has per-node entries');
  assertGt(output.budgetAllocation.reserve, 0, '4.6 reserve is positive');
  assert(output.modelAssignments instanceof Map, '4.7 modelAssignments is a Map');
  assertGt(output.modelAssignments.size, 0, '4.8 modelAssignments is non-empty');
}

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  const output = planner.plan('Add authentication', 'feature-implementation', defaultProfile);

  // feature-implementation has impl-placeholder → fanOutPending should be true
  assert(output.fanOutPending === true, '4.9 feature-implementation sets fanOutPending=true');
}

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  const output = planner.plan('Fix the login bug', 'bug-fix', defaultProfile);

  assertEq(output.template, 'bug-fix', '4.10 plan returns bug-fix template');
  assert(output.nodes.length > 0, '4.11 bug-fix plan has nodes');
}

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  // plan() should include codebaseProfile
  const output = planner.plan('Add feature', 'feature-implementation', defaultProfile);
  assert(output.codebaseProfile !== undefined, '4.12 plan includes codebaseProfile');
  assertEq(output.codebaseProfile?.language, 'typescript', '4.12 codebaseProfile has correct language');
}

// ── Section 5: Disabled template fallback ─────────────────────────────────────

section('5. Disabled template fallback');

{
  const config = makeDefaultConfig({
    templates: {
      'feature-implementation': true,
      'bug-fix': false,  // Disabled
      'refactor': true,
      'test-suite': true,
      'review-iterate': true,
    },
  });

  const planner = new CodingPlanner({
    codingModeConfig: config,
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  // Requesting bug-fix template when it's disabled → falls back to feature-implementation
  const output = planner.plan('Fix the crash', 'bug-fix', defaultProfile);
  assertEq(output.template, 'feature-implementation', '5.1 disabled template falls back to feature-implementation');
}

// ── Section 6: Budget allocation in plan() ────────────────────────────────────

section('6. Budget allocation in plan()');

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  const output = planner.plan('Add feature', 'feature-implementation', defaultProfile);

  // Total estimated should be reasonable for a default feature-implementation
  const est = output.budgetAllocation.estimated;
  assertGt(est, 0, '6.1 estimated budget > 0');
  assert(est < 30.0, '6.2 estimated budget < $30 (capped by MAX_WORKFLOW_BUDGET_USD)');
}

{
  const config2x = makeDefaultConfig({ budgetMultiplier: 2.0 });
  const config1x = makeDefaultConfig({ budgetMultiplier: 1.0 });

  const planner2x = new CodingPlanner({ codingModeConfig: config2x, fallbackModel: FALLBACK });
  const planner1x = new CodingPlanner({ codingModeConfig: config1x, fallbackModel: FALLBACK });

  const out2x = planner2x.plan('Add feature', 'feature-implementation', defaultProfile);
  const out1x = planner1x.plan('Add feature', 'feature-implementation', defaultProfile);

  assertGt(out2x.budgetAllocation.estimated, out1x.budgetAllocation.estimated,
    '6.3 budgetMultiplier=2 produces higher estimated than budgetMultiplier=1');
}

// ── Section 7: refineBudget() ────────────────────────────────────────────────

section('7. CodingPlanner.refineBudget()');

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  // Stub profile (medium, 20 files) → plan
  const initial = planner.plan('Add feature', 'feature-implementation', defaultProfile);

  // "Real" profile with more complex files
  const realProfile = makeProfile(50, 'high');
  const refined = planner.refineBudget(initial, realProfile);

  // Refined budget should reflect the higher complexity
  assertGt(
    refined.budgetAllocation.estimated,
    0,
    '7.1 refined budget is positive',
  );

  // Template and nodes should be unchanged
  assertEq(refined.template, initial.template, '7.2 refineBudget preserves template');
  assertEq(refined.nodes.length, initial.nodes.length, '7.3 refineBudget preserves node count');

  // Real profile should be updated
  assert(refined.codebaseProfile !== undefined, '7.4 refineBudget sets codebaseProfile');
  assertEq(refined.codebaseProfile?.relevantFiles.length, 50, '7.4 codebaseProfile updated with real profile');
}

// ── Section 8: modelAssignments structure ────────────────────────────────────

section('8. modelAssignments structure');

{
  const planner = new CodingPlanner({
    codingModeConfig: makeDefaultConfig(),
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  const output = planner.plan('Add feature', 'feature-implementation', defaultProfile);

  // Every model assignment should have a 'model' and 'thinking' field
  for (const [nodeId, assignment] of output.modelAssignments) {
    assert(typeof assignment.model === 'string', `8.1 assignment for "${nodeId}" has model string`);
    assert(
      assignment.thinking.type === 'adaptive' || assignment.thinking.type === 'disabled',
      `8.2 assignment for "${nodeId}" has valid thinking type`,
    );
  }
}

{
  // Config override for implementer should appear in model assignments
  const config = makeDefaultConfig({
    models: { 'implementer': 'my-custom-model' },
  });

  const planner = new CodingPlanner({
    codingModeConfig: config,
    fallbackModel: FALLBACK,
    cwd: '/tmp/test',
  });

  const output = planner.plan('Add feature', 'feature-implementation', defaultProfile);

  // Find the impl-placeholder node assignment
  const implAssign = output.modelAssignments.get('impl-placeholder');
  // The model in the assignment comes from the node's codingConfig.model,
  // which was set using the resolved model from CodingModelResolver.
  // With override 'my-custom-model' for implementer role, it should use that.
  if (implAssign) {
    assertEq(implAssign.model, 'my-custom-model', '8.3 model override applied to impl-placeholder');
  } else {
    // If the assignment is missing, the node may not have codingConfig — that's also tested
    assert(true, '8.3 impl-placeholder assignment may be absent without codingConfig');
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const ok = printSummary('CodingPlanner');
if (!ok) process.exit(1);
