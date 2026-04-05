/**
 * Tests for Coding Mode DAG template builders and the loadCodingTemplate registry.
 *
 * Validates: node IDs, dependency chains, node types, role assignments,
 * template registry exhaustiveness, and validation loop structure.
 */

import {
  suite, section, assert, assertEq, assertThrows, printSummary,
} from './test-harness.js';
import {
  buildFeatureImplementationTemplate,
  buildBugFixTemplate,
  loadCodingTemplate,
  CODING_TEMPLATE_NAMES,
} from '../packages/core/src/orchestration/coding/templates/index.js';
import type { WorkflowNode } from '../packages/core/src/orchestration/types.js';

suite('Coding Mode Template Tests');

// ── Helpers ───────────────────────────────────────────────────────────────────

const FALLBACK_MODEL = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5';

const DEFAULT_MODELS = {
  scanner: HAIKU,
  architect: FALLBACK_MODEL,
  implementer: FALLBACK_MODEL,
  stitcher: FALLBACK_MODEL,
  testWriter: FALLBACK_MODEL,
  reporter: HAIKU,
};

const DEFAULT_BUDGETS = {
  scanner: 0.10,
  architect: 0.30,
  implementer: 0.60,
  stitcher: 0.40,
  testWriter: 0.50,
  reporter: 0.05,
};

const DEFAULT_MAX_TURNS = {
  scanner: 10,
  architect: 15,
  implementer: 30,
  stitcher: 20,
  testWriter: 25,
  reporter: 5,
};

const COMMON_PARAMS = {
  task: 'Add a new /health endpoint to the Express API',
  cwd: '/tmp/test-repo',
  models: {
    ...DEFAULT_MODELS,
    default: FALLBACK_MODEL,
    rootCause: FALLBACK_MODEL,
    fixer: FALLBACK_MODEL,
    analyst: FALLBACK_MODEL,
    refactorer: FALLBACK_MODEL,
    testUpdater: FALLBACK_MODEL,
    reviewer: FALLBACK_MODEL,
    coverageAnalyst: FALLBACK_MODEL,
    testGen: FALLBACK_MODEL,
    integrator: FALLBACK_MODEL,
    testWriter: FALLBACK_MODEL,
  },
  budgets: {
    ...DEFAULT_BUDGETS,
    default: 0.30,
    rootCause: 0.20,
    fixer: 0.50,
    analyst: 0.20,
    refactorer: 0.50,
    testUpdater: 0.30,
    reviewer: 0.30,
    coverageAnalyst: 0.15,
    testGen: 0.50,
    integrator: 0.20,
  },
  maxTurns: {
    ...DEFAULT_MAX_TURNS,
    default: 20,
    rootCause: 15,
    fixer: 25,
    analyst: 15,
    refactorer: 30,
    testUpdater: 20,
    reviewer: 20,
    coverageAnalyst: 12,
    testGen: 25,
    integrator: 15,
  },
};

function nodeById(nodes: WorkflowNode[], id: string): WorkflowNode | undefined {
  return nodes.find((n) => n.id === id);
}

// ── Section 1: feature-implementation template structure ──────────────────────

