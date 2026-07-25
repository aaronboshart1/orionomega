/**
 * @module __tests__/coding-templates
 * Tests for the Coding Mode DAG template builders and the loadCodingTemplate
 * registry — node IDs, dependency chains, node types, role assignments,
 * registry exhaustiveness, and validation-loop structure.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFeatureImplementationTemplate,
  buildBugFixTemplate,
  loadCodingTemplate,
  CODING_TEMPLATE_NAMES,
} from '../templates/index.js';
import type { WorkflowNode } from '../../types.js';

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
};

const BUGFIX_PARAMS = {
  cwd: '/tmp/repo',
  models: { scanner: HAIKU, rootCause: FALLBACK_MODEL, fixer: FALLBACK_MODEL, testWriter: FALLBACK_MODEL, reporter: HAIKU },
  budgets: { scanner: 0.10, rootCause: 0.20, fixer: 0.50, testWriter: 0.30, reporter: 0.05 },
};

function featureNodes(overrides: Record<string, unknown> = {}): WorkflowNode[] {
  return buildFeatureImplementationTemplate({
    task: 'Add user authentication',
    cwd: '/tmp/repo',
    models: DEFAULT_MODELS,
    budgets: DEFAULT_BUDGETS,
    ...overrides,
  });
}

function nodeById(nodes: WorkflowNode[], id: string): WorkflowNode | undefined {
  return nodes.find((n) => n.id === id);
}

describe('feature-implementation template', () => {
  it('produces exactly 8 nodes with the expected IDs', () => {
    const nodes = featureNodes();

    expect(nodes).toHaveLength(8);
    for (const id of [
      'codebase-scan', 'architecture-design', 'impl-placeholder', 'integration-stitch',
      'test-generation', 'validation-loop', 'review-gate', 'summary-report',
    ]) {
      expect(nodeById(nodes, id), `node "${id}" should exist`).toBeDefined();
    }
  });

  it('starts with a lock-free read-only scanner at layer 0', () => {
    const scan = nodeById(featureNodes(), 'codebase-scan')!;

    expect(scan.type).toBe('CODING_AGENT');
    expect(scan.dependsOn).toHaveLength(0);
    expect(scan.status).toBe('pending');
    expect(scan.codingConfig?.codingRole).toBe('codebase-scanner');
    expect(scan.codingConfig?.fileScope.lockRequired).toBe(false);
  });

  it('chains the architect behind the scan', () => {
    const arch = nodeById(featureNodes(), 'architecture-design')!;

    expect(arch.type).toBe('AGENT');
    expect(arch.dependsOn).toContain('codebase-scan');
    expect(arch.codingConfig?.codingRole).toBe('architect');
  });

  it('requires file locks for the implementer, which follows the architect', () => {
    const impl = nodeById(featureNodes(), 'impl-placeholder')!;

    expect(impl.type).toBe('CODING_AGENT');
    expect(impl.dependsOn).toContain('architecture-design');
    expect(impl.codingConfig?.fileScope.lockRequired).toBe(true);
  });

  it('orders stitcher → test-generation after implementation', () => {
    const nodes = featureNodes();

    const stitch = nodeById(nodes, 'integration-stitch')!;
    expect(stitch.dependsOn).toContain('impl-placeholder');
    expect(stitch.codingConfig?.codingRole).toBe('stitcher');

    const testGen = nodeById(nodes, 'test-generation')!;
    expect(testGen.dependsOn).toContain('integration-stitch');
    expect(testGen.codingConfig?.codingRole).toBe('test-writer');
  });

  it('models validation as a non-empty LOOP node owned by the validator', () => {
    const loop = nodeById(featureNodes(), 'validation-loop')!;

    expect(loop.type).toBe('LOOP');
    expect(loop.dependsOn).toContain('test-generation');
    expect(loop.loop).toBeDefined();
    expect(loop.loop!.body.length).toBeGreaterThan(0);
    expect(loop.codingConfig?.codingRole).toBe('validator');
  });

  it('derives loop maxIterations from validationMaxRetries + 1 and reports after the review gate', () => {
    const nodes = featureNodes({ validationCommands: ['npm test', 'npm run lint'], validationMaxRetries: 3 });

    const loop = nodeById(nodes, 'validation-loop')!;
    expect(loop.loop!.maxIterations).toBe(4);
    expect(loop.codingConfig?.validationConfig?.maxRetries).toBe(3);

    const reporter = nodeById(nodes, 'summary-report')!;
    expect(reporter.dependsOn).toContain('review-gate');
    expect(reporter.codingConfig?.codingRole).toBe('reporter');
  });

  it('embeds the task string into the scanner node', () => {
    const scan = nodeById(featureNodes({ task: 'Add /health endpoint' }), 'codebase-scan')!;

    const taskText = scan.codingAgent?.task ?? scan.codingConfig?.task ?? '';
    expect(taskText).toContain('Add /health endpoint');
  });
});

describe('bug-fix template', () => {
  it('produces at least the scan → root-cause → fix → test → report chain', () => {
    const nodes = buildBugFixTemplate({ task: 'Fix null pointer exception in auth middleware', ...BUGFIX_PARAMS });

    expect(nodes.length).toBeGreaterThanOrEqual(5);
  });

  it('assigns unique node IDs', () => {
    const nodes = buildBugFixTemplate({ task: 'Fix the crash', ...BUGFIX_PARAMS });
    const ids = nodes.map((n) => n.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a single root node with no dependencies', () => {
    const nodes = buildBugFixTemplate({ task: 'Fix the crash', ...BUGFIX_PARAMS });

    expect(nodes.filter((n) => n.dependsOn.length === 0)).toHaveLength(1);
  });
});

describe('loadCodingTemplate — structural invariants across every template', () => {
  it.each(CODING_TEMPLATE_NAMES)('%s returns a non-empty node array', (templateName) => {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);

    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it.each(CODING_TEMPLATE_NAMES)('%s emits nodes with the required fields, pending', (templateName) => {
    for (const node of loadCodingTemplate(templateName, COMMON_PARAMS)) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);
      expect(typeof node.type).toBe('string');
      expect(Array.isArray(node.dependsOn)).toBe(true);
      expect(node.status).toBe('pending');
    }
  });

  it.each(CODING_TEMPLATE_NAMES)('%s assigns unique node IDs', (templateName) => {
    const ids = loadCodingTemplate(templateName, COMMON_PARAMS).map((n) => n.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CODING_TEMPLATE_NAMES)('%s has exactly one root node', (templateName) => {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);

    expect(nodes.filter((n) => n.dependsOn.length === 0)).toHaveLength(1);
  });

  it.each(CODING_TEMPLATE_NAMES)('%s resolves every dependency to a real node', (templateName) => {
    const nodes = loadCodingTemplate(templateName, COMMON_PARAMS);
    const allIds = new Set(nodes.map((n) => n.id));

    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        expect(allIds.has(dep), `${templateName}: "${node.id}" → "${dep}"`).toBe(true);
      }
    }
  });

  it('throws on an unknown template name', () => {
    expect(() => loadCodingTemplate('nonexistent-template' as never, COMMON_PARAMS)).toThrow();
  });
});

describe('CODING_TEMPLATE_NAMES registry', () => {
  it('lists exactly the five known templates', () => {
    expect(CODING_TEMPLATE_NAMES).toHaveLength(5);
    expect(CODING_TEMPLATE_NAMES).toEqual(expect.arrayContaining([
      'feature-implementation', 'bug-fix', 'refactor', 'test-suite', 'review-iterate',
    ]));
  });
});

describe('coding node config propagation', () => {
  it('attaches a codingConfig to every node', () => {
    for (const node of featureNodes({ task: 'Add feature' })) {
      expect(node.codingConfig, `node "${node.id}"`).toBeDefined();
    }
  });

  it('passes the per-role budget and model through to the node', () => {
    const scan = nodeById(featureNodes({ task: 'Add feature' }), 'codebase-scan')!;

    expect(scan.codingAgent?.maxBudgetUsd).toBe(DEFAULT_BUDGETS.scanner);
    expect(scan.codingAgent?.model).toBe(DEFAULT_MODELS.scanner);
  });

  it('scopes tools by role — the scanner is read-only, the implementer can write', () => {
    const nodes = featureNodes({ task: 'Add feature' });

    const scan = nodeById(nodes, 'codebase-scan')!;
    const scanTools = scan.codingAgent?.allowedTools ?? scan.codingConfig?.allowedTools ?? [];
    expect(scanTools).toContain('Read');
    expect(scanTools).toContain('Glob');
    expect(scanTools).not.toContain('Write');

    const impl = nodeById(nodes, 'impl-placeholder')!;
    const implTools = impl.codingAgent?.allowedTools ?? impl.codingConfig?.allowedTools ?? [];
    expect(implTools).toContain('Write');
    expect(implTools).toContain('Edit');
  });
});
