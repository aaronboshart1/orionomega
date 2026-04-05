#!/usr/bin/env tsx
/**
 * Unit tests for orchestration/graph.ts
 * Tests: validateGraph, topologicalSort, buildGraph
 */

import { suite, section, assert, assertEq, assertDeepEq, assertThrows, printSummary, resetResults } from './test-harness.js';
import { validateGraph, topologicalSort, buildGraph } from '../packages/core/src/orchestration/graph.js';
import type { WorkflowNode } from '../packages/core/src/orchestration/types.js';

// ── Helper ──────────────────────────────────────────────────────

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
  return new Map(nodes.map(n => [n.id, n]));
}

// ── Tests ───────────────────────────────────────────────────────

resetResults();
suite('Graph — validateGraph, topologicalSort, buildGraph');

// ── validateGraph ───────────────────────────────────────────────

section('validateGraph — empty graph');
{
  const errors = validateGraph(new Map());
  assertEq(errors.length, 0, 'empty graph has no errors');
}

section('validateGraph — single node');
{
  const errors = validateGraph(toMap([makeNode('a')]));
  assertEq(errors.length, 0, 'single node with no deps is valid');
}

section('validateGraph — simple chain');
{
  const errors = validateGraph(toMap([
    makeNode('a'),
    makeNode('b', ['a']),
    makeNode('c', ['b']),
  ]));
  assertEq(errors.length, 0, 'A → B → C chain is valid');
}

section('validateGraph — missing dependency');
{
  const errors = validateGraph(toMap([
    makeNode('a'),
    makeNode('b', ['missing']),
  ]));
  assert(errors.length > 0, 'detects missing dependency');
  assert(errors.some(e => e.nodeId === 'b' && e.message.includes('missing')), 'error references node b and missing dep');
}

section('validateGraph — self dependency');
{
  const errors = validateGraph(toMap([
    makeNode('a', ['a']),
  ]));
  assert(errors.some(e => e.message.includes('depends on itself')), 'detects self-dependency');
}

section('validateGraph — cycle detection');
{
  const errors = validateGraph(toMap([
    makeNode('a', ['c']),
    makeNode('b', ['a']),
    makeNode('c', ['b']),
  ]));
  assert(errors.some(e => e.message.includes('Cycle detected')), 'detects cycle A→B→C→A');
}

section('validateGraph — orphan detection in multi-node graph');
{
  // Two independent nodes with no connections = both are orphans
  const errors = validateGraph(toMap([
    makeNode('a'),
    makeNode('b'),
  ]));
  assert(errors.some(e => e.message.includes('Orphan')), 'detects orphan nodes');
}

section('validateGraph — diamond graph is valid');
{
  const errors = validateGraph(toMap([
    makeNode('a'),
    makeNode('b', ['a']),
    makeNode('c', ['a']),
    makeNode('d', ['b', 'c']),
  ]));
  assertEq(errors.length, 0, 'diamond graph (A→B,C→D) is valid');
}

// ── topologicalSort ─────────────────────────────────────────────

section('topologicalSort — empty');
{
  const layers = topologicalSort(new Map());
  assertEq(layers.length, 0, 'empty graph returns no layers');
}

section('topologicalSort — single node');
{
  const layers = topologicalSort(toMap([makeNode('a')]));
  assertEq(layers.length, 1, 'single node = 1 layer');
  assertDeepEq(layers[0], ['a'], 'layer 0 contains a');
}

section('topologicalSort — chain');
{
  const layers = topologicalSort(toMap([
    makeNode('a'),
    makeNode('b', ['a']),
    makeNode('c', ['b']),
  ]));
  assertEq(layers.length, 3, 'chain A→B→C = 3 layers');
  assertDeepEq(layers[0], ['a'], 'layer 0 = [a]');
  assertDeepEq(layers[1], ['b'], 'layer 1 = [b]');
  assertDeepEq(layers[2], ['c'], 'layer 2 = [c]');
}

section('topologicalSort — parallel nodes');
{
  const layers = topologicalSort(toMap([
    makeNode('a'),
    makeNode('b'),
    makeNode('c', ['a', 'b']),
  ]));
  assertEq(layers.length, 2, 'parallel entry + join = 2 layers');
  assertDeepEq(layers[0], ['a', 'b'], 'layer 0 has parallel nodes (sorted)');
  assertDeepEq(layers[1], ['c'], 'layer 1 has join node');
}

section('topologicalSort — diamond');
{
  const layers = topologicalSort(toMap([
    makeNode('a'),
    makeNode('b', ['a']),
    makeNode('c', ['a']),
    makeNode('d', ['b', 'c']),
  ]));
  assertEq(layers.length, 3, 'diamond = 3 layers');
  assertDeepEq(layers[0], ['a'], 'layer 0 = entry');
  assertDeepEq(layers[1], ['b', 'c'], 'layer 1 = parallel middle');
  assertDeepEq(layers[2], ['d'], 'layer 2 = exit');
}

section('topologicalSort — cycle throws');
{
  assertThrows(
    () => topologicalSort(toMap([
      makeNode('a', ['b']),
      makeNode('b', ['a']),
    ])),
    'throws on cycle A↔B',
  );
}

// ── buildGraph ──────────────────────────────────────────────────

section('buildGraph — simple valid graph');
{
  const graph = buildGraph([
    makeNode('a'),
    makeNode('b', ['a']),
  ], 'Test Workflow');
  assertEq(graph.name, 'Test Workflow', 'name is set');
  assert(graph.id.length > 0, 'id is generated');
  assertEq(graph.nodes.size, 2, 'nodes map has 2 entries');
  assertDeepEq(graph.entryNodes, ['a'], 'entry nodes = [a]');
  assertDeepEq(graph.exitNodes, ['b'], 'exit nodes = [b]');
  assertEq(graph.layers.length, 2, 'has 2 layers');
}

section('buildGraph — default name');
{
  const graph = buildGraph([makeNode('a')]);
  assertEq(graph.name, 'Untitled Workflow', 'defaults to Untitled Workflow');
}

section('buildGraph — duplicate ID throws');
{
  assertThrows(
    () => buildGraph([makeNode('a'), makeNode('a')]),
    'throws on duplicate node ID',
  );
}

section('buildGraph — missing dependency throws');
{
  assertThrows(
    () => buildGraph([makeNode('a', ['nonexistent'])]),
    'throws on missing dependency',
  );
}

section('buildGraph — cycle throws');
{
  assertThrows(
    () => buildGraph([makeNode('a', ['b']), makeNode('b', ['a'])]),
    'throws on cycle',
  );
}

section('buildGraph — diamond graph entry/exit');
{
  const graph = buildGraph([
    makeNode('start'),
    makeNode('left', ['start']),
    makeNode('right', ['start']),
    makeNode('end', ['left', 'right']),
  ]);
  assertDeepEq(graph.entryNodes, ['start'], 'diamond entry = [start]');
  assertDeepEq(graph.exitNodes, ['end'], 'diamond exit = [end]');
  assertDeepEq(graph.layers[1], ['left', 'right'], 'middle layer has parallel nodes');
}

const ok = printSummary('Graph Tests');
process.exit(ok ? 0 : 1);
