#!/usr/bin/env tsx
/**
 * Unit tests for orchestration/checkpoint.ts
 * Tests: CheckpointManager.graphFromCheckpoint, CheckpointManager.buildCheckpoint
 * Also tests save/load/remove/findIncomplete via real FS (temp dir).
 */

import { suite, section, assert, assertEq, assertDeepEq, printSummary, resetResults, tmpDir, cleanupTmp } from './test-harness.js';
import { CheckpointManager } from '../packages/core/src/orchestration/checkpoint.js';
import type { WorkflowCheckpoint, WorkflowGraph, WorkflowNode } from '../packages/core/src/orchestration/types.js';

// ── Helpers ─────────────────────────────────────────────────────

function makeNode(id: string, deps: string[] = []): WorkflowNode {
  return { id, type: 'AGENT', label: `Node ${id}`, dependsOn: deps, status: 'pending' };
}

function makeGraph(): WorkflowGraph {
  const nodes = new Map<string, WorkflowNode>();
  nodes.set('a', makeNode('a'));
  nodes.set('b', makeNode('b', ['a']));
  return {
    id: 'wf-test-123',
    name: 'Test Workflow',
    createdAt: '2025-01-01T00:00:00Z',
    nodes,
    layers: [['a'], ['b']],
    entryNodes: ['a'],
    exitNodes: ['b'],
  };
}

function makeSampleCheckpoint(): WorkflowCheckpoint {
  return {
    workflowId: 'wf-test-123',
    task: 'Run tests',
    timestamp: '2025-01-01T00:00:00Z',
    graph: {
      id: 'wf-test-123',
      name: 'Test Workflow',
      createdAt: '2025-01-01T00:00:00Z',
      nodes: {
        a: makeNode('a'),
        b: makeNode('b', ['a']),
      },
      layers: [['a'], ['b']],
      entryNodes: ['a'],
      exitNodes: ['b'],
    },
    nodeOutputs: { a: 'output-a' },
    currentLayer: 1,
    status: 'running',
    outputPaths: ['/tmp/out.txt'],
    decisions: ['decision-1'],
    findings: ['finding-1'],
    errors: [],
  };
}

// ── Tests ───────────────────────────────────────────────────────

resetResults();
suite('Checkpoint — graphFromCheckpoint, buildCheckpoint, save/load');

// ── graphFromCheckpoint ─────────────────────────────────────────

section('graphFromCheckpoint — converts Record to Map');
{
  const checkpoint = makeSampleCheckpoint();
  const graph = CheckpointManager.graphFromCheckpoint(checkpoint);

  assert(graph.nodes instanceof Map, 'nodes is a Map');
  assertEq(graph.nodes.size, 2, 'has 2 nodes');
  assertEq(graph.id, 'wf-test-123', 'preserves graph id');
  assertEq(graph.name, 'Test Workflow', 'preserves name');
  assertDeepEq(graph.layers, [['a'], ['b']], 'preserves layers');
  assertDeepEq(graph.entryNodes, ['a'], 'preserves entry nodes');
  assertDeepEq(graph.exitNodes, ['b'], 'preserves exit nodes');
}

section('graphFromCheckpoint — node data preserved');
{
  const checkpoint = makeSampleCheckpoint();
  const graph = CheckpointManager.graphFromCheckpoint(checkpoint);
  const nodeA = graph.nodes.get('a');
  const nodeB = graph.nodes.get('b');

  assert(nodeA !== undefined, 'node a exists');
  assertEq(nodeA!.type, 'AGENT', 'node a type preserved');
  assertDeepEq(nodeB!.dependsOn, ['a'], 'node b deps preserved');
}

// ── buildCheckpoint ─────────────────────────────────────────────

section('buildCheckpoint — serializes Map to Record');
{
  const graph = makeGraph();
  const checkpoint = CheckpointManager.buildCheckpoint(
    graph,
    'Run tests',
    { a: 'output-a' },
    1,
    'running',
    ['/tmp/out.txt'],
    ['decision-1'],
    ['finding-1'],
    [],
  );

  assertEq(checkpoint.workflowId, 'wf-test-123', 'workflowId from graph');
  assertEq(checkpoint.task, 'Run tests', 'task preserved');
  assertEq(checkpoint.currentLayer, 1, 'currentLayer preserved');
  assertEq(checkpoint.status, 'running', 'status preserved');
  assert(!(checkpoint.graph.nodes instanceof Map), 'serialized nodes is not a Map');
  assert('a' in checkpoint.graph.nodes, 'node a in serialized record');
  assert('b' in checkpoint.graph.nodes, 'node b in serialized record');
}

section('buildCheckpoint — round-trip with graphFromCheckpoint');
{
  const graph = makeGraph();
  const checkpoint = CheckpointManager.buildCheckpoint(
    graph, 'task', {}, 0, 'running', [], [], [], [],
  );
  const restored = CheckpointManager.graphFromCheckpoint(checkpoint);

  assertEq(restored.nodes.size, graph.nodes.size, 'node count matches');
  assertEq(restored.id, graph.id, 'id matches');
  assertDeepEq(restored.layers, graph.layers, 'layers match');
}

// ── save/load/remove via FS ─────────────────────────────────────

section('save and load — round-trip');
{
  const dir = tmpDir('checkpoint-test');
  const mgr = new CheckpointManager(dir);
  const checkpoint = makeSampleCheckpoint();

  mgr.save(checkpoint);
  const loaded = mgr.load('wf-test-123');

  assert(loaded !== null, 'checkpoint loaded');
  assertEq(loaded!.workflowId, 'wf-test-123', 'workflowId matches');
  assertEq(loaded!.task, 'Run tests', 'task matches');
  assertEq(loaded!.currentLayer, 1, 'currentLayer matches');
  assertDeepEq(loaded!.nodeOutputs, { a: 'output-a' }, 'nodeOutputs match');
}

section('load — returns null for nonexistent');
{
  const dir = tmpDir('checkpoint-test-empty');
  const mgr = new CheckpointManager(dir);
  const loaded = mgr.load('nonexistent');
  assertEq(loaded, null, 'returns null for missing checkpoint');
}

section('remove — deletes checkpoint');
{
  const dir = tmpDir('checkpoint-test-remove');
  const mgr = new CheckpointManager(dir);
  mgr.save(makeSampleCheckpoint());
  mgr.remove('wf-test-123');
  const loaded = mgr.load('wf-test-123');
  assertEq(loaded, null, 'checkpoint removed');
}

section('findIncomplete — finds running checkpoints');
{
  const dir = tmpDir('checkpoint-test-incomplete');
  const mgr = new CheckpointManager(dir);

  const running = makeSampleCheckpoint();
  running.workflowId = 'wf-running';
  running.status = 'running';
  mgr.save(running);

  const complete = makeSampleCheckpoint();
  complete.workflowId = 'wf-complete';
  complete.status = 'complete';
  mgr.save(complete);

  const incomplete = mgr.findIncomplete();
  assertEq(incomplete.length, 1, 'finds 1 incomplete');
  assertEq(incomplete[0].workflowId, 'wf-running', 'finds the running workflow');
}

// Cleanup
cleanupTmp();

const ok = printSummary('Checkpoint Tests');
process.exit(ok ? 0 : 1);
