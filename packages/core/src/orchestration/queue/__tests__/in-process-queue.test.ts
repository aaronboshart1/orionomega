/**
 * @module orchestration/queue/__tests__/in-process-queue
 *
 * Task #238 (R5) — Unit coverage for the default in-process task queue.
 *
 * Asserts the contract the executor relies on:
 *   1. Every enqueued job's runner is invoked exactly once.
 *   2. `onSettled` fires once per job with the correct fulfilled/rejected
 *      outcome (Promise.allSettled semantics: one rejected runner never
 *      rejects `dispatchLayer`).
 *   3. `dispatchLayer` resolves only after all jobs settle.
 *   4. An empty job list is a no-op.
 */

import { describe, it, expect } from 'vitest';
import { InProcessTaskQueue } from '../in-process-queue.js';
import type { NodeJob, NodeRunOutcome } from '../task-queue.js';
import type { WorkerResult } from '../../worker.js';

function makeResult(nodeId: string, output: string): WorkerResult {
  return {
    nodeId,
    output,
    durationMs: 1,
    toolCallCount: 0,
    findings: [],
    outputPaths: [],
  };
}

function job(nodeId: string): NodeJob {
  return { workflowId: 'wf', nodeId, layerIndex: 0 };
}

describe('InProcessTaskQueue', () => {
  it('reports the in-process backend', () => {
    expect(new InProcessTaskQueue().backend).toBe('in-process');
  });

  it('runs every job once and settles each as fulfilled', async () => {
    const queue = new InProcessTaskQueue();
    const ran: string[] = [];
    const settled = new Map<string, NodeRunOutcome>();

    await queue.dispatchLayer(
      [job('a'), job('b'), job('c')],
      async (j) => {
        ran.push(j.nodeId);
        return makeResult(j.nodeId, `out-${j.nodeId}`);
      },
      (j, outcome) => {
        settled.set(j.nodeId, outcome);
      },
    );

    expect(ran.sort()).toEqual(['a', 'b', 'c']);
    expect(settled.size).toBe(3);
    for (const id of ['a', 'b', 'c']) {
      const outcome = settled.get(id)!;
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status === 'fulfilled') {
        expect(outcome.value.output).toBe(`out-${id}`);
      }
    }
  });

  it('captures a rejected runner without rejecting dispatchLayer', async () => {
    const queue = new InProcessTaskQueue();
    const settled = new Map<string, NodeRunOutcome>();

    await expect(
      queue.dispatchLayer(
        [job('ok'), job('boom')],
        async (j) => {
          if (j.nodeId === 'boom') throw new Error('kaboom');
          return makeResult(j.nodeId, 'fine');
        },
        (j, outcome) => {
          settled.set(j.nodeId, outcome);
        },
      ),
    ).resolves.toBeUndefined();

    expect(settled.get('ok')?.status).toBe('fulfilled');
    const bad = settled.get('boom')!;
    expect(bad.status).toBe('rejected');
    if (bad.status === 'rejected') {
      expect((bad.reason as Error).message).toBe('kaboom');
    }
  });

  it('resolves only after all jobs settle', async () => {
    const queue = new InProcessTaskQueue();
    let completed = 0;

    await queue.dispatchLayer(
      [job('slow'), job('fast')],
      async (j) => {
        await new Promise((r) => setTimeout(r, j.nodeId === 'slow' ? 25 : 1));
        return makeResult(j.nodeId, j.nodeId);
      },
      () => {
        completed++;
      },
    );

    // If dispatchLayer awaited all jobs, both onSettled calls already ran.
    expect(completed).toBe(2);
  });

  it('is a no-op for an empty job list', async () => {
    const queue = new InProcessTaskQueue();
    let called = false;
    await queue.dispatchLayer([], async () => makeResult('x', 'x'), () => {
      called = true;
    });
    expect(called).toBe(false);
  });
});
