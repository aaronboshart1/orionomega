/**
 * @module stores/orchestration.test
 * Unit tests for the orchestration store — the snapshot/event processing
 * that the gateway client feeds. These actions are the client-side reducers
 * for live worker events, inline-DAG lifecycle frames, per-workflow event
 * buffering, and full-snapshot rehydration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useOrchestrationStore } from './orchestration';
import type { InlineDAG, WorkerEvent, GraphState } from './orchestration';

const store = () => useOrchestrationStore.getState();

function dag(overrides: Partial<InlineDAG> = {}): InlineDAG {
  return {
    dagId: 'dag-1',
    summary: 'Build a thing',
    status: 'dispatched',
    nodes: [
      { id: 'n1', label: 'Plan', type: 'AGENT', status: 'pending' },
      { id: 'n2', label: 'Implement', type: 'CODING_AGENT', status: 'pending' },
    ],
    completedCount: 0,
    totalCount: 2,
    elapsed: 0,
    ...overrides,
  };
}

function workerEvent(overrides: Partial<WorkerEvent> = {}): WorkerEvent {
  return {
    workerId: 'w1',
    nodeId: 'n1',
    timestamp: new Date().toISOString(),
    type: 'tool_call' as WorkerEvent['type'],
    ...overrides,
  };
}

function graphState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    workflowId: 'wf-1',
    name: 'My workflow',
    status: 'running',
    elapsed: 0,
    nodes: {},
    recentEvents: [],
    completedLayers: 0,
    totalLayers: 1,
    ...overrides,
  };
}

beforeEach(() => {
  store().reset();
});

describe('upsertInlineDAG', () => {
  it('inserts a new DAG and marks it active', () => {
    store().upsertInlineDAG(dag());
    expect(store().inlineDAGs['dag-1']).toBeDefined();
    expect(store().activeWorkflowId).toBe('dag-1');
  });

  it('merges later partial frames while preserving seeded identity fields', () => {
    store().upsertInlineDAG(dag({ isDirect: true, summary: 'Original summary' }));
    // A later frame (e.g. direct_complete) carries no summary/nodes.
    store().upsertInlineDAG({
      dagId: 'dag-1',
      summary: '',
      status: 'running',
      nodes: [],
      completedCount: 0,
      totalCount: 2,
      elapsed: 5,
    });
    const merged = store().inlineDAGs['dag-1'];
    expect(merged.summary).toBe('Original summary');
    expect(merged.isDirect).toBe(true);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.status).toBe('running');
  });
});

describe('updateDAGNode', () => {
  it('updates a node and recomputes completedCount', () => {
    store().upsertInlineDAG(dag());
    store().updateDAGNode('dag-1', 'n1', { status: 'done' });
    const d = store().inlineDAGs['dag-1'];
    expect(d.nodes.find((n) => n.id === 'n1')!.status).toBe('done');
    expect(d.completedCount).toBe(1);
    expect(d.status).toBe('running');
  });

  it('is a no-op for an unknown DAG', () => {
    store().updateDAGNode('ghost', 'n1', { status: 'done' });
    expect(store().inlineDAGs['ghost']).toBeUndefined();
  });
});

describe('completeDAG', () => {
  beforeEach(() => store().upsertInlineDAG(dag()));

  it('marks complete with stats on success', () => {
    store().completeDAG('dag-1', 'all good', undefined, { durationSec: 12, workerCount: 2 });
    const d = store().inlineDAGs['dag-1'];
    expect(d.status).toBe('complete');
    expect(d.result).toBe('all good');
    expect(d.completedCount).toBe(d.totalCount);
    expect(d.durationSec).toBe(12);
  });

  it('marks error when an error is supplied', () => {
    store().completeDAG('dag-1', undefined, 'boom');
    expect(store().inlineDAGs['dag-1'].status).toBe('error');
  });

  it('marks stopped and superseded based on stats flags', () => {
    store().completeDAG('dag-1', undefined, undefined, { stopped: true });
    expect(store().inlineDAGs['dag-1'].status).toBe('stopped');

    store().upsertInlineDAG(dag({ dagId: 'dag-2' }));
    store().completeDAG('dag-2', undefined, undefined, { supersededBy: 'dag-9' });
    expect(store().inlineDAGs['dag-2'].status).toBe('superseded');
    expect(store().inlineDAGs['dag-2'].supersededBy).toBe('dag-9');
  });
});

describe('addEvent — per-workflow buffering', () => {
  it('buffers events under their workflow id and derives the active view', () => {
    store().addEvent(workerEvent({ message: 'first' }), 'wf-1');
    store().addEvent(workerEvent({ message: 'second' }), 'wf-1');
    expect(store().workflows['wf-1'].events).toHaveLength(2);
    expect(store().activeWorkflowId).toBe('wf-1');
    expect(store().events).toHaveLength(2);
  });

  it('caps a workflow event buffer at 1000 entries', () => {
    for (let i = 0; i < 1005; i++) {
      store().addEvent(workerEvent({ message: `e${i}` }), 'wf-1');
    }
    expect(store().workflows['wf-1'].events.length).toBe(1000);
  });
});

describe('setGraphState', () => {
  it('stores graph state and activates the workflow', () => {
    store().setGraphState(graphState());
    expect(store().workflows['wf-1'].graphState).not.toBeNull();
    expect(store().activeWorkflowId).toBe('wf-1');
    expect(store().graphState?.name).toBe('My workflow');
  });
});

describe('hydrateFromSnapshot', () => {
  it('replaces store state from a server snapshot and selects the last workflow', () => {
    const snapshot = {
      inlineDAGs: { 'dag-1': dag() },
      workflows: {
        'wf-a': { graphState: graphState({ workflowId: 'wf-a' }), events: [] },
        'wf-b': { graphState: graphState({ workflowId: 'wf-b', name: 'Second' }), events: [] },
      },
      memoryEvents: [],
    };
    store().hydrateFromSnapshot(snapshot);
    expect(Object.keys(store().workflows).sort()).toEqual(['wf-a', 'wf-b']);
    expect(store().activeWorkflowId).toBe('wf-b');
    expect(store().activeOrchTab).toBe('workflow');
    expect(store().inlineDAGs['dag-1']).toBeDefined();
  });

  it('defaults to the memory tab when there are no workflows', () => {
    store().hydrateFromSnapshot({ workflows: {} });
    expect(store().activeOrchTab).toBe('memory');
    expect(store().activeWorkflowId).toBeNull();
  });
});

describe('removeInlineDAG', () => {
  it('removes an inline DAG by id', () => {
    store().upsertInlineDAG(dag());
    store().removeInlineDAG('dag-1');
    expect(store().inlineDAGs['dag-1']).toBeUndefined();
  });
});
