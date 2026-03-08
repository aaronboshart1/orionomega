/**
 * Unit tests for orchestration/graph.ts
 * Tests buildGraph, validateGraph, and topologicalSort with pure in-memory data.
 */

import { describe, it, expect } from 'vitest';
import { buildGraph, validateGraph, topologicalSort } from './graph.js';
import type { WorkflowNode } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal WorkflowNode for testing. */
function node(id: string, dependsOn: string[] = []): WorkflowNode {
  return { id, type: 'AGENT', label: `Task ${id}`, dependsOn, status: 'pending' };
}

function nodeMap(...nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

// ── buildGraph ───────────────────────────────────────────────────────────────

describe('buildGraph', () => {
  it('returns a graph with the given name', () => {
    const g = buildGraph([node('a')], 'My Workflow');
    expect(g.name).toBe('My Workflow');
  });

  it('defaults name to "Untitled Workflow" when omitted', () => {
    const g = buildGraph([node('a')]);
    expect(g.name).toBe('Untitled Workflow');
  });

  it('assigns a UUID to the graph id', () => {
    const g = buildGraph([node('a')]);
    expect(g.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('stores all nodes in the graph', () => {
    const g = buildGraph([node('a'), node('b'), node('c', ['a'])]);
    expect(g.nodes.size).toBe(3);
    expect(g.nodes.has('a')).toBe(true);
    expect(g.nodes.has('b')).toBe(true);
    expect(g.nodes.has('c')).toBe(true);
  });

  it('computes entry nodes (no dependencies)', () => {
    const g = buildGraph([node('a'), node('b'), node('c', ['a', 'b'])]);
    expect(g.entryNodes.sort()).toEqual(['a', 'b']);
  });

  it('computes exit nodes (no dependents)', () => {
    const g = buildGraph([node('a'), node('b', ['a']), node('c', ['a'])]);
    // b and c have no dependents
    expect(g.exitNodes.sort()).toEqual(['b', 'c']);
  });

  it('computes correct topological layers for a linear chain', () => {
    // a → b → c
    const g = buildGraph([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(g.layers).toEqual([['a'], ['b'], ['c']]);
  });

  it('puts parallel tasks in the same layer', () => {
    // a and b in parallel, then c depends on both
    const g = buildGraph([node('a'), node('b'), node('c', ['a', 'b'])]);
    expect(g.layers[0].sort()).toEqual(['a', 'b']);
    expect(g.layers[1]).toEqual(['c']);
  });

  it('throws on duplicate node IDs', () => {
    expect(() => buildGraph([node('a'), node('a')])).toThrow(
      "Duplicate node ID: 'a'",
    );
  });

  it('throws when a dependency references an unknown node', () => {
    expect(() => buildGraph([node('b', ['missing'])])).toThrow(
      'Graph validation failed',
    );
  });

  it('throws on a cycle', () => {
    // a → b → a
    expect(() =>
      buildGraph([node('a', ['b']), node('b', ['a'])]),
    ).toThrow('Cycle detected');
  });

  it('handles an empty node list', () => {
    const g = buildGraph([]);
    expect(g.nodes.size).toBe(0);
    expect(g.layers).toEqual([]);
    expect(g.entryNodes).toEqual([]);
    expect(g.exitNodes).toEqual([]);
  });

  it('handles a single node', () => {
    const g = buildGraph([node('solo')], 'Solo');
    expect(g.entryNodes).toEqual(['solo']);
    expect(g.exitNodes).toEqual(['solo']);
    expect(g.layers).toEqual([['solo']]);
  });
});

// ── validateGraph ────────────────────────────────────────────────────────────

describe('validateGraph', () => {
  it('returns no errors for an empty graph', () => {
    expect(validateGraph(new Map())).toEqual([]);
  });

  it('returns no errors for a valid single-node graph', () => {
    expect(validateGraph(nodeMap(node('a')))).toEqual([]);
  });

  it('catches missing dependency reference', () => {
    const errors = validateGraph(nodeMap(node('a', ['ghost'])));
    expect(errors.some((e) => e.message.includes("unknown node 'ghost'"))).toBe(true);
  });

  it('catches self-dependency', () => {
    const errors = validateGraph(nodeMap(node('a', ['a'])));
    expect(errors.some((e) => e.message.includes('depends on itself'))).toBe(true);
  });

  it('catches a cycle between two nodes', () => {
    const errors = validateGraph(nodeMap(node('x', ['y']), node('y', ['x'])));
    expect(errors.some((e) => e.message.includes('Cycle detected'))).toBe(true);
  });
});

// ── topologicalSort ──────────────────────────────────────────────────────────

describe('topologicalSort', () => {
  it('returns empty layers for an empty graph', () => {
    expect(topologicalSort(new Map())).toEqual([]);
  });

  it('returns a single layer for a single node', () => {
    expect(topologicalSort(nodeMap(node('x')))).toEqual([['x']]);
  });

  it('sorts a diamond dependency correctly', () => {
    // a → b, a → c, b → d, c → d
    const layers = topologicalSort(
      nodeMap(
        node('a'),
        node('b', ['a']),
        node('c', ['a']),
        node('d', ['b', 'c']),
      ),
    );
    expect(layers[0]).toEqual(['a']);
    expect(layers[1].sort()).toEqual(['b', 'c']);
    expect(layers[2]).toEqual(['d']);
  });

  it('throws on a cycle', () => {
    expect(() =>
      topologicalSort(nodeMap(node('p', ['q']), node('q', ['p']))),
    ).toThrow('Cycle detected');
  });

  it('produces deterministic (sorted) output within each layer', () => {
    const layers = topologicalSort(
      nodeMap(node('z'), node('a'), node('m')),
    );
    expect(layers).toEqual([['a', 'm', 'z']]);
  });
});
