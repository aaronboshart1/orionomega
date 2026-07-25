/**
 * @module __tests__/coding-planner
 * Integration tests for CodingPlanner, matchCodingIntent, and isCodingModeRequest —
 * intent classification, template selection, plan() output structure, disabled
 * template fallback, and refineBudget().
 */

import { describe, it, expect } from 'vitest';
import { CodingPlanner, matchCodingIntent, isCodingModeRequest } from '../coding-planner.js';
import type { CodingModeConfig, CodebaseScanOutput } from '../coding-types.js';

const FALLBACK = 'claude-sonnet-4-6';

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
    validation: { autoRun: true, commands: [] },
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

function makePlanner(config: CodingModeConfig = makeDefaultConfig()) {
  return new CodingPlanner({ codingModeConfig: config, fallbackModel: FALLBACK, cwd: '/tmp/test' });
}

const defaultProfile = makeProfile();

describe('matchCodingIntent', () => {
  it.each([
    'Fix the null pointer exception in auth',
    'There is a bug in the login handler',
    'The app crash on startup',
    'The API is broken, please repair it',
    'Something is failing in production',
    "This code doesn't work anymore",
    'Authentication is not working',
  ])('matches "%s" to bug-fix', (task) => {
    expect(matchCodingIntent(task)).toBe('bug-fix');
  });

  it.each([
    'Refactor the authentication module',
    'Restructure the folder layout',
    'Rename UserService to AccountService',
    'Extract the database logic into a separate module',
    'Clean up the legacy payment code',
    'Split the monolithic file into smaller modules',
  ])('matches "%s" to refactor', (task) => {
    expect(matchCodingIntent(task)).toBe('refactor');
  });

  it.each([
    'Write tests for the payment module',
    'Add unit tests to the auth service',
    'Improve code coverage for the API',
    'Generate specs for the user controller',
    'Write integration tests for the database layer',
  ])('matches "%s" to test-suite', (task) => {
    expect(matchCodingIntent(task)).toBe('test-suite');
  });

  it.each([
    'Review the pull request changes',
    'Give feedback on my PR',
    'Check code quality and lint issues',
    'Review the implementation for best practices',
  ])('matches "%s" to review-iterate', (task) => {
    expect(matchCodingIntent(task)).toBe('review-iterate');
  });

  it.each([
    'Add a /health endpoint to the API',
    'Implement user authentication with JWT',
    'Create a new payment processing module',
    'Build a rate limiter middleware',
    'Develop the search feature',
  ])('matches "%s" to feature-implementation', (task) => {
    expect(matchCodingIntent(task)).toBe('feature-implementation');
  });

  it.each([
    'What is 2 + 2?',
    'Tell me about TypeScript',
    'Show me the project structure',
  ])('returns null for the non-coding prompt "%s"', (task) => {
    expect(matchCodingIntent(task)).toBeNull();
  });
});

describe('isCodingModeRequest', () => {
  it('accepts bug, feature, and refactor descriptions', () => {
    expect(isCodingModeRequest('Fix the login bug')).toBe(true);
    expect(isCodingModeRequest('Add a new feature')).toBe(true);
    expect(isCodingModeRequest('Refactor the database layer')).toBe(true);
  });

  it('rejects off-topic and empty prompts', () => {
    expect(isCodingModeRequest('What is the capital of France?')).toBe(false);
    expect(isCodingModeRequest('')).toBe(false);
  });
});

describe('CodingPlanner.selectTemplate', () => {
  it.each([
    ['Fix the memory leak', 'bug-fix'],
    ['Refactor the auth module', 'refactor'],
    ['Write tests for the API', 'test-suite'],
    ['Review this PR', 'review-iterate'],
    ['Add a new endpoint', 'feature-implementation'],
  ])('selects %s → %s', (task, expected) => {
    expect(makePlanner().selectTemplate(task)).toBe(expected);
  });

  it('falls back to feature-implementation when nothing matches', () => {
    expect(makePlanner().selectTemplate('random gibberish with no coding keywords'))
      .toBe('feature-implementation');
  });
});

