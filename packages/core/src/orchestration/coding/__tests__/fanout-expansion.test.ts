/**
 * @module orchestration/coding/__tests__/fanout-expansion
 *
 * Task #174 regression: validates the runtime expansion of an
 * `impl-placeholder` template node into N concrete `impl-chunk-<id>`
 * nodes driven by a {@link FanOutDecision}, including:
 *
 *   - One node per chunk with id `impl-chunk-<chunk.id>`.
 *   - Per-chunk `dependsOn` (Task #174 addition) propagates as
 *     inter-chunk DAG edges (the multi-phase spec ordering rule).
 *   - Independent phases land as parallel siblings (their `dependsOn`
 *     sets equal the placeholder's original upstreams, with no extra
 *     ordering between them).
 *   - Successor nodes that referenced the placeholder fan-in to all
 *     chunk nodes (stitcher join semantics preserved).
 *   - Per-chunk `fileScope.owned` / `readable` are populated from the
 *     chunk's `fileCluster` / `sharedFiles`.
 *
 * Also exercises {@link analyzeFanOutComplexity}: per-chunk complexity
 * is captured for dispatch logging, `high`-tagged chunks trigger a
 * one-shot re-plan request, and the re-plan is suppressed once it has
 * already happened (the cap-at-one-pass invariant).
 */

import { describe, it, expect } from 'vitest';
import {
  expandFanOut,
  analyzeFanOutComplexity,
  subdivideHighComplexityChunks,
  chunkNodeId,
  FANOUT_PLACEHOLDER_ID,
} from '../fanout-expansion.js';
import { buildFeatureImplementationTemplate } from '../templates/feature-implementation.js';
import type { FanOutDecision } from '../coding-types.js';

const STUB = {
  scanner: 1, architect: 1, implementer: 1,
  stitcher: 1, testWriter: 1, reporter: 1,
};
const STUB_MODELS = {
  scanner: 'm', architect: 'm', implementer: 'm',
  stitcher: 'm', testWriter: 'm', reporter: 'm',
};

function sixPhaseDecision(): FanOutDecision {
  return {
    chunks: [
      { id: 'phase-1', label: 'Phase 1', fileCluster: ['a.ts'], sharedFiles: [], task: 'do P1', estimatedComplexity: 'low' },
      { id: 'phase-2', label: 'Phase 2', fileCluster: ['b.ts'], sharedFiles: [], task: 'do P2', estimatedComplexity: 'low' },
      { id: 'phase-3', label: 'Phase 3', fileCluster: ['c.ts'], sharedFiles: [], task: 'do P3', estimatedComplexity: 'low' },
      // Phase 4 depends on Phase 3 (per the synthetic spec).
      { id: 'phase-4', label: 'Phase 4', fileCluster: ['d.ts'], sharedFiles: [], task: 'do P4', estimatedComplexity: 'low', dependsOn: ['phase-3'] },
      { id: 'phase-5', label: 'Phase 5', fileCluster: ['e.ts'], sharedFiles: [], task: 'do P5', estimatedComplexity: 'low' },
      // Phase 6 depends on Phase 4.
      { id: 'phase-6', label: 'Phase 6', fileCluster: ['f.ts'], sharedFiles: [], task: 'do P6', estimatedComplexity: 'low', dependsOn: ['phase-4'] },
    ],
    maxParallelism: 6,
  };
}

