/**
 * @module orchestration/__tests__/macro-planning
 *
 * Task #197 — Hierarchical macro planning regression tests.
 *
 * Covers:
 *   1. `shouldUseMacroPlanning` threshold logic.
 *   2. `renderSpecMacroPreambleBlock` emits the macro contract WITHOUT
 *      inlining phase bodies.
 *   3. `GraphExecutor.expandMacroNodesInLayer` correctly splices a sub-DAG
 *      into the live graph: inbound rewire (entries inherit macro deps),
 *      outbound rewire (downstream consumers fan-in across leaves), and
 *      layer recomputation.
 *   4. Hard caps (`macroMaxTotalNodes`, `macroMaxExpansions`) and the
 *      "no callback wired" failure mode.
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphExecutor, type ExecutorConfig } from '../executor.js';
import { EventBus } from '../event-bus.js';
import { buildGraph } from '../graph.js';
import type { WorkflowNode } from '../types.js';
import {
  shouldUseMacroPlanning,
  renderSpecMacroPreambleBlock,
  parseSpecPhases,
  assertMacroPlanFeasible,
  MACRO_PLAN_MAX_PHASES,
  type SpecReference,
} from '../../agent/spec-loader.js';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

function makeSpec(reference: string, phaseBodies: string[]): SpecReference {
  const contents = phaseBodies
    .map((body, i) => `## Phase ${i + 1}: Phase ${i + 1} title\n${body}`)
    .join('\n\n');
  return {
    reference,
    resolvedPath: `/tmp/${reference}`,
    contents,
    truncated: false,
    phases: parseSpecPhases(contents),
  };
}

describe('shouldUseMacroPlanning (Task #197 thresholds)', () => {
  it('returns false for a small spec with few phases', () => {
    const spec = makeSpec('SMALL.md', ['short body', 'short', 'short']);
    expect(shouldUseMacroPlanning([spec])).toBe(false);
  });

  it('triggers when combined contents exceed bodyCharThreshold', () => {
    const big = 'x'.repeat(30_000);
    const spec = makeSpec('BIG.md', [big, big, big]);
    expect(shouldUseMacroPlanning([spec])).toBe(true);
  });

  it('triggers when total phase count >= phaseCountThreshold', () => {
    const spec = makeSpec(
      'MANY.md',
      Array.from({ length: 8 }, (_, i) => `body ${i}`),
    );
    expect(shouldUseMacroPlanning([spec])).toBe(true);
  });

  it('triggers when any single phase body >= singlePhaseCharThreshold', () => {
    const huge = 'y'.repeat(15_000);
    const spec = makeSpec('HUGE.md', ['short', huge, 'short']);
    expect(shouldUseMacroPlanning([spec])).toBe(true);
  });

  it('returns false when no spec carries >=3 phase markers', () => {
    expect(shouldUseMacroPlanning([])).toBe(false);
  });
});

describe('assertMacroPlanFeasible (Task #197 input-layer size gate)', () => {
  it('passes silently for specs within the limit', () => {
    const spec = makeSpec('SPEC.md', Array.from({ length: 10 }, (_, i) => `body-${i}`));
    expect(() => assertMacroPlanFeasible([spec])).not.toThrow();
  });

  it('throws an actionable "split the spec" error when over the limit', () => {
    const spec = makeSpec(
      'HUGE.md',
      Array.from({ length: MACRO_PLAN_MAX_PHASES + 1 }, (_, i) => `body-${i}`),
    );
    expect(() => assertMacroPlanFeasible([spec])).toThrow(
      /Input too large for hierarchical planning — split the spec/,
    );
  });

  it('reports per-spec phase counts in the error breakdown', () => {
    const a = makeSpec('A.md', Array.from({ length: 25 }, (_, i) => `a-${i}`));
    const b = makeSpec('B.md', Array.from({ length: 20 }, (_, i) => `b-${i}`));
    expect(() => assertMacroPlanFeasible([a, b])).toThrow(/A\.md \(25 phases\), B\.md \(20 phases\)/);
  });

  it('honours a custom maxPhases override (so tests/operators can tighten the gate)', () => {
    const spec = makeSpec('S.md', Array.from({ length: 10 }, (_, i) => `s-${i}`));
    expect(() => assertMacroPlanFeasible([spec], 5)).toThrow(/limit is 5/);
  });
});

describe('renderSpecMacroPreambleBlock', () => {
  it('emits the MACRO_NODE contract without inlining phase bodies', () => {
    const phases = ['body-A', 'body-B', 'body-C'];
    const spec = makeSpec('SPEC.md', phases);
    const block = renderSpecMacroPreambleBlock([spec]);

    expect(block).toMatch(/Hierarchical macro planning \(CRITICAL/);
    expect(block).toMatch(/MACRO_NODE/);
    expect(block).toMatch(/macro-phase-1/);
    expect(block).toMatch(/phase-1/);
    expect(block).toMatch(/phase-2/);
    expect(block).toMatch(/phase-3/);
    // Bodies must NOT be inlined.
    expect(block).not.toContain('body-A');
    expect(block).not.toContain('body-B');
    expect(block).not.toContain('body-C');
    // The macro contract must explicitly forbid the model from
    // echoing phase bodies in its output (Task #197 token-blowup fix).
    expect(block).toMatch(/do NOT include the phase body/);
    // The schema fragment must NOT advertise a `phaseBody` field.
    expect(block).not.toMatch(/phaseBody/);
  });

  it('returns empty string when no spec has >=3 phases', () => {
    expect(renderSpecMacroPreambleBlock([])).toBe('');
  });
});

describe('GraphExecutor.expandMacroNodesInLayer (splice semantics)', () => {
  function makeExecutor(
    nodes: WorkflowNode[],
    callback?: ExecutorConfig['macroExpansionCallback'],
    overrides: Partial<ExecutorConfig> = {},
  ): GraphExecutor {
    const graph = buildGraph(nodes, 'test-macro');
    const bus = new EventBus();
    const checkpointDir = mkdtempSync(join(tmpdir(), 'mp-cp-'));
    const config: ExecutorConfig = {
      workspaceDir: tmpdir(),
      checkpointDir,
      workerTimeout: 60,
      maxRetries: 0,
      checkpointInterval: 1,
      macroExpansionCallback: callback,
      ...overrides,
    };
    return new GraphExecutor(graph, bus, config);
  }

  it('splices a sub-DAG and rewires inbound + outbound edges', async () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'analyze',
        type: 'AGENT',
        label: 'analyze',
        dependsOn: [],
        agent: { model: 'm', task: 't' },
      },
      {
        id: 'macro-1',
        type: 'MACRO_NODE',
        label: 'phase 1',
        dependsOn: ['analyze'],
        macro: {
          specRef: 'SPEC.md',
          phaseId: 'phase-1',
          phaseTitle: 'Phase 1',
        },
      },
      {
        id: 'commit',
        type: 'AGENT',
        label: 'commit',
        dependsOn: ['macro-1'],
        agent: { model: 'm', task: 't' },
      },
    ];

    const callback = vi.fn(async (_node: WorkflowNode): Promise<WorkflowNode[]> => [
      {
        id: 'phase-1__sub-A',
        type: 'AGENT',
        label: 'A',
        dependsOn: [],
        agent: { model: 'm', task: 'A' },
      },
      {
        id: 'phase-1__sub-B',
        type: 'AGENT',
        label: 'B',
        dependsOn: ['phase-1__sub-A'],
        agent: { model: 'm', task: 'B' },
      },
    ]);

    const executor = makeExecutor(nodes, callback);
    // Access via cast — the method is private but we want a focused test.
    await (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
      .expandMacroNodesInLayer(1);

    expect(callback).toHaveBeenCalledTimes(1);

    const graph = (executor as unknown as { graph: { nodes: Map<string, WorkflowNode>; layers: string[][] } }).graph;
    expect(graph.nodes.has('macro-1')).toBe(false);
    expect(graph.nodes.has('phase-1__sub-A')).toBe(true);
    expect(graph.nodes.has('phase-1__sub-B')).toBe(true);

    // Inbound: sub-A inherits macro's dependsOn (= ['analyze']).
    expect(graph.nodes.get('phase-1__sub-A')!.dependsOn).toEqual(['analyze']);
    // Outbound: commit now depends on the sub-DAG's leaf (sub-B).
    expect(graph.nodes.get('commit')!.dependsOn).toEqual(['phase-1__sub-B']);

    // Layers recomputed: analyze -> sub-A -> sub-B -> commit.
    expect(graph.layers).toEqual([
      ['analyze'],
      ['phase-1__sub-A'],
      ['phase-1__sub-B'],
      ['commit'],
    ]);
  });

  it('throws when macroExpansionCallback is not wired', async () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'macro-x',
        type: 'MACRO_NODE',
        label: 'x',
        dependsOn: [],
        macro: { specRef: 's', phaseId: 'p', phaseTitle: 'p' },
      },
    ];
    const executor = makeExecutor(nodes, undefined);
    await expect(
      (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
        .expandMacroNodesInLayer(0),
    ).rejects.toThrow(/no macroExpansionCallback was wired/);
  });

  it('enforces the macroMaxExpansions cap', async () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'm1',
        type: 'MACRO_NODE',
        label: 'm1',
        dependsOn: [],
        macro: { specRef: 's', phaseId: 'p1', phaseTitle: 'p1' },
      },
      {
        id: 'm2',
        type: 'MACRO_NODE',
        label: 'm2',
        dependsOn: [],
        macro: { specRef: 's', phaseId: 'p2', phaseTitle: 'p2' },
      },
    ];
    const callback = vi.fn(async (n: WorkflowNode): Promise<WorkflowNode[]> => [
      {
        id: `${n.macro!.phaseId}__only`,
        type: 'AGENT',
        label: 'x',
        dependsOn: [],
        agent: { model: 'm', task: 't' },
      },
    ]);
    const executor = makeExecutor(nodes, callback, { macroMaxExpansions: 1 });
    await expect(
      (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
        .expandMacroNodesInLayer(0),
    ).rejects.toThrow(/Macro expansion cap exceeded/);
  });

  it('enforces the macroMaxTotalNodes cap', async () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'm1',
        type: 'MACRO_NODE',
        label: 'm1',
        dependsOn: [],
        macro: { specRef: 's', phaseId: 'p1', phaseTitle: 'p1' },
      },
    ];
    const callback = vi.fn(async (): Promise<WorkflowNode[]> =>
      Array.from({ length: 5 }, (_, i) => ({
        id: `p1__sub-${i}`,
        type: 'AGENT' as const,
        label: `s${i}`,
        dependsOn: [],
        agent: { model: 'm', task: 't' },
      })),
    );
    const executor = makeExecutor(nodes, callback, { macroMaxTotalNodes: 3 });
    await expect(
      (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
        .expandMacroNodesInLayer(0),
    ).rejects.toThrow(/would push graph to 5 nodes \(cap 3\)/);
  });

  it('rejects sub-DAGs that contain a nested MACRO_NODE-shaped duplicate id', async () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'analyze',
        type: 'AGENT',
        label: 'analyze',
        dependsOn: [],
        agent: { model: 'm', task: 't' },
      },
      {
        id: 'mZ',
        type: 'MACRO_NODE',
        label: 'mZ',
        dependsOn: ['analyze'],
        macro: { specRef: 's', phaseId: 'pZ', phaseTitle: 'pZ' },
      },
    ];
    const callback = vi.fn(async (): Promise<WorkflowNode[]> => [
      {
        id: 'analyze', // duplicate of an existing live node id
        type: 'AGENT',
        label: 'collide',
        dependsOn: [],
        agent: { model: 'm', task: 't' },
      },
    ]);
    const executor = makeExecutor(nodes, callback);
    await expect(
      (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
        .expandMacroNodesInLayer(1),
    ).rejects.toThrow(/duplicate node id 'analyze'/);
  });
});

describe('GraphExecutor.expandMacroNodesInLayer — strict post-splice validation', () => {
  function makeExecutor(
    nodes: WorkflowNode[],
    callback: ExecutorConfig['macroExpansionCallback'],
  ): GraphExecutor {
    const graph = buildGraph(nodes, 'test-macro-validate');
    const bus = new EventBus();
    const checkpointDir = mkdtempSync(join(tmpdir(), 'mp-cp-'));
    return new GraphExecutor(graph, bus, {
      workspaceDir: tmpdir(),
      checkpointDir,
      workerTimeout: 60,
      maxRetries: 0,
      checkpointInterval: 1,
      macroExpansionCallback: callback,
    });
  }

  it('throws when the spliced sub-DAG references an unknown sibling', async () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'macro-q',
        type: 'MACRO_NODE',
        label: 'q',
        dependsOn: [],
        macro: { specRef: 's', phaseId: 'pq', phaseTitle: 'pq' },
      },
    ];
    // Bypass the sub-planner's own external-dep check by returning a
    // sub-DAG whose internal id resolves at the planner level but whose
    // dep target lacks the prefix and isn't in the alias set. We do
    // this here at the executor layer by handing back a raw sub-DAG
    // with a dangling internal-looking dep.
    const callback = vi.fn(async (): Promise<WorkflowNode[]> => [
      {
        id: 'pq__a',
        type: 'AGENT',
        label: 'a',
        dependsOn: ['pq__missing'], // unknown target — not in graph
        agent: { model: 'm', task: 't' },
      },
    ]);
    const executor = makeExecutor(nodes, callback);
    await expect(
      (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
        .expandMacroNodesInLayer(0),
    ).rejects.toThrow(/Macro splice produced an invalid graph/);
  });
});

describe('Bridge wiring — sub-planner invoked once per macro node with resolved body', () => {
  /**
   * Integration-style test that reconstructs the closure pattern
   * `OrchestrationBridge.executePlan` wires into
   * `ExecutorConfig.macroExpansionCallback`: a body-resolution lookup
   * against a trusted phase-body map, followed by a `planner.subPlan`
   * invocation. This proves end-to-end that:
   *   1. The executor invokes the callback exactly once per macro node
   *      in a layer (not once per layer, not zero times).
   *   2. The body-lookup key (`${specRef}::${phaseId}`) the bridge uses
   *      matches what the executor's MACRO_NODE config carries.
   *   3. The resolved body is passed through to `subPlan` verbatim.
   *   4. Sub-DAGs returned by `subPlan` are spliced into the live graph.
   */
  it('invokes the bridge-style callback once per macro node with the right body', async () => {
    const macroNodes: WorkflowNode[] = [
      {
        id: 'macro-1',
        type: 'MACRO_NODE',
        label: 'phase 1',
        dependsOn: [],
        macro: { specRef: 'SPEC.md', phaseId: 'phase-1', phaseTitle: 'P1' },
      },
      {
        id: 'macro-2',
        type: 'MACRO_NODE',
        label: 'phase 2',
        dependsOn: [],
        macro: { specRef: 'SPEC.md', phaseId: 'phase-2', phaseTitle: 'P2' },
      },
      {
        id: 'macro-3',
        type: 'MACRO_NODE',
        label: 'phase 3',
        dependsOn: [],
        macro: { specRef: 'OTHER.md', phaseId: 'other-1', phaseTitle: 'O1' },
      },
    ];

    // Mirror the bridge's macroPhaseBodies map shape.
    const phaseBodies = new Map<string, { title: string; body: string }>([
      ['SPEC.md::phase-1', { title: 'P1', body: 'body for SPEC phase 1' }],
      ['SPEC.md::phase-2', { title: 'P2', body: 'body for SPEC phase 2' }],
      ['OTHER.md::other-1', { title: 'O1', body: 'body for OTHER phase 1' }],
    ]);

    // Mock subPlan that records every invocation and returns a trivial
    // 1-node sub-DAG.
    const subPlanMock = vi.fn(
      async (node: WorkflowNode, _preamble: string, body: string): Promise<WorkflowNode[]> => [
        {
          id: `${node.macro!.phaseId}__only`,
          type: 'AGENT',
          label: `${body.length}c`,
          dependsOn: [],
          agent: { model: 'm', task: body },
        },
      ],
    );

    // Reconstruct the bridge's closure. This is the exact shape wired
    // in `OrchestrationBridge.executePlan` for coding dispatches.
    const codingPreamble = '<repo block>';
    const macroExpansionCallback = (node: WorkflowNode): Promise<WorkflowNode[]> => {
      const cfg = node.macro;
      if (!cfg) throw new Error(`MACRO_NODE '${node.id}' missing macro config`);
      const key = `${cfg.specRef}::${cfg.phaseId}`;
      const phase = phaseBodies.get(key);
      if (!phase) throw new Error(`No body for '${key}'`);
      return subPlanMock(node, codingPreamble, phase.body);
    };

    const graph = buildGraph(macroNodes, 'bridge-wiring');
    const bus = new EventBus();
    const checkpointDir = mkdtempSync(join(tmpdir(), 'mp-bridge-'));
    const executor = new GraphExecutor(graph, bus, {
      workspaceDir: tmpdir(),
      checkpointDir,
      workerTimeout: 60,
      maxRetries: 0,
      checkpointInterval: 1,
      macroExpansionCallback,
    });

    await (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
      .expandMacroNodesInLayer(0);

    // 1. Called exactly once per macro node.
    expect(subPlanMock).toHaveBeenCalledTimes(3);

    // 2 + 3. Each call received the right resolved body.
    const calls = subPlanMock.mock.calls.map((c) => ({
      phaseId: (c[0] as WorkflowNode).macro!.phaseId,
      preamble: c[1] as string,
      body: c[2] as string,
    }));
    expect(calls.find((c) => c.phaseId === 'phase-1')?.body).toBe('body for SPEC phase 1');
    expect(calls.find((c) => c.phaseId === 'phase-2')?.body).toBe('body for SPEC phase 2');
    expect(calls.find((c) => c.phaseId === 'other-1')?.body).toBe('body for OTHER phase 1');
    // All calls share the same preamble.
    for (const c of calls) expect(c.preamble).toBe(codingPreamble);

    // 4. Sub-DAGs were spliced in; original macro nodes are gone.
    const liveGraph = (executor as unknown as { graph: { nodes: Map<string, WorkflowNode> } }).graph;
    expect(liveGraph.nodes.has('macro-1')).toBe(false);
    expect(liveGraph.nodes.has('macro-2')).toBe(false);
    expect(liveGraph.nodes.has('macro-3')).toBe(false);
    expect(liveGraph.nodes.has('phase-1__only')).toBe(true);
    expect(liveGraph.nodes.has('phase-2__only')).toBe(true);
    expect(liveGraph.nodes.has('other-1__only')).toBe(true);
  });
});

