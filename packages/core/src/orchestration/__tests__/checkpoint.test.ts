/**
 * @module __tests__/checkpoint
 * Unit tests for orchestration/checkpoint.ts — graphFromCheckpoint, buildCheckpoint,
 * and save/load/remove/findIncomplete against a real temp directory.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from '../checkpoint.js';
import type { WorkflowCheckpoint, WorkflowGraph, WorkflowNode } from '../types.js';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

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

describe('CheckpointManager.graphFromCheckpoint', () => {
  it('rehydrates the serialized node Record into a Map, preserving graph metadata', () => {
    const graph = CheckpointManager.graphFromCheckpoint(makeSampleCheckpoint());

    expect(graph.nodes).toBeInstanceOf(Map);
    expect(graph.nodes.size).toBe(2);
    expect(graph.id).toBe('wf-test-123');
    expect(graph.name).toBe('Test Workflow');
    expect(graph.layers).toEqual([['a'], ['b']]);
    expect(graph.entryNodes).toEqual(['a']);
    expect(graph.exitNodes).toEqual(['b']);
  });

  it('preserves per-node data', () => {
    const graph = CheckpointManager.graphFromCheckpoint(makeSampleCheckpoint());

    expect(graph.nodes.get('a')).toBeDefined();
    expect(graph.nodes.get('a')!.type).toBe('AGENT');
    expect(graph.nodes.get('b')!.dependsOn).toEqual(['a']);
  });
});

describe('CheckpointManager.buildCheckpoint', () => {
  it('serializes the node Map to a plain Record', () => {
    const checkpoint = CheckpointManager.buildCheckpoint(
      makeGraph(),
      'Run tests',
      { a: 'output-a' },
      1,
      'running',
      ['/tmp/out.txt'],
      ['decision-1'],
      ['finding-1'],
      [],
    );

    expect(checkpoint.workflowId).toBe('wf-test-123');
    expect(checkpoint.task).toBe('Run tests');
    expect(checkpoint.currentLayer).toBe(1);
    expect(checkpoint.status).toBe('running');
    expect(checkpoint.graph.nodes).not.toBeInstanceOf(Map);
    expect(checkpoint.graph.nodes).toHaveProperty('a');
    expect(checkpoint.graph.nodes).toHaveProperty('b');
  });

  it('round-trips through graphFromCheckpoint', () => {
    const graph = makeGraph();
    const checkpoint = CheckpointManager.buildCheckpoint(graph, 'task', {}, 0, 'running', [], [], [], []);
    const restored = CheckpointManager.graphFromCheckpoint(checkpoint);

    expect(restored.nodes.size).toBe(graph.nodes.size);
    expect(restored.id).toBe(graph.id);
    expect(restored.layers).toEqual(graph.layers);
  });
});

describe('CheckpointManager — persistence', () => {
  it('round-trips a checkpoint through save/load', () => {
    const mgr = new CheckpointManager(tmpDir('checkpoint-test'));
    mgr.save(makeSampleCheckpoint());

    const loaded = mgr.load('wf-test-123');
    expect(loaded).not.toBeNull();
    expect(loaded!.workflowId).toBe('wf-test-123');
    expect(loaded!.task).toBe('Run tests');
    expect(loaded!.currentLayer).toBe(1);
    expect(loaded!.nodeOutputs).toEqual({ a: 'output-a' });
  });

  it('returns null when loading a checkpoint that does not exist', () => {
    const mgr = new CheckpointManager(tmpDir('checkpoint-test-empty'));
    expect(mgr.load('nonexistent')).toBeNull();
  });

  it('removes a checkpoint', () => {
    const mgr = new CheckpointManager(tmpDir('checkpoint-test-remove'));
    mgr.save(makeSampleCheckpoint());
    mgr.remove('wf-test-123');

    expect(mgr.load('wf-test-123')).toBeNull();
  });

  it('findIncomplete returns only checkpoints still running', () => {
    const mgr = new CheckpointManager(tmpDir('checkpoint-test-incomplete'));

    const running = makeSampleCheckpoint();
    running.workflowId = 'wf-running';
    running.status = 'running';
    mgr.save(running);

    const complete = makeSampleCheckpoint();
    complete.workflowId = 'wf-complete';
    complete.status = 'complete';
    mgr.save(complete);

    const incomplete = mgr.findIncomplete();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].workflowId).toBe('wf-running');
  });
});
