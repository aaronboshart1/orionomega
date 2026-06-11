/**
 * @module orchestration/__tests__/executor-model-fallback
 *
 * Task #230 — proves the executor:
 *   1. treats a "model unavailable / forbidden / not entitled" failure as
 *      PERMANENT (the gated model is dispatched exactly ONCE, never retried
 *      with backoff, even when maxRetries is high), and
 *   2. gracefully degrades to the next-best available tier from the model
 *      registry (Fable 5 / mythos → Opus 4.8) and re-dispatches, recording
 *      the requested→fallback decision in `modelFallbacks`.
 *
 * We mock `WorkerProcess` (AGENT path) so it throws an unavailable-model error
 * for any model in `unavailable`, and succeeds otherwise — counting dispatches
 * per model.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dispatches: string[] = [];
const unavailable = new Set<string>();

vi.mock('../worker.js', () => ({
  WorkerProcess: class {
    private node: { id: string; agent?: { model?: string } };
    constructor(node: { id: string; agent?: { model?: string } }) {
      this.node = node;
    }
    async run() {
      const model = this.node.agent?.model ?? '(none)';
      dispatches.push(model);
      if (unavailable.has(model)) {
        throw new Error(`Your account does not have access to the model ${model}`);
      }
      return {
        nodeId: this.node.id,
        output: `ran ${model}`,
        durationMs: 1,
        toolCallCount: 0,
        findings: [],
        outputPaths: [],
      };
    }
  },
}));

const { GraphExecutor } = await import('../executor.js');
const { EventBus } = await import('../event-bus.js');
const { resetModelRegistry } = await import('../../models/model-registry.js');

let workspaceDir: string;
beforeEach(() => {
  resetModelRegistry();
  dispatches.length = 0;
  unavailable.clear();
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-model-fb-'));
});

function makeExecutor(model: string, maxRetries: number) {
  const node = {
    id: 'a1',
    type: 'AGENT' as const,
    label: 'analyse',
    dependsOn: [] as string[],
    agent: { task: 'do the thing', model },
    status: 'pending' as const,
  };
  const graph = {
    id: 'g1',
    name: 'fallback test',
    createdAt: new Date().toISOString(),
    nodes: new Map([['a1', node]]),
    dependencies: new Map(),
    entryNodes: ['a1'],
    terminalNodes: ['a1'],
  };
  const exec = new GraphExecutor(
    graph as never,
    new EventBus(),
    {
      workspaceDir,
      checkpointDir: path.join(workspaceDir, 'checkpoints'),
      workerTimeout: 5,
      maxRetries,
      checkpointInterval: 1,
    } as never,
  );
  return { exec, graph };
}

type PrivExec = {
  executeNode: (id: string) => Promise<{ output?: unknown }>;
  modelFallbacks: Array<{
    nodeId: string;
    requestedModel: string;
    fallbackModel: string;
    requestedTier: string;
    fallbackTier: string;
    succeeded: boolean;
    reason: string;
  }>;
};

describe('Task #230 — executor model-unavailable classification + graceful degradation', () => {
  it('does NOT retry a gated model (dispatched once) and degrades to opus-4-8', async () => {
    unavailable.add('claude-fable-5');
    const { exec } = makeExecutor('claude-fable-5', /* maxRetries */ 5);
    const result = await (exec as unknown as PrivExec).executeNode('a1');

    // Non-retried: the gated model was attempted exactly once despite maxRetries=5.
    const fableCalls = dispatches.filter((m) => m === 'claude-fable-5').length;
    expect(fableCalls).toBe(1);

    // Degraded to the next-best available tier and succeeded.
    expect(dispatches).toContain('claude-opus-4-8');
    expect(result.output).toBe('ran claude-opus-4-8');

    const fbs = (exec as unknown as PrivExec).modelFallbacks;
    expect(fbs).toHaveLength(1);
    expect(fbs[0]).toMatchObject({
      nodeId: 'a1',
      requestedModel: 'claude-fable-5',
      requestedTier: 'mythos',
      fallbackModel: 'claude-opus-4-8',
      fallbackTier: 'opus',
      succeeded: true,
    });
    expect(fbs[0]!.reason).toMatch(/does not have access/i);
  });

  it('records the degradation in run-summary via buildResult.modelFallbacks', async () => {
    unavailable.add('claude-fable-5');
    const { exec } = makeExecutor('claude-fable-5', 0);
    await (exec as unknown as PrivExec).executeNode('a1');
    const built = (exec as unknown as { buildResult: (s: string, t: number) => { modelFallbacks?: unknown[] } })
      .buildResult('complete', Date.now());
    expect(built.modelFallbacks).toBeDefined();
    expect(built.modelFallbacks).toHaveLength(1);
  });

  it('walks a second model when the first substitute is also unavailable', async () => {
    unavailable.add('claude-fable-5');
    unavailable.add('claude-opus-4-8');
    const { exec } = makeExecutor('claude-fable-5', 1);
    // Fable → opus-4-8 (also gated here) → opus-4-6 (succeeds). Both opus
    // variants are strictly below the mythos tier, so the walk tries the newer
    // dated variant first, excludes it, then the older one.
    const result = await (exec as unknown as PrivExec).executeNode('a1');
    expect(result.output).toBe('ran claude-opus-4-6');

    const fbs = (exec as unknown as PrivExec).modelFallbacks;
    // Two recorded attempts: the failed opus-4-8 hop + the successful opus-4-6 hop.
    expect(fbs.length).toBe(2);
    expect(fbs[0]).toMatchObject({ fallbackModel: 'claude-opus-4-8', succeeded: false });
    expect(fbs[1]).toMatchObject({ fallbackModel: 'claude-opus-4-6', succeeded: true });
  });

  it('propagates the error when there is no lower tier to degrade to (haiku floor)', async () => {
    // A haiku request that is unavailable has no lower available tier → no
    // fallback is possible, so the original permanent error propagates.
    unavailable.add('claude-haiku-4-5');
    const { exec } = makeExecutor('claude-haiku-4-5', 3);
    await expect((exec as unknown as PrivExec).executeNode('a1')).rejects.toThrow(/does not have access/i);

    // Still only dispatched once — permanent, never retried with backoff.
    expect(dispatches.filter((m) => m === 'claude-haiku-4-5').length).toBe(1);
    expect((exec as unknown as PrivExec).modelFallbacks).toHaveLength(0);
  });

  it('leaves the normal (available-model) path untouched — no fallback recorded', async () => {
    const { exec } = makeExecutor('claude-opus-4-8', 2);
    const result = await (exec as unknown as PrivExec).executeNode('a1');
    expect(result.output).toBe('ran claude-opus-4-8');
    expect(dispatches).toEqual(['claude-opus-4-8']);
    expect((exec as unknown as PrivExec).modelFallbacks).toHaveLength(0);
  });
});