section('1. feature-implementation template structure');

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  assertEq(nodes.length, 7, '1.1 feature-implementation produces exactly 7 nodes');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  const expectedIds = [
    'codebase-scan',
    'architecture-design',
    'impl-placeholder',
    'integration-stitch',
    'test-generation',
    'validation-loop',
    'summary-report',
  ];

  for (const id of expectedIds) {
    assert(nodeById(nodes, id) !== undefined, `1.2 node "${id}" exists`);
  }
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  const scan = nodeById(nodes, 'codebase-scan')!;
  assertEq(scan.type, 'CODING_AGENT', '1.3 scanner is CODING_AGENT type');
  assertEq(scan.dependsOn.length, 0, '1.3 scanner has no dependencies (layer 0)');
  assertEq(scan.status, 'pending', '1.3 scanner starts as pending');
  assertEq(scan.codingConfig?.codingRole, 'codebase-scanner', '1.3 scanner role is codebase-scanner');
  assert(scan.codingConfig?.fileScope.lockRequired === false, '1.3 scanner does not require file locks');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  const arch = nodeById(nodes, 'architecture-design')!;
  assertEq(arch.type, 'AGENT', '1.4 architect is AGENT type');
  assert(arch.dependsOn.includes('codebase-scan'), '1.4 architect depends on codebase-scan');
  assertEq(arch.codingConfig?.codingRole, 'architect', '1.4 architect role correct');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  const impl = nodeById(nodes, 'impl-placeholder')!;
  assertEq(impl.type, 'CODING_AGENT', '1.5 impl-placeholder is CODING_AGENT type');
  assert(impl.dependsOn.includes('architecture-design'), '1.5 impl depends on architect');
  assert(impl.codingConfig?.fileScope.lockRequired === true, '1.5 impl requires file locks');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  const stitch = nodeById(nodes, 'integration-stitch')!;
  assert(stitch.dependsOn.includes('impl-placeholder'), '1.6 stitcher depends on impl-placeholder');
  assertEq(stitch.codingConfig?.codingRole, 'stitcher', '1.6 stitcher role correct');

  const testGen = nodeById(nodes, 'test-generation')!;
  assert(testGen.dependsOn.includes('integration-stitch'), '1.6 test-generation depends on stitcher');
  assertEq(testGen.codingConfig?.codingRole, 'test-writer', '1.6 test-writer role correct');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  const loop = nodeById(nodes, 'validation-loop')!;
  assertEq(loop.type, 'LOOP', '1.7 validation-loop is LOOP type');
  assert(loop.dependsOn.includes('test-generation'), '1.7 validation-loop depends on test-generation');
  assert(loop.loop !== undefined, '1.7 validation-loop has loop config');
  assert(loop.loop!.body.length > 0, '1.7 loop body is non-empty');
  assertEq(loop.codingConfig?.codingRole, 'validator', '1.7 validation loop role is validator');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
    validationCommands: ['npm test', 'npm run lint'],
    validationMaxRetries: 3,
  });

  const loop = nodeById(nodes, 'validation-loop')!;
  // maxIterations = validationMaxRetries + 1 = 4
  assertEq(loop.loop!.maxIterations, 4, '1.8 maxIterations = validationMaxRetries + 1');
  assertEq(loop.codingConfig?.validationConfig?.maxRetries, 3, '1.8 validationConfig.maxRetries set');

  const reporter = nodeById(nodes, 'summary-report')!;
  assert(reporter.dependsOn.includes('validation-loop'), '1.8 summary-report depends on validation-loop');
  assertEq(reporter.codingConfig?.codingRole, 'reporter', '1.8 reporter role correct');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add /health endpoint',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  const scan = nodeById(nodes, 'codebase-scan')!;
  assert(
    scan.codingAgent?.task.includes('Add /health endpoint') ||
    scan.codingConfig?.task.includes('Add /health endpoint'),
    '1.9 task string embedded in scanner node task',
  );
}

// ── Section 2: bug-fix template structure ─────────────────────────────────────

section('2. bug-fix template structure');

{
  const nodes = buildBugFixTemplate({
    task: 'Fix null pointer exception in auth middleware',
    cwd: '/tmp/repo',
    models: { scanner: HAIKU, rootCause: FALLBACK_MODEL, fixer: FALLBACK_MODEL, testWriter: FALLBACK_MODEL, reporter: HAIKU },
    budgets: { scanner: 0.10, rootCause: 0.20, fixer: 0.50, testWriter: 0.30, reporter: 0.05 },
    maxTurns: { scanner: 10, rootCause: 15, fixer: 25, testWriter: 15, reporter: 5 },
  });

  assert(nodes.length >= 5, '2.1 bug-fix has at least 5 nodes (scan→root-cause→fix→test→report)');
}

{
  const nodes = buildBugFixTemplate({
    task: 'Fix the crash',
    cwd: '/tmp/repo',
    models: { scanner: HAIKU, rootCause: FALLBACK_MODEL, fixer: FALLBACK_MODEL, testWriter: FALLBACK_MODEL, reporter: HAIKU },
    budgets: { scanner: 0.10, rootCause: 0.20, fixer: 0.50, testWriter: 0.30, reporter: 0.05 },
    maxTurns: { scanner: 10, rootCause: 15, fixer: 25, testWriter: 15, reporter: 5 },
  });

  // All nodes must have unique IDs
  const ids = nodes.map((n) => n.id);
  const uniqueIds = new Set(ids);
  assertEq(uniqueIds.size, ids.length, '2.2 all bug-fix node IDs are unique');
}

{
  const nodes = buildBugFixTemplate({
    task: 'Fix the crash',
    cwd: '/tmp/repo',
    models: { scanner: HAIKU, rootCause: FALLBACK_MODEL, fixer: FALLBACK_MODEL, testWriter: FALLBACK_MODEL, reporter: HAIKU },
    budgets: { scanner: 0.10, rootCause: 0.20, fixer: 0.50, testWriter: 0.30, reporter: 0.05 },
    maxTurns: { scanner: 10, rootCause: 15, fixer: 25, testWriter: 15, reporter: 5 },
  });

  // Bug-fix is sequential: scan → root-cause → fix → test → validate → report
  // Each node (except the first) should depend on the previous
  const firstNode = nodes.find((n) => n.dependsOn.length === 0);
  assert(firstNode !== undefined, '2.3 bug-fix has a root node with no dependencies');
}

