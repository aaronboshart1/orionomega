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