describe('CodingPlanner.plan — output structure', () => {
  it('returns nodes, a budget allocation with a reserve, and model assignments', () => {
    const output = makePlanner().plan('Add a new /status endpoint', 'feature-implementation', defaultProfile);

    expect(output.template).toBe('feature-implementation');
    expect(Array.isArray(output.nodes)).toBe(true);
    expect(output.nodes.length).toBeGreaterThan(0);
    expect(output.budgetAllocation).toBeDefined();
    expect(output.budgetAllocation.perNode.size).toBeGreaterThan(0);
    expect(output.budgetAllocation.reserve).toBeGreaterThan(0);
    expect(output.modelAssignments).toBeInstanceOf(Map);
    expect(output.modelAssignments.size).toBeGreaterThan(0);
  });

  it('marks feature-implementation as pending fan-out (it has an impl placeholder)', () => {
    const output = makePlanner().plan('Add authentication', 'feature-implementation', defaultProfile);

    expect(output.fanOutPending).toBe(true);
  });

  it('plans the bug-fix template', () => {
    const output = makePlanner().plan('Fix the login bug', 'bug-fix', defaultProfile);

    expect(output.template).toBe('bug-fix');
    expect(output.nodes.length).toBeGreaterThan(0);
  });

  it('carries the codebase profile through to the plan', () => {
    const output = makePlanner().plan('Add feature', 'feature-implementation', defaultProfile);

    expect(output.codebaseProfile).toBeDefined();
    expect(output.codebaseProfile?.language).toBe('typescript');
  });
});

describe('CodingPlanner.plan — disabled template fallback', () => {
  it('falls back to feature-implementation when the requested template is disabled', () => {
    const planner = makePlanner(makeDefaultConfig({
      templates: {
        'feature-implementation': true,
        'bug-fix': false,
        'refactor': true,
        'test-suite': true,
        'review-iterate': true,
      },
    }));

    expect(planner.plan('Fix the crash', 'bug-fix', defaultProfile).template)
      .toBe('feature-implementation');
  });
});

describe('CodingPlanner.plan — budget allocation', () => {
  it('estimates a positive spend under the workflow cap', () => {
    const est = makePlanner().plan('Add feature', 'feature-implementation', defaultProfile)
      .budgetAllocation.estimated;

    expect(est).toBeGreaterThan(0);
    expect(est).toBeLessThan(30.0);
  });

  it('scales the estimate with budgetMultiplier', () => {
    const out1x = makePlanner(makeDefaultConfig({ budgetMultiplier: 1.0 }))
      .plan('Add feature', 'feature-implementation', defaultProfile);
    const out2x = makePlanner(makeDefaultConfig({ budgetMultiplier: 2.0 }))
      .plan('Add feature', 'feature-implementation', defaultProfile);

    expect(out2x.budgetAllocation.estimated).toBeGreaterThan(out1x.budgetAllocation.estimated);
  });
});

describe('CodingPlanner.refineBudget', () => {
  it('re-costs against the real profile while preserving the template and nodes', () => {
    const planner = makePlanner();
    const initial = planner.plan('Add feature', 'feature-implementation', defaultProfile);

    const refined = planner.refineBudget(initial, makeProfile(50, 'high'));

    expect(refined.budgetAllocation.estimated).toBeGreaterThan(0);
    expect(refined.template).toBe(initial.template);
    expect(refined.nodes).toHaveLength(initial.nodes.length);
    expect(refined.codebaseProfile).toBeDefined();
    expect(refined.codebaseProfile?.relevantFiles).toHaveLength(50);
  });
});

describe('CodingPlanner — model assignments', () => {
  it('gives every assignment a model string and a valid thinking type', () => {
    const output = makePlanner().plan('Add feature', 'feature-implementation', defaultProfile);

    for (const [nodeId, assignment] of output.modelAssignments) {
      expect(typeof assignment.model, `assignment for "${nodeId}"`).toBe('string');
      expect(['adaptive', 'disabled'], `assignment for "${nodeId}"`).toContain(assignment.thinking.type);
    }
  });

  it('applies a per-role model override from config to the implementer node', () => {
    const planner = makePlanner(makeDefaultConfig({ models: { implementer: 'my-custom-model' } }));

    const output = planner.plan('Add feature', 'feature-implementation', defaultProfile);

    const implAssign = output.modelAssignments.get('impl-placeholder');
    expect(implAssign).toBeDefined();
    expect(implAssign!.model).toBe('my-custom-model');
  });
});
