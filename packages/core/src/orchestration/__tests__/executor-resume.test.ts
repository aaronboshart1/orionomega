/**
 * @module orchestration/__tests__/executor-resume
 *
 * Task #238 (R5) — Checkpoint-store-as-source-of-truth resume tests.
 *
 * These tests prove the distributed-queue invariants WITHOUT an external queue
 * or an Anthropic API key, by modelling each node as a real TOOL node whose
 * shell command appends a line to a per-node tally file. Counting lines tells us
 * exactly how many times a node ran across the original run + the resumed run.
 *
 * Covered:
 *   1. A run dispatches its layers through the (default) in-process task queue
 *      and completes end-to-end.
 *   2. After a simulated worker-process crash mid-run, a fresh executor built
 *      from the on-disk checkpoint resumes and finishes the remaining nodes.
 *   3. Nodes that already completed before the crash are NOT re-run on resume
 *      (their tally files still show exactly one execution).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GraphExecutor, type ExecutorConfig } from '../executor.js';
import { EventBus } from '../event-bus.js';
import { buildGraph } from '../graph.js';
import { CheckpointManager } from '../checkpoint.js';
import { WorkflowState } from '../state.js';
import type { WorkflowNode } from '../types.js';
import type { TaskQueue, NodeJob, NodeRunner, NodeSettledHandler } from '../queue/index.js';
import { InProcessTaskQueue } from '../queue/index.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Count how many times a node ran by counting lines in its tally file. */
function runCount(workspaceDir: string, nodeId: string): number {
  const file = join(workspaceDir, `${nodeId}.runs`);
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).length;
}

/** A TOOL node whose command records one execution to `<workspace>/<id>.runs`. */
function tallyNode(id: string, dependsOn: string[], workspaceDir: string): WorkflowNode {
  const file = join(workspaceDir, `${id}.runs`);
  return {
    id,
    type: 'TOOL',
    label: `Tally ${id}`,
    dependsOn,
    status: 'pending',
    tool: { name: 'bash', params: { command: `echo ran >> ${file}` } },
  };
}

describe('Executor resume — checkpoint as source of truth (Task #238)', () => {
  let workspaceDir: string;
  let runsDir: string;
  let checkpointDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'resume-ws-'));
    runsDir = mkdtempSync(join(tmpdir(), 'resume-runs-'));
    checkpointDir = mkdtempSync(join(tmpdir(), 'resume-cp-'));
  });

  afterEach(() => {
    for (const dir of [workspaceDir, runsDir, checkpointDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  const baseConfig = (): ExecutorConfig => ({
    workspaceDir,
    runsDir,
    checkpointDir,
    workerTimeout: 30,
    maxRetries: 0,
    checkpointInterval: 1,
  });

  it('dispatches layers through the in-process queue and completes', async () => {
    const nodes = [
      tallyNode('a', [], workspaceDir),
      tallyNode('b', ['a'], workspaceDir),
    ];
    const graph = buildGraph(nodes, 'resume-happy');
    const executor = new GraphExecutor(graph, new EventBus(), baseConfig());
    const result = await executor.execute();

    expect(result.status).toBe('complete');
    expect(runCount(workspaceDir, 'a')).toBe(1);
    expect(runCount(workspaceDir, 'b')).toBe(1);
  });

  it('resumes from checkpoint after a simulated crash without re-running completed nodes', async () => {
    // Graph: a (layer 0) → b (layer 1) → c (layer 2). We crash before layer 1
    // dispatches, so only `a` should have completed when the process "dies".
    const nodes = [
      tallyNode('a', [], workspaceDir),
      tallyNode('b', ['a'], workspaceDir),
      tallyNode('c', ['b'], workspaceDir),
    ];
    const graph = buildGraph(nodes, 'resume-crash');
    const workflowId = graph.id;

    // A queue that runs layer 0 for real (so `a` completes and is checkpointed
    // per-node), then snapshots the on-disk checkpoint and throws to simulate a
    // hard worker crash before layer 1 ever dispatches.
    const real = new InProcessTaskQueue();
    const cpFile = join(checkpointDir, `${workflowId}.checkpoint.json`);
    let snapshot: string | null = null;

    const crashingQueue: TaskQueue = {
      backend: 'in-process',
      async dispatchLayer(jobs: NodeJob[], runner: NodeRunner, onSettled: NodeSettledHandler) {
        if (jobs[0]?.layerIndex === 0) {
          await real.dispatchLayer(jobs, runner, onSettled);
          return;
        }
        // Layer 1: capture the checkpoint written after layer 0, then "crash".
        snapshot = readFileSync(cpFile, 'utf-8');
        throw new Error('SIMULATED_WORKER_CRASH');
      },
      async close() {
        /* no-op */
      },
    };

    const crashed = await new GraphExecutor(graph, new EventBus(), {
      ...baseConfig(),
      taskQueue: crashingQueue,
    }).execute();

    // The crash surfaced as an errored run, and only `a` ran.
    expect(crashed.status).toBe('error');
    expect(runCount(workspaceDir, 'a')).toBe(1);
    expect(runCount(workspaceDir, 'b')).toBe(0);
    expect(runCount(workspaceDir, 'c')).toBe(0);
    expect(snapshot).not.toBeNull();

    // The executor removes the checkpoint on its error exit (mimicking the real
    // teardown). Re-materialise the snapshot we captured at crash time — this is
    // exactly the durable state a killed process would have left on disk.
    const checkpoint = JSON.parse(snapshot!) as ReturnType<typeof JSON.parse> & {
      currentLayer: number;
      graph: { nodes: Record<string, WorkflowNode> };
    };
    expect(checkpoint.graph.nodes.a.status).toBe('done');
    expect(checkpoint.graph.nodes.b.status).toBe('pending');

    // ── Simulated process restart ──────────────────────────────────────────
    // Reconstruct the graph from the checkpoint and resume with a fresh,
    // default (in-process) executor — the real resume path the bridge uses.
    const resumedGraph = CheckpointManager.graphFromCheckpoint(checkpoint as never);
    let restoredState: WorkflowState | undefined;
    try {
      restoredState = await WorkflowState.restore(workflowId, checkpointDir);
    } catch {
      restoredState = undefined;
    }

    const resumed = await new GraphExecutor(
      resumedGraph,
      new EventBus(),
      baseConfig(),
      restoredState,
    ).execute(checkpoint.currentLayer);

    expect(resumed.status).toBe('complete');

    // The whole point: `a` was already done, so it must NOT run again.
    expect(runCount(workspaceDir, 'a')).toBe(1);
    // `b` and `c` were never run before the crash, so the resume completes them.
    expect(runCount(workspaceDir, 'b')).toBe(1);
    expect(runCount(workspaceDir, 'c')).toBe(1);

    // The resumed graph reflects all nodes done.
    expect(resumedGraph.nodes.get('a')?.status).toBe('done');
    expect(resumedGraph.nodes.get('b')?.status).toBe('done');
    expect(resumedGraph.nodes.get('c')?.status).toBe('done');
  });
});
