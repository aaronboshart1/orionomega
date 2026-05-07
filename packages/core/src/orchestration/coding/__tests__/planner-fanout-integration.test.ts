/**
 * @module orchestration/coding/__tests__/planner-fanout-integration
 *
 * Task #174 — Orchestration-level regression test.
 *
 * Drives a real {@link CodingPlanner} (with the full DAG-template
 * loader, model resolver, budget allocator) through the production
 * `materializeFanOut` path with a stubbed architect
 * {@link FanOutDecision} mirroring the synthetic 6-phase spec used in
 * the planner-side regression test
 * (`agent/__tests__/spec-multiphase-fanout.test.ts`). Asserts:
 *
 *   - The planner emits the `feature-implementation` template with an
 *     `impl-placeholder` (`fanOutPending` true).
 *   - After `materializeFanOut`, ≥6 concrete `impl-chunk-<id>` nodes
 *     exist and the placeholder is gone.
 *   - Inter-phase `dependsOn` edges are wired (Phase 4 → Phase 3,
 *     Phase 6 → Phase 4 per the spec).
 *   - Independent phases (1, 2, 3, 5) remain parallel siblings (their
 *     only upstream is the architect node `architecture-design`).
 *   - The complexity report is computed, no re-plan needed when all
 *     chunks are `low`/`medium`, and `requiresReplan` flips on when
 *     any chunk is `high`.
 *   - Successor stitcher node fans-in to all chunk nodes.
 */

import { describe, it, expect, vi } from 'vitest';
import { CodingPlanner } from '../coding-planner.js';
import type { CodingModeConfig, FanOutDecision, CodebaseScanOutput } from '../coding-types.js';

function stubConfig(): CodingModeConfig {
  return {
    enabled: true,
    cwd: '/tmp/repo',
    repoDir: '/tmp/repo',
    templates: {
      'feature-implementation': true,
      'bug-fix': true,
      'refactor': true,
      'test-suite': true,
      'review-iterate': true,
    },
    validation: { autoRun: false, commands: [] },
    budgets: { defaultPerNodeUsd: 0.5, totalUsd: 5.0 },
    models: {
      'codebase-scanner': 'claude-haiku-4',
      'architect': 'claude-sonnet-4',
      'implementer': 'claude-sonnet-4',
      'stitcher': 'claude-sonnet-4',
      'test-writer': 'claude-sonnet-4',
      'validator': 'claude-haiku-4',
      'reviewer': 'claude-sonnet-4',
      'reporter': 'claude-haiku-4',
    },
  } as unknown as CodingModeConfig;
}

function stubProfile(): CodebaseScanOutput {
  return {
    language: 'typescript',
    framework: null,
    testFramework: 'vitest',
    buildSystem: 'pnpm',
    lintCommand: null,
    projectStructure: 'src/',
    relevantFiles: [
      { path: 'src/a.ts', role: 'source', complexity: 'medium', linesOfCode: 80 },
      { path: 'src/b.ts', role: 'source', complexity: 'medium', linesOfCode: 80 },
    ],
    entryPoints: ['src/a.ts'],
    dependencies: {},
  };
}

function sixPhaseDecision(): FanOutDecision {
  return {
    chunks: [
      { id: 'phase-1', label: 'Phase 1', fileCluster: ['src/a.ts'], sharedFiles: [], task: 'P1', estimatedComplexity: 'low' },
      { id: 'phase-2', label: 'Phase 2', fileCluster: ['src/b.ts'], sharedFiles: [], task: 'P2', estimatedComplexity: 'low' },
      { id: 'phase-3', label: 'Phase 3', fileCluster: ['src/c.ts'], sharedFiles: [], task: 'P3', estimatedComplexity: 'low' },
      { id: 'phase-4', label: 'Phase 4', fileCluster: ['src/d.ts'], sharedFiles: [], task: 'P4', estimatedComplexity: 'medium', dependsOn: ['phase-3'] },
      { id: 'phase-5', label: 'Phase 5', fileCluster: ['src/e.ts'], sharedFiles: [], task: 'P5', estimatedComplexity: 'low' },
      { id: 'phase-6', label: 'Phase 6', fileCluster: ['src/f.ts'], sharedFiles: [], task: 'P6', estimatedComplexity: 'medium', dependsOn: ['phase-4'] },
    ],
    maxParallelism: 6,
  };
}

