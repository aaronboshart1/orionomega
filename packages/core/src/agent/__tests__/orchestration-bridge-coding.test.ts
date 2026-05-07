/**
 * @module agent/__tests__/orchestration-bridge-coding
 *
 * Targeted unit test for Task #172's run-folder-identity guarantee:
 * the planner's randomly-generated `plan.graph.id` must be overridden
 * by the caller's pre-minted workflowId when one is supplied to
 * `dispatchFullDAG`. Code mode passes its pre-clone runId here, so the
 * executor's run artifacts dir (`<workspaceDir>/output/<workflowId>`)
 * lands under the same folder as the pre-clone parent dir
 * (`<workspaceDir>/output/<runId>` containing the `<repoName>` checkout).
 *
 * We construct a minimal bridge with stubbed dependencies — the goal is
 * to exercise the workflowId-override branch in `dispatchFullDAG`
 * without spinning up the planner LLM or the GraphExecutor. The test
 * substitutes the bridge's planner with a stub that returns a plan with
 * a known random id, then asserts the override flips the id and that
 * downstream consumers (the confirm map) see the overridden id.
 */

import { describe, it, expect, vi } from 'vitest';
import { OrchestrationBridge } from '../orchestration-bridge.js';
import type { PlannerOutput } from '../../orchestration/types.js';

function fakePlan(id: string): PlannerOutput {
  return {
    summary: 'fake plan',
    reasoning: 'fake',
    graph: {
      id,
      name: 'fake',
      createdAt: new Date().toISOString(),
      // empty Map keeps `plan.graph.nodes.size === 0` so executePlan
      // would no-op even if it were called — but with
      // requireConfirmation:true it never gets there.
      nodes: new Map(),
      layers: [],
      entryNodes: [],
      exitNodes: [],
    },
    estimatedTime: 0,
    estimatedCost: 0,
  } as unknown as PlannerOutput;
}

describe('OrchestrationBridge.dispatchFullDAG: workflowId override', () => {
  it('overrides the planner-generated graph.id with the supplied workflowId', async () => {
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onPlan = vi.fn();
    const onDAGConfirm = vi.fn();

    const bridge = new OrchestrationBridge(
      {
        workspaceDir: '/tmp/ws',
        checkpointDir: '/tmp/cp',
        workerTimeout: 60,
        maxRetries: 0,
      },
      // Casting because the test only exercises a few callbacks. The
      // rest aren't reached on the requireConfirmation:true path.
      {
        onText,
        onThinking,
        onPlan,
        onDAGConfirm,
      } as unknown as ConstructorParameters<typeof OrchestrationBridge>[1],
      // Memory bridge stub: only `recallForPlanning` is exercised here.
      {
        recallForPlanning: async () => [],
      } as unknown as ConstructorParameters<typeof OrchestrationBridge>[2],
      [],
      'claude-sonnet-4-20250514',
    );

    // Replace the planner with a stub. The bridge stores it as a
    // private readonly field; we mutate it directly because there's no
    // cleaner injection point and adding one just for tests would be
    // over-engineering.
    const PRE_OVERRIDE_ID = 'planner-random-id-123';
    const PRE_MINTED_RUN_ID = 'my-pre-minted-run-id';
    (bridge as unknown as { planner: { plan: () => Promise<PlannerOutput> } }).planner = {
      plan: vi.fn(async () => fakePlan(PRE_OVERRIDE_ID)),
    };

    await bridge.dispatchFullDAG('test task', () => {}, {
      requireConfirmation: true,
      workflowId: PRE_MINTED_RUN_ID,
    });

    // The confirm event should carry the overridden id, NOT the
    // planner's random id. This is the externally observable proof
    // that `plan.graph.id` was rewritten before any downstream
    // consumer (confirm map, executor, run-dir) saw it.
    expect(onDAGConfirm).toHaveBeenCalledTimes(1);
    const confirmInfo = onDAGConfirm.mock.calls[0][0] as { workflowId: string };
    expect(confirmInfo.workflowId).toBe(PRE_MINTED_RUN_ID);
    expect(confirmInfo.workflowId).not.toBe(PRE_OVERRIDE_ID);
  });

  it('persists executorOverrides through confirmation and replays them on approval', async () => {
    const onDAGConfirm = vi.fn();
    const onText = vi.fn();
    const bridge = new OrchestrationBridge(
      { workspaceDir: '/tmp/ws', checkpointDir: '/tmp/cp', workerTimeout: 60, maxRetries: 0 },
      {
        onText, onThinking: vi.fn(), onPlan: vi.fn(), onDAGConfirm,
      } as unknown as ConstructorParameters<typeof OrchestrationBridge>[1],
      { recallForPlanning: async () => [] } as unknown as ConstructorParameters<typeof OrchestrationBridge>[2],
      [],
      'claude-sonnet-4-20250514',
    );
    (bridge as unknown as { planner: { plan: () => Promise<PlannerOutput> } }).planner = {
      plan: vi.fn(async () => fakePlan('graph-id-X')),
    };

    // Spy on dispatchAsync so we can assert what gets replayed on
    // approval. dispatchAsync is private; cast through unknown.
    const dispatchAsyncSpy = vi
      .spyOn(bridge as unknown as { dispatchAsync: (...args: unknown[]) => Promise<string> }, 'dispatchAsync')
      .mockResolvedValue('graph-id-X');

    const CHECKOUT = '/tmp/ws/output/run-Z/myrepo';
    await bridge.dispatchFullDAG('test', () => {}, {
      requireConfirmation: true,
      workflowId: 'run-Z',
      executorOverrides: { codingRepoDir: CHECKOUT },
    });

    // Confirmation path: dispatchAsync MUST NOT be called yet.
    expect(dispatchAsyncSpy).not.toHaveBeenCalled();
    expect(onDAGConfirm).toHaveBeenCalledTimes(1);

    // User approves.
    bridge.resolveConfirmation(true, 'run-Z');

    // dispatchAsync must be invoked with the captured overrides — proof
    // that `pendingConfirmations` carried them through the round-trip
    // and `resolveConfirmation` replayed them verbatim.
    expect(dispatchAsyncSpy).toHaveBeenCalledTimes(1);
    const replayedOverrides = dispatchAsyncSpy.mock.calls[0][2];
    expect(replayedOverrides).toEqual({ codingRepoDir: CHECKOUT });
  });

  it('leaves the planner id untouched when no workflowId override is supplied', async () => {
    const onDAGConfirm = vi.fn();
    const bridge = new OrchestrationBridge(
      { workspaceDir: '/tmp/ws', checkpointDir: '/tmp/cp', workerTimeout: 60, maxRetries: 0 },
      {
        onText: vi.fn(), onThinking: vi.fn(), onPlan: vi.fn(), onDAGConfirm,
      } as unknown as ConstructorParameters<typeof OrchestrationBridge>[1],
      { recallForPlanning: async () => [] } as unknown as ConstructorParameters<typeof OrchestrationBridge>[2],
      [],
      'claude-sonnet-4-20250514',
    );
    const PLANNER_ID = 'planner-only-id';
    (bridge as unknown as { planner: { plan: () => Promise<PlannerOutput> } }).planner = {
      plan: vi.fn(async () => fakePlan(PLANNER_ID)),
    };

    await bridge.dispatchFullDAG('test task', () => {}, { requireConfirmation: true });

    expect(onDAGConfirm).toHaveBeenCalledTimes(1);
    expect((onDAGConfirm.mock.calls[0][0] as { workflowId: string }).workflowId).toBe(PLANNER_ID);
  });
});