describe('expandFanOut (Task #174 runtime expansion)', () => {
  it('emits one impl-chunk node per chunk and removes the placeholder', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const expanded = expandFanOut({ template: tmpl, decision: sixPhaseDecision() });

    expect(expanded.find((n) => n.id === FANOUT_PLACEHOLDER_ID)).toBeUndefined();
    for (let i = 1; i <= 6; i++) {
      expect(expanded.find((n) => n.id === chunkNodeId(`phase-${i}`))).toBeDefined();
    }
  });

  it('propagates per-chunk dependsOn as inter-chunk edges', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const expanded = expandFanOut({ template: tmpl, decision: sixPhaseDecision() });

    const p4 = expanded.find((n) => n.id === chunkNodeId('phase-4'))!;
    expect(p4.dependsOn).toContain(chunkNodeId('phase-3'));
    expect(p4.dependsOn).toContain('architecture-design'); // placeholder upstream preserved

    const p6 = expanded.find((n) => n.id === chunkNodeId('phase-6'))!;
    expect(p6.dependsOn).toContain(chunkNodeId('phase-4'));
  });

  it('keeps independent phases parallel (only inherit placeholder upstreams)', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const expanded = expandFanOut({ template: tmpl, decision: sixPhaseDecision() });

    for (const id of ['phase-1', 'phase-2', 'phase-3', 'phase-5']) {
      const node = expanded.find((n) => n.id === chunkNodeId(id))!;
      expect(node.dependsOn).toEqual(['architecture-design']);
    }
  });

  it('rewrites successor nodes (stitcher) to fan-in across all chunks', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const expanded = expandFanOut({ template: tmpl, decision: sixPhaseDecision() });

    const stitcher = expanded.find((n) => n.id === 'integration-stitch')!;
    expect(stitcher.dependsOn).not.toContain(FANOUT_PLACEHOLDER_ID);
    for (let i = 1; i <= 6; i++) {
      expect(stitcher.dependsOn).toContain(chunkNodeId(`phase-${i}`));
    }
  });

  it('populates fileScope.owned / readable from each chunk', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const expanded = expandFanOut({ template: tmpl, decision: sixPhaseDecision() });

    const p1 = expanded.find((n) => n.id === chunkNodeId('phase-1'))!;
    expect(p1.codingConfig?.fileScope?.owned).toEqual(['a.ts']);
    expect(p1.codingAgent?.task).toBe('do P1');
  });

  it('throws on duplicate chunk ids', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const dup: FanOutDecision = {
      chunks: [
        { id: 'x', label: 'X', fileCluster: [], sharedFiles: [], task: 'a', estimatedComplexity: 'low' },
        { id: 'x', label: 'X2', fileCluster: [], sharedFiles: [], task: 'b', estimatedComplexity: 'low' },
      ],
      maxParallelism: 2,
    };
    expect(() => expandFanOut({ template: tmpl, decision: dup })).toThrow(/duplicate chunk id/);
  });

  it('returns the template unchanged when the decision is empty', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const out = expandFanOut({ template: tmpl, decision: { chunks: [], maxParallelism: 1 } });
    expect(out.find((n) => n.id === FANOUT_PLACEHOLDER_ID)).toBeDefined();
  });

  it('skips unknown chunk-level dependsOn references with a warning, not an error', () => {
    const tmpl = buildFeatureImplementationTemplate({
      task: 't', cwd: '/tmp/repo', models: STUB_MODELS, budgets: STUB, maxTurns: STUB,
    });
    const decision: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'b', label: 'B', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low', dependsOn: ['nonexistent', 'a'] },
      ],
      maxParallelism: 2,
    };
    const out = expandFanOut({ template: tmpl, decision });
    const b = out.find((n) => n.id === chunkNodeId('b'))!;
    expect(b.dependsOn).toContain(chunkNodeId('a'));
    expect(b.dependsOn).not.toContain('nonexistent');
  });
});

describe('analyzeFanOutComplexity (Task #174 safety net)', () => {
  it('reports per-chunk complexity for dispatch logging', () => {
    const decision: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'b', label: 'B', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'medium' },
      ],
      maxParallelism: 2,
    };
    const r = analyzeFanOutComplexity(decision);
    expect(r.perChunk).toEqual([
      { id: 'a', estimatedComplexity: 'low' },
      { id: 'b', estimatedComplexity: 'medium' },
    ]);
    expect(r.highComplexityIds).toEqual([]);
    expect(r.requiresReplan).toBe(false);
    expect(r.replanInstruction).toBeNull();
  });

  it('flags high-complexity chunks for a one-shot re-plan with a usable instruction', () => {
    const decision: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'big', label: 'BIG', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 2,
    };
    const r = analyzeFanOutComplexity(decision);
    expect(r.highComplexityIds).toEqual(['big']);
    expect(r.requiresReplan).toBe(true);
    expect(r.replanInstruction).toMatch(/Subdivide each into 2–4 sibling chunks/);
    expect(r.replanInstruction).toMatch(/big/);
  });

  it('suppresses the re-plan once it has already happened (cap-at-one-pass)', () => {
    const decision: FanOutDecision = {
      chunks: [
        { id: 'big', label: 'BIG', fileCluster: [], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 1,
    };
    const r = analyzeFanOutComplexity(decision, { alreadyReplanned: true });
    expect(r.highComplexityIds).toEqual(['big']);
    expect(r.requiresReplan).toBe(false);
    expect(r.replanInstruction).toBeNull();
  });
});