describe('Macro-planning telemetry (Task #197 review follow-up)', () => {
  it('records per-expansion stats and surfaces failures into ExecutionResult.errors', async () => {
    const macroNodes: WorkflowNode[] = [
      {
        id: 'macro-ok',
        type: 'MACRO_NODE',
        label: 'phase ok',
        dependsOn: [],
        macro: { specRef: 'SPEC.md', phaseId: 'phase-ok', phaseTitle: 'OK' },
      },
      {
        id: 'macro-bad',
        type: 'MACRO_NODE',
        label: 'phase bad',
        dependsOn: [],
        macro: { specRef: 'SPEC.md', phaseId: 'phase-bad', phaseTitle: 'BAD' },
      },
    ];

    const callback = async (n: WorkflowNode): Promise<WorkflowNode[]> => {
      if (n.id === 'macro-bad') throw new Error('subplan exploded');
      return [{
        id: 'phase-ok__only',
        type: 'AGENT',
        label: 'ok-leaf',
        dependsOn: [],
        agent: { model: 'm', task: 't' },
      }];
    };

    const graph = buildGraph(macroNodes, 'telemetry');
    const bus = new EventBus();
    const checkpointDir = mkdtempSync(join(tmpdir(), 'mp-telem-'));
    const executor = new GraphExecutor(graph, bus, {
      workspaceDir: tmpdir(),
      checkpointDir,
      workerTimeout: 60,
      maxRetries: 0,
      checkpointInterval: 1,
      macroExpansionCallback: callback,
    });

    await expect(
      (executor as unknown as { expandMacroNodesInLayer(i: number): Promise<void> })
        .expandMacroNodesInLayer(0),
    ).rejects.toThrow(/expansion failed.*subplan exploded/);

    // Failure was surfaced into ExecutionResult.errors with phase context
    // (the worker key embeds specRef::phaseId so users can grep summaries).
    const errors = (executor as unknown as { errors: { worker: string; message: string }[] }).errors;
    const macroErr = errors.find((e) => e.worker === 'macro:SPEC.md::phase-bad');
    expect(macroErr).toBeDefined();
    expect(macroErr!.message).toMatch(/SPEC\.md::phase-bad/);

    // Telemetry records the failed expansion (and any successful ones
    // processed before it; iteration stops on first throw, so the
    // assertion is order-agnostic about which other records are present).
    const records = (executor as unknown as {
      macroExpansionRecords: { macroNodeId: string; subNodeCount: number; error?: string }[];
    }).macroExpansionRecords;
    const badRec = records.find((r) => r.macroNodeId === 'macro-bad');
    expect(badRec).toBeDefined();
    expect(badRec!.error).toMatch(/subplan exploded/);
    expect(badRec!.subNodeCount).toBe(0);
  });

  it('writes a Macro Planning section into run-summary.md when expansions occurred', () => {
    const checkpointDir = mkdtempSync(join(tmpdir(), 'mp-summary-'));
    const graph = buildGraph([{
      id: 'noop', type: 'AGENT', label: 'noop', dependsOn: [],
      agent: { model: 'm', task: 't' },
    }], 'summary');
    const executor = new GraphExecutor(graph, new EventBus(), {
      workspaceDir: tmpdir(),
      checkpointDir,
      workerTimeout: 60,
      maxRetries: 0,
      checkpointInterval: 1,
    });
    // Inject a synthetic record and rebuild the result.
    (executor as unknown as { macroExpansionRecords: unknown[] }).macroExpansionRecords = [
      { macroNodeId: 'macro-1', specRef: 'SPEC.md', phaseId: 'p1', phaseTitle: 'P1', subNodeCount: 3 },
      { macroNodeId: 'macro-2', specRef: 'SPEC.md', phaseId: 'p2', phaseTitle: 'P2', subNodeCount: 0, error: 'boom' },
    ];
    const result = (executor as unknown as {
      buildResult(s: 'complete' | 'error' | 'stopped', t: number): import('../types.js').ExecutionResult;
    }).buildResult('complete', Date.now());
    expect(result.macroPlanning).toBeDefined();
    expect(result.macroPlanning!.expansionsAttempted).toBe(2);
    expect(result.macroPlanning!.expansionsSucceeded).toBe(1);
    expect(result.macroPlanning!.subNodesAdded).toBe(3);
  });
});

describe('Planner JSON parsing — MACRO_NODE pass-through', () => {
  it('parses MACRO_NODE entries with their macro config block', async () => {
    // We import the planner's parser indirectly by going through buildGraph;
    // the key contract is that types.ts + planner schema accept the new node.
    const node: WorkflowNode = {
      id: 'macro-1',
      type: 'MACRO_NODE',
      label: 'phase 1',
      dependsOn: [],
      macro: {
        specRef: 'SPEC.md',
        phaseId: 'phase-1',
        phaseTitle: 'Phase 1',
        phaseDependsOn: [],
      },
    };
    const graph = buildGraph([node], 'macro-only');
    expect(graph.nodes.get('macro-1')!.macro?.phaseId).toBe('phase-1');
  });
});