describe('CodingPlanner.materializeFanOut (Task #174 production wire-up)', () => {
  it('expands the impl-placeholder into ≥6 concrete chunks for a 6-phase spec', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    expect(plan.fanOutPending).toBe(true);
    expect(plan.nodes.find((n) => n.id === 'impl-placeholder')).toBeDefined();

    const expanded = planner.materializeFanOut(plan, sixPhaseDecision());
    expect(expanded.fanOutPending).toBe(false);
    expect(expanded.nodes.find((n) => n.id === 'impl-placeholder')).toBeUndefined();

    for (let i = 1; i <= 6; i++) {
      expect(expanded.nodes.find((n) => n.id === `impl-chunk-phase-${i}`)).toBeDefined();
    }
  });

  it('wires inter-phase dependsOn edges (Phase 4 → 3, Phase 6 → 4)', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const expanded = planner.materializeFanOut(plan, sixPhaseDecision());

    const p4 = expanded.nodes.find((n) => n.id === 'impl-chunk-phase-4')!;
    expect(p4.dependsOn).toContain('impl-chunk-phase-3');
    expect(p4.dependsOn).toContain('architecture-design');

    const p6 = expanded.nodes.find((n) => n.id === 'impl-chunk-phase-6')!;
    expect(p6.dependsOn).toContain('impl-chunk-phase-4');
  });

  it('keeps independent phases as parallel siblings', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const expanded = planner.materializeFanOut(plan, sixPhaseDecision());

    for (const id of ['impl-chunk-phase-1', 'impl-chunk-phase-2', 'impl-chunk-phase-3', 'impl-chunk-phase-5']) {
      const node = expanded.nodes.find((n) => n.id === id)!;
      expect(node.dependsOn).toEqual(['architecture-design']);
    }
  });

  it('rewrites the stitcher node to fan-in across every chunk', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const expanded = planner.materializeFanOut(plan, sixPhaseDecision());

    const stitcher = expanded.nodes.find((n) => n.id === 'integration-stitch')!;
    expect(stitcher.dependsOn).not.toContain('impl-placeholder');
    for (let i = 1; i <= 6; i++) {
      expect(stitcher.dependsOn).toContain(`impl-chunk-phase-${i}`);
    }
  });

  it('reports complexity and does not request a re-plan when no chunk is high', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const expanded = planner.materializeFanOut(plan, sixPhaseDecision());

    expect(expanded.complexity.perChunk).toHaveLength(6);
    expect(expanded.complexity.highComplexityIds).toEqual([]);
    expect(expanded.complexity.requiresReplan).toBe(false);
  });

  it('runs the capped one-shot re-plan loop end-to-end via materializeFanOutWithReplan', async () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());

    const firstDecision: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'big', label: 'BIG', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 2,
    };
    const subdivided: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'big-1', label: 'BIG part 1', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'medium' },
        { id: 'big-2', label: 'BIG part 2', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'medium' },
      ],
      maxParallelism: 3,
    };

    const callback = vi.fn(async (
      _prev: FanOutDecision | null,
      replanInstruction: string | null,
    ): Promise<FanOutDecision> => {
      if (replanInstruction == null) return firstDecision;
      expect(replanInstruction).toMatch(/Subdivide/);
      return subdivided;
    });

    const result = await planner.materializeFanOutWithReplan(plan, callback);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(result.replanned).toBe(true);
    expect(result.finalDecision).toBe(subdivided);
    expect(result.plan.complexity.requiresReplan).toBe(false); // capped — alreadyReplanned
    expect(result.plan.nodes.find((n) => n.id === 'impl-chunk-big-1')).toBeDefined();
    expect(result.plan.nodes.find((n) => n.id === 'impl-chunk-big-2')).toBeDefined();
    expect(result.plan.nodes.find((n) => n.id === 'impl-chunk-big')).toBeUndefined();
  });

  it('does not invoke the callback twice when no chunk is high', async () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const callback = vi.fn(async () => sixPhaseDecision());
    const result = await planner.materializeFanOutWithReplan(plan, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(result.replanned).toBe(false);
  });

  it('caps the re-plan at one pass even if the architect returns another high chunk', async () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const stillHigh: FanOutDecision = {
      chunks: [
        { id: 'big', label: 'BIG', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 1,
    };
    const callback = vi.fn(async () => stillHigh);
    const result = await planner.materializeFanOutWithReplan(plan, callback);
    expect(callback).toHaveBeenCalledTimes(2); // initial + one re-plan
    expect(result.replanned).toBe(true);
    // Even though the second decision still has a high chunk, the
    // helper does NOT loop a third time — alreadyReplanned blocks it.
    expect(result.plan.complexity.requiresReplan).toBe(false);
  });

  it('flags requiresReplan when the architect emits a high-complexity chunk', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const decision: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'big', label: 'BIG', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 2,
    };
    const expanded = planner.materializeFanOut(plan, decision);
    expect(expanded.complexity.requiresReplan).toBe(true);
    expect(expanded.complexity.highComplexityIds).toEqual(['big']);
    expect(expanded.complexity.replanInstruction).toMatch(/Subdivide/);

    const replanned = planner.materializeFanOut(plan, decision, { alreadyReplanned: true });
    expect(replanned.complexity.requiresReplan).toBe(false);
    expect(replanned.complexity.replanInstruction).toBeNull();
  });

  it('refreshes per-chunk model assignments through buildModelAssignments', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const expanded = planner.materializeFanOut(plan, sixPhaseDecision());

    for (let i = 1; i <= 6; i++) {
      const id = `impl-chunk-phase-${i}`;
      expect(expanded.modelAssignments.get(id)).toBeDefined();
      expect(expanded.modelAssignments.get(id)!.model.length).toBeGreaterThan(0);
    }
  });
});