describe('subdivideHighComplexityChunks (Task #178 deterministic safety net)', () => {
  it('splits a single high-complexity chunk into 2–4 medium siblings carrying the same dependsOn', () => {
    const decision: FanOutDecision = {
      chunks: [
        {
          id: 'big', label: 'BIG',
          fileCluster: ['a.ts', 'b.ts', 'c.ts'],
          sharedFiles: ['shared.ts'],
          task: 'do everything',
          estimatedComplexity: 'high',
          dependsOn: ['preflight'],
        },
      ],
      maxParallelism: 1,
    };
    const { decision: out, report } = subdivideHighComplexityChunks(decision);
    expect(out.chunks.find((c) => c.id === 'big')).toBeUndefined();
    expect(out.chunks.length).toBeGreaterThanOrEqual(2);
    expect(out.chunks.length).toBeLessThanOrEqual(4);
    expect(report.splits).toHaveLength(1);
    expect(report.splits[0]!.originalId).toBe('big');
    expect(report.splits[0]!.subIds).toEqual(out.chunks.map((c) => c.id));

    for (const c of out.chunks) {
      expect(c.estimatedComplexity).toBe('medium');
      expect(c.dependsOn).toEqual(['preflight']);
      expect(c.sharedFiles).toEqual(['shared.ts']);
      expect(c.task).toMatch(/Sub-task \d+\/\d+ of phase "big"/);
    }
    const allOwned = out.chunks.flatMap((c) => c.fileCluster);
    expect(new Set(allOwned)).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
    expect(out.maxParallelism).toBeGreaterThanOrEqual(out.chunks.length);
  });

  it('redirects sibling chunks that depended on the split chunk to fan-in to all sub-chunks', () => {
    const decision: FanOutDecision = {
      chunks: [
        { id: 'big', label: 'BIG', fileCluster: ['a.ts', 'b.ts'], sharedFiles: [], task: 'big', estimatedComplexity: 'high' },
        { id: 'after', label: 'After', fileCluster: ['c.ts'], sharedFiles: [], task: 'after', estimatedComplexity: 'low', dependsOn: ['big'] },
      ],
      maxParallelism: 2,
    };
    const { decision: out } = subdivideHighComplexityChunks(decision);
    const after = out.chunks.find((c) => c.id === 'after')!;
    const subs = out.chunks.filter((c) => c.id.startsWith('big-part')).map((c) => c.id);
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(after.dependsOn).not.toContain('big');
    for (const s of subs) expect(after.dependsOn).toContain(s);
  });

  it('is a no-op when no chunk is high', () => {
    const decision: FanOutDecision = {
      chunks: [
        { id: 'a', label: 'A', fileCluster: ['a.ts'], sharedFiles: [], task: '...', estimatedComplexity: 'low' },
        { id: 'b', label: 'B', fileCluster: ['b.ts'], sharedFiles: [], task: '...', estimatedComplexity: 'medium' },
      ],
      maxParallelism: 2,
    };
    const { decision: out, report } = subdivideHighComplexityChunks(decision);
    expect(out).toBe(decision);
    expect(report.splits).toEqual([]);
  });

  it('is a no-op when alreadyReplanned (cap-at-one-pass invariant)', () => {
    const decision: FanOutDecision = {
      chunks: [
        { id: 'big', label: 'BIG', fileCluster: ['a.ts'], sharedFiles: [], task: '...', estimatedComplexity: 'high' },
      ],
      maxParallelism: 1,
    };
    const { decision: out, report } = subdivideHighComplexityChunks(decision, { alreadyReplanned: true });
    expect(out).toBe(decision);
    expect(report.splits).toEqual([]);
  });

  it('produces minSubchunks siblings when fileCluster is empty', () => {
    const decision: FanOutDecision = {
      chunks: [
        { id: 'big', label: 'BIG', fileCluster: [], sharedFiles: [], task: 'do big', estimatedComplexity: 'high' },
      ],
      maxParallelism: 1,
    };
    const { decision: out } = subdivideHighComplexityChunks(decision);
    expect(out.chunks).toHaveLength(2);
    for (const c of out.chunks) expect(c.fileCluster).toEqual([]);
  });

  it('caps subdivision at maxSubchunks=4 even with many files', () => {
    const decision: FanOutDecision = {
      chunks: [
        {
          id: 'big', label: 'BIG',
          fileCluster: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'],
          sharedFiles: [],
          task: '...',
          estimatedComplexity: 'high',
        },
      ],
      maxParallelism: 1,
    };
    const { decision: out } = subdivideHighComplexityChunks(decision);
    expect(out.chunks).toHaveLength(4);
    const allOwned = out.chunks.flatMap((c) => c.fileCluster);
    expect(allOwned).toHaveLength(7);
  });
});
