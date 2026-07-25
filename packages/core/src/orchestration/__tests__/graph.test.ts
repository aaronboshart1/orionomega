/**
 * @module __tests__/graph
 * Unit tests for orchestration/graph.ts — validateGraph, topologicalSort, buildGraph.
 */

import { describe, it, expect } from 'vitest';
import { validateGraph, topologicalSort, buildGraph } from '../graph.js';
import type { WorkflowNode } from '../types.js';

function makeNode(id: string, dependsOn: string[] = [], type: WorkflowNode['type'] = 'AGENT'): WorkflowNode {
  return {
    id,
    type,
    label: `Node ${id}`,
    dependsOn,
    status: 'pending',
  };
}

function toMap(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe('validateGraph', () => {
  it('reports no errors for an empty graph', () => {
    expect(validateGraph(new Map())).toHaveLength(0);
  });

  it('accepts a single node with no dependencies', () => {
    expect(validateGraph(toMap([makeNode('a')]))).toHaveLength(0);
  });

  it('accepts a simple A → B → C chain', () => {
    const errors = validateGraph(toMap([
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ]));
    expect(errors).toHaveLength(0);
  });

  it('detects a missing dependency and attributes it to the referring node', () => {
    const errors = validateGraph(toMap([
      makeNode('a'),
      makeNode('b', ['missing']),
    ]));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.nodeId === 'b' && e.message.includes('missing'))).toBe(true);
  });

  it('detects a self-dependency', () => {
    const errors = validateGraph(toMap([makeNode('a', ['a'])]));
    expect(errors.some((e) => e.message.includes('depends on itself'))).toBe(true);
  });

  it('detects a cycle A→B→C→A', () => {
    const errors = validateGraph(toMap([
      makeNode('a', ['c']),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ]));
    expect(errors.some((e) => e.message.includes('Cycle detected'))).toBe(true);
  });

  it('detects orphan nodes in a multi-node graph', () => {
    // Two independent nodes with no connections — both are orphans.
    const errors = validateGraph(toMap([makeNode('a'), makeNode('b')]));
    expect(errors.some((e) => e.message.includes('Orphan'))).toBe(true);
  });

  it('accepts a diamond graph', () => {
    const errors = validateGraph(toMap([
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['a']),
      makeNode('d', ['b', 'c']),
    ]));
    expect(errors).toHaveLength(0);
  });
});

describe('topologicalSort', () => {
  it('returns no layers for an empty graph', () => {
    expect(topologicalSort(new Map())).toHaveLength(0);
  });

  it('returns one layer for a single node', () => {
    const layers = topologicalSort(toMap([makeNode('a')]));
    expect(layers).toEqual([['a']]);
  });

  it('splits a chain into one layer per node', () => {
    const layers = topologicalSort(toMap([
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['b']),
    ]));
    expect(layers).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups independent nodes into a single layer ahead of their join', () => {
    const layers = topologicalSort(toMap([
      makeNode('a'),
      makeNode('b'),
      makeNode('c', ['a', 'b']),
    ]));
    expect(layers).toEqual([['a', 'b'], ['c']]);
  });

  it('produces three layers for a diamond', () => {
    const layers = topologicalSort(toMap([
      makeNode('a'),
      makeNode('b', ['a']),
      makeNode('c', ['a']),
      makeNode('d', ['b', 'c']),
    ]));
    expect(layers).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('throws on a cycle', () => {
    expect(() => topologicalSort(toMap([
      makeNode('a', ['b']),
      makeNode('b', ['a']),
    ]))).toThrow();
  });
});

describe('buildGraph', () => {
  it('builds a simple valid graph with entry/exit nodes and layers', () => {
    const graph = buildGraph([makeNode('a'), makeNode('b', ['a'])], 'Test Workflow');
    expect(graph.name).toBe('Test Workflow');
    expect(graph.id.length).toBeGreaterThan(0);
    expect(graph.nodes.size).toBe(2);
    expect(graph.entryNodes).toEqual(['a']);
    expect(graph.exitNodes).toEqual(['b']);
    expect(graph.layers).toHaveLength(2);
  });

  it('defaults the workflow name', () => {
    expect(buildGraph([makeNode('a')]).name).toBe('Untitled Workflow');
  });

  it('throws on a duplicate node ID', () => {
    expect(() => buildGraph([makeNode('a'), makeNode('a')])).toThrow();
  });

  it('throws on a missing dependency', () => {
    expect(() => buildGraph([makeNode('a', ['nonexistent'])])).toThrow();
  });

  it('throws on a cycle', () => {
    expect(() => buildGraph([makeNode('a', ['b']), makeNode('b', ['a'])])).toThrow();
  });

  it('derives entry/exit and the parallel middle layer of a diamond', () => {
    const graph = buildGraph([
      makeNode('start'),
      makeNode('left', ['start']),
      makeNode('right', ['start']),
      makeNode('end', ['left', 'right']),
    ]);
    expect(graph.entryNodes).toEqual(['start']);
    expect(graph.exitNodes).toEqual(['end']);
    expect(graph.layers[1]).toEqual(['left', 'right']);
  });
});