// ── Section 3: loadCodingTemplate — all templates ─────────────────────────────

section('3. loadCodingTemplate() — all 5 templates');

{
  for (const templateName of CODING_TEMPLATE_NAMES) {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);
    assert(
      Array.isArray(nodes) && nodes.length > 0,
      `3.1 loadCodingTemplate("${templateName}") returns non-empty node array`,
    );
  }
}

{
  for (const templateName of CODING_TEMPLATE_NAMES) {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);
    // All nodes have required fields
    for (const node of nodes) {
      assert(typeof node.id === 'string' && node.id.length > 0, `3.2 [${templateName}] node.id is non-empty string`);
      assert(typeof node.type === 'string', `3.2 [${templateName}] node.type is string`);
      assert(Array.isArray(node.dependsOn), `3.2 [${templateName}] node.dependsOn is array`);
      assert(node.status === 'pending', `3.2 [${templateName}] node.status starts as 'pending'`);
    }
  }
}

{
  for (const templateName of CODING_TEMPLATE_NAMES) {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);
    const ids = nodes.map((n) => n.id);
    const uniqueIds = new Set(ids);
    assertEq(uniqueIds.size, ids.length, `3.3 [${templateName}] all node IDs are unique`);
  }
}

{
  // Each template should have exactly one root node (no dependencies)
  for (const templateName of CODING_TEMPLATE_NAMES) {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);
    const rootNodes = nodes.filter((n) => n.dependsOn.length === 0);
    assertEq(rootNodes.length, 1, `3.4 [${templateName}] has exactly 1 root node`);
  }
}

{
  // Dependency references must resolve to existing node IDs
  for (const templateName of CODING_TEMPLATE_NAMES) {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);
    const allIds = new Set(nodes.map((n) => n.id));

    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        assert(
          allIds.has(dep),
          `3.5 [${templateName}] node "${node.id}" dependency "${dep}" resolves to a real node`,
        );
      }
    }
  }
}

{
  // loadCodingTemplate should throw on unknown template
  assertThrows(
    () => loadCodingTemplate('nonexistent-template' as never, COMMON_PARAMS),
    '3.6 loadCodingTemplate throws on unknown template name',
  );
}

// ── Section 4: CODING_TEMPLATE_NAMES registry ────────────────────────────────

section('4. CODING_TEMPLATE_NAMES registry');

{
  const expected = [
    'feature-implementation',
    'bug-fix',
    'refactor',
    'test-suite',
    'review-iterate',
  ];

  assertEq(CODING_TEMPLATE_NAMES.length, 5, '4.1 registry contains exactly 5 templates');
  for (const name of expected) {
    assert(
      CODING_TEMPLATE_NAMES.includes(name as never),
      `4.2 registry includes "${name}"`,
    );
  }
}

// ── Section 5: CodingNodeConfig presence ─────────────────────────────────────

section('5. CodingNodeConfig presence and correctness');

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add feature',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  // All nodes should have codingConfig (it's always attached)
  for (const node of nodes) {
    assert(
      node.codingConfig !== undefined,
      `5.1 node "${node.id}" has codingConfig`,
    );
  }
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add feature',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  // Budget and maxTurns should be passed through to node configs
  const scan = nodeById(nodes, 'codebase-scan')!;
  assertEq(scan.codingAgent?.maxBudgetUsd, DEFAULT_BUDGETS.scanner, '5.2 scanner budget passed through');
  assertEq(scan.codingAgent?.maxTurns, DEFAULT_MAX_TURNS.scanner, '5.2 scanner maxTurns passed through');
  assertEq(scan.codingAgent?.model, DEFAULT_MODELS.scanner, '5.2 scanner model passed through');
}

{
  const nodes = buildFeatureImplementationTemplate({
    task: 'Add feature',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    maxTurns: DEFAULT_MAX_TURNS,
  });

  // Verify allowed tools per role
  const scan = nodeById(nodes, 'codebase-scan')!;
  const scanTools = scan.codingAgent?.allowedTools ?? scan.codingConfig?.allowedTools ?? [];
  assert(scanTools.includes('Read'), '5.3 scanner has Read tool');
  assert(scanTools.includes('Glob'), '5.3 scanner has Glob tool');
  assert(!scanTools.includes('Write'), '5.3 scanner does NOT have Write tool (read-only role)');

  const impl = nodeById(nodes, 'impl-placeholder')!;
  const implTools = impl.codingAgent?.allowedTools ?? impl.codingConfig?.allowedTools ?? [];
  assert(implTools.includes('Write'), '5.4 implementer has Write tool');
  assert(implTools.includes('Edit'), '5.4 implementer has Edit tool');
}

// ── Summary ───────────────────────────────────────────────────────────────────

const ok = printSummary('Coding Mode Templates');
if (!ok) process.exit(1);
