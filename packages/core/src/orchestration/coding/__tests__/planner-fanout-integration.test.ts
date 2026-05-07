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

  it('materializeFanOutWithReplan is now a no-op replan path because deterministic subdivision handles high chunks (Task #178)', async () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());

    const firstDecision: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'big', label: 'BIG', fileCluster: ['x.ts', 'y.ts', 'z.ts'], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 2,
    };

    const callback = vi.fn(async () => firstDecision);
    const result = await planner.materializeFanOutWithReplan(plan, callback);
    // Task #178: deterministic subdivision now removes the `high` tag
    // before complexity analysis, so the LLM re-plan path is never
    // triggered and the callback is invoked exactly once.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(result.replanned).toBe(false);
    // The split sub-chunks landed in the dispatched DAG.
    expect(result.plan.nodes.find((n) => n.id === 'impl-chunk-big')).toBeUndefined();
    expect(result.plan.nodes.filter((n) => n.id.startsWith('impl-chunk-big-part')).length).toBeGreaterThanOrEqual(2);
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

  it('deterministic subdivision is capped at one pass via alreadyReplanned (Task #178)', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const stillHigh: FanOutDecision = {
      chunks: [
        { id: 'big', label: 'BIG', fileCluster: ['p.ts', 'q.ts'], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 1,
    };
    // alreadyReplanned skips deterministic subdivision so the high
    // chunk passes through verbatim (the cap-at-one-pass invariant).
    const capped = planner.materializeFanOut(plan, stillHigh, { alreadyReplanned: true });
    expect(capped.subdivision.splits).toEqual([]);
    expect(capped.nodes.find((n) => n.id === 'impl-chunk-big')).toBeDefined();
    expect(capped.complexity.requiresReplan).toBe(false);
  });

  it('deterministically subdivides a single high-complexity chunk into 2–4 sibling DAG nodes (Task #178)', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const decision: FanOutDecision = {
      chunks: [
        {
          id: 'big',
          label: 'BIG',
          fileCluster: ['src/x.ts', 'src/y.ts', 'src/z.ts'],
          sharedFiles: ['src/shared.ts'],
          task: 'do everything',
          estimatedComplexity: 'high',
        },
      ],
      maxParallelism: 1,
    };
    const expanded = planner.materializeFanOut(plan, decision);

    // Acceptance criterion: the original `big` chunk is gone, replaced
    // by 2–4 smaller siblings in the dispatched DAG.
    expect(expanded.nodes.find((n) => n.id === 'impl-chunk-big')).toBeUndefined();
    const siblings = expanded.nodes.filter((n) => n.id.startsWith('impl-chunk-big-part'));
    expect(siblings.length).toBeGreaterThanOrEqual(2);
    expect(siblings.length).toBeLessThanOrEqual(4);

    // Subdivision report records the split.
    expect(expanded.subdivision.splits).toEqual([
      { originalId: 'big', subIds: siblings.map((n) => n.id.replace(/^impl-chunk-/, '')) },
    ]);

    // Complexity analysis runs against the post-subdivision decision —
    // no high chunks remain, so no re-plan is requested.
    expect(expanded.complexity.highComplexityIds).toEqual([]);
    expect(expanded.complexity.requiresReplan).toBe(false);

    // Each sibling has its share of the file cluster and inherited the
    // shared files. The union of owned files across siblings equals
    // the original `fileCluster`.
    const allOwned = siblings.flatMap((n) => n.codingConfig?.fileScope?.owned ?? []);
    expect(new Set(allOwned)).toEqual(new Set(['src/x.ts', 'src/y.ts', 'src/z.ts']));
    for (const sibling of siblings) {
      expect(sibling.codingConfig?.fileScope?.readable).toEqual(['src/shared.ts']);
      expect(sibling.codingAgent?.task).toMatch(/Sub-task \d+\/\d+ of phase "big"/);
    }

    // Successor stitcher node fans-in to all sibling chunks (and not
    // to the original `big` id).
    const stitcher = expanded.nodes.find((n) => n.id === 'integration-stitch')!;
    expect(stitcher.dependsOn).not.toContain('impl-chunk-big');
    for (const sibling of siblings) {
      expect(stitcher.dependsOn).toContain(sibling.id);
    }

    // Each sibling has a per-node model assignment.
    for (const sibling of siblings) {
      expect(expanded.modelAssignments.get(sibling.id)).toBeDefined();
    }
  });

  it('redirects downstream chunk dependsOn to fan-in across all siblings of a split chunk (Task #178)', () => {
    const planner = new CodingPlanner({
      codingModeConfig: stubConfig(),
      fallbackModel: 'claude-sonnet-4',
    });
    const plan = planner.plan('Implement feature per spec.md', 'feature-implementation', stubProfile());
    const decision: FanOutDecision = {
      chunks: [
        {
          id: 'big', label: 'BIG',
          fileCluster: ['src/a.ts', 'src/b.ts'],
          sharedFiles: [],
          task: 'do big',
          estimatedComplexity: 'high',
        },
        {
          id: 'follow-up', label: 'Follow-up',
          fileCluster: ['src/c.ts'],
          sharedFiles: [],
          task: 'do follow-up',
          estimatedComplexity: 'low',
          dependsOn: ['big'],
        },
      ],
      maxParallelism: 2,
    };
    const expanded = planner.materializeFanOut(plan, decision);

    const followUp = expanded.nodes.find((n) => n.id === 'impl-chunk-follow-up')!;
    const siblings = expanded.nodes
      .filter((n) => n.id.startsWith('impl-chunk-big-part'))
      .map((n) => n.id);
    for (const sibId of siblings) {
      expect(followUp.dependsOn).toContain(sibId);
    }
    expect(followUp.dependsOn).not.toContain('impl-chunk-big');
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
