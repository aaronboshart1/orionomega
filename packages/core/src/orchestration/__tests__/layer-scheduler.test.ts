/**
 * @module orchestration/__tests__/layer-scheduler
 *
 * Task #237 — focused unit tests for the LayerScheduler collaborator extracted
 * from `executor.ts`. Covers runnable-node filtering (skipped / done / failed
 * deps), router-driven subtree skipping, and recursive subtree marking.
 */
import { describe, it, expect } from 'vitest';
import { LayerScheduler } from '../layer-scheduler.js';
import type { WorkflowGraph, WorkflowNode } from '../types.js';
import type { WorkerResult } from '../worker.js';

function node(partial: Partial<WorkflowNode> & { id: string }): WorkflowNode {
  return {
    type: 'AGENT',
    label: partial.id,
    dependsOn: [],
    status: 'pending',
    ...partial,
  } as WorkflowNode;
}

function graphOf(nodes: WorkflowNode[]): WorkflowGraph {
  return {
    id: 'g',
    name: 'g',
    createdAt: new Date().toISOString(),
    nodes: new Map(nodes.map((n) => [n.id, n])),
    layers: [],
    entryNodes: [],
    exitNodes: [],
  };
}

describe('computeRunnableNodes', () => {
  it('excludes already-skipped and already-done nodes', () => {
    const g = graphOf([node({ id: 'a' }), node({ id: 'b', status: 'done' }), node({ id: 'c' })]);
    const skipped = new Set<string>(['a']);
    const s = new LayerScheduler(g, skipped, new Map(), new Map());
    expect(s.computeRunnableNodes(['a', 'b', 'c'])).toEqual(['c']);
  });

  it('skips a node whose upstream dependency failed and marks it skipped', () => {
    const g = graphOf([
      node({ id: 'dep' }),
      node({ id: 'child', dependsOn: ['dep'] }),
    ]);
    const skipped = new Set<string>();
    const errors = new Map<string, string>([['dep', 'boom']]);
    const s = new LayerScheduler(g, skipped, errors, new Map());
    expect(s.computeRunnableNodes(['child'])).toEqual([]);
    expect(skipped.has('child')).toBe(true);
    expect(g.nodes.get('child')!.status).toBe('skipped');
  });

  it('keeps a node runnable when its dependencies all succeeded', () => {
    const g = graphOf([node({ id: 'dep', status: 'done' }), node({ id: 'child', dependsOn: ['dep'] })]);
    const s = new LayerScheduler(g, new Set(), new Map(), new Map());
    expect(s.computeRunnableNodes(['child'])).toEqual(['child']);
  });
});

describe('evaluateRouters', () => {
  it('skips the subtrees of routes the router did not select', () => {
    const router = node({
      id: 'r',
      type: 'ROUTER',
      status: 'done',
      router: { routes: { yes: 'taken', no: 'dropped' } } as WorkflowNode['router'],
    });
    const g = graphOf([
      router,
      node({ id: 'taken', dependsOn: ['r'] }),
      node({ id: 'dropped', dependsOn: ['r'] }),
      node({ id: 'droppedChild', dependsOn: ['dropped'] }),
    ]);
    const results = new Map<string, WorkerResult>([
      ['r', { nodeId: 'r', output: { route: 'yes', target: 'taken' }, durationMs: 0, toolCallCount: 0, findings: [], outputPaths: [] }],
    ]);
    const skipped = new Set<string>();
    const s = new LayerScheduler(g, skipped, new Map(), results);
    s.evaluateRouters(['r']);
    expect(skipped.has('dropped')).toBe(true);
    expect(skipped.has('droppedChild')).toBe(true);
    expect(skipped.has('taken')).toBe(false);
  });

  it('ignores non-router or not-yet-done nodes', () => {
    const g = graphOf([node({ id: 'a', status: 'pending' })]);
    const skipped = new Set<string>();
    const s = new LayerScheduler(g, skipped, new Map(), new Map());
    s.evaluateRouters(['a']);
    expect(skipped.size).toBe(0);
  });
});

describe('markSubtreeSkipped', () => {
  it('recursively skips a node and every exclusively-dependent descendant', () => {
    const g = graphOf([
      node({ id: 'root' }),
      node({ id: 'child', dependsOn: ['root'] }),
      node({ id: 'grandchild', dependsOn: ['child'] }),
    ]);
    const skipped = new Set<string>();
    const s = new LayerScheduler(g, skipped, new Map(), new Map());
    s.markSubtreeSkipped('root');
    expect([...skipped].sort()).toEqual(['child', 'grandchild', 'root']);
  });

  it('does not skip a descendant that still has a non-skipped dependency', () => {
    const g = graphOf([
      node({ id: 'a' }),
      node({ id: 'b' }),
      node({ id: 'joined', dependsOn: ['a', 'b'] }),
    ]);
    const skipped = new Set<string>();
    const s = new LayerScheduler(g, skipped, new Map(), new Map());
    s.markSubtreeSkipped('a');
    expect(skipped.has('a')).toBe(true);
    expect(skipped.has('joined')).toBe(false); // 'b' is still live
  });
});
