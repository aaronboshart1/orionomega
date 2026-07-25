/**
 * @module __tests__/output-aggregator
 * Unit tests for OutputAggregator — merge(), detectConflicts(), buildStitcherContext().
 */

import { describe, it, expect } from 'vitest';
import { OutputAggregator } from '../output-aggregator.js';
import type { WorkerResult } from '../../worker.js';

function makeWorkerResult(nodeId: string, outputPaths: string[], output?: object | string): WorkerResult {
  return {
    nodeId,
    output: output ?? null,
    durationMs: 100,
    toolCallCount: 5,
    findings: [],
    outputPaths,
    model: 'claude-sonnet-4-6',
    tokens: { input: 1000, output: 500 },
    costUsd: 0.01,
    finalResult: '',
    cancelled: false,
  };
}

function makeImplOutput(
  nodeId: string,
  filesModified: string[],
  filesCreated: string[] = [],
  summary = 'implemented changes',
): WorkerResult {
  return makeWorkerResult(nodeId, filesModified, {
    filesModified,
    filesCreated,
    summary,
    openQuestions: [],
  });
}

describe('OutputAggregator — merge without conflicts', () => {
  it('unions modified and created files and keeps a summary per worker', () => {
    const merged = new OutputAggregator().merge([
      makeImplOutput('impl-0', ['src/a.ts', 'src/b.ts'], ['src/new.ts'], 'Chunk 0 done'),
      makeImplOutput('impl-1', ['src/c.ts'], [], 'Chunk 1 done'),
    ]);

    expect(merged.allFilesModified).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/c.ts']));
    expect(merged.allFilesCreated).toContain('src/new.ts');
    expect(merged.conflicts).toHaveLength(0);
    expect(merged.perWorkerSummaries).toHaveLength(2);
    expect(merged.perWorkerSummaries[0].workerId).toBe('impl-0');
    expect(merged.perWorkerSummaries[0].summary).toBe('Chunk 0 done');
  });
});

describe('OutputAggregator — merge with conflicts', () => {
  it('flags a file touched by two workers as needing the stitcher', () => {
    const merged = new OutputAggregator().merge([
      makeImplOutput('impl-0', ['src/shared.ts', 'src/a.ts'], []),
      makeImplOutput('impl-1', ['src/shared.ts', 'src/b.ts'], []),
    ]);

    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0].file).toBe('src/shared.ts');
    expect(merged.conflicts[0].workers).toEqual(expect.arrayContaining(['impl-0', 'impl-1']));
    expect(merged.conflicts[0].resolution).toBe('needs-stitcher');
  });

  it('collapses a file touched by three workers into one conflict listing all three', () => {
    const merged = new OutputAggregator().merge([
      makeImplOutput('impl-0', ['src/shared.ts']),
      makeImplOutput('impl-1', ['src/shared.ts']),
      makeImplOutput('impl-2', ['src/shared.ts']),
    ]);

    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0].workers).toHaveLength(3);
  });
});

describe('OutputAggregator — outputPaths fallback', () => {
  it('falls back to outputPaths when the worker output is not an ImplementerOutput', () => {
    const merged = new OutputAggregator().merge([
      makeWorkerResult('worker-0', ['src/fallback.ts'], 'plain string output'),
    ]);

    expect(merged.allFilesModified).toContain('src/fallback.ts');
  });

  it('falls back to outputPaths when the output object lacks the file fields', () => {
    const merged = new OutputAggregator().merge([
      makeWorkerResult('worker-0', ['src/a.ts'], { something: 'else' }),
    ]);

    expect(merged.allFilesModified).toContain('src/a.ts');
  });
});

describe('OutputAggregator — deduplication', () => {
  it('lists a file touched by two workers only once', () => {
    const merged = new OutputAggregator().merge([
      makeWorkerResult('worker-0', ['src/a.ts', 'src/b.ts']),
      makeWorkerResult('worker-1', ['src/b.ts', 'src/c.ts']),
    ]);

    expect(merged.allFilesModified.filter((f) => f === 'src/b.ts')).toHaveLength(1);
    expect(merged.allFilesModified).toHaveLength(3);
  });
});

describe('OutputAggregator — detectConflicts', () => {
  it('returns nothing for disjoint file sets', () => {
    const conflicts = new OutputAggregator().detectConflicts([
      makeImplOutput('impl-0', ['src/a.ts']),
      makeImplOutput('impl-1', ['src/b.ts']),
    ]);

    expect(conflicts).toHaveLength(0);
  });

  it('identifies the single shared file among three workers', () => {
    const conflicts = new OutputAggregator().detectConflicts([
      makeImplOutput('impl-0', ['src/a.ts', 'shared/types.ts']),
      makeImplOutput('impl-1', ['src/b.ts', 'shared/types.ts']),
      makeImplOutput('impl-2', ['src/c.ts']),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toBe('shared/types.ts');
  });

  it('returns nothing for empty results', () => {
    expect(new OutputAggregator().detectConflicts([])).toHaveLength(0);
  });
});

describe('OutputAggregator — buildStitcherContext', () => {
  it('reports workers, summaries, conflicting files, and created files', () => {
    const agg = new OutputAggregator();
    const merged = agg.merge([
      makeImplOutput('impl-0', ['src/a.ts', 'src/shared.ts'], ['src/new.ts'], 'Added feature A'),
      makeImplOutput('impl-1', ['src/b.ts', 'src/shared.ts'], [], 'Added feature B'),
    ]);

    const ctx = agg.buildStitcherContext(merged, merged.conflicts);

    expect(typeof ctx).toBe('string');
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx).toContain('# Implementation Aggregation Report');
    expect(ctx).toContain('impl-0');
    expect(ctx).toContain('impl-1');
    expect(ctx).toContain('Added feature A');
    expect(ctx).toContain('src/shared.ts');
    expect(ctx).toContain('needs-stitcher');
    expect(ctx).toContain('Conflicts to Resolve');
    expect(ctx).toContain('src/new.ts');
  });

  it('reports a clean merge without any stitcher action', () => {
    const agg = new OutputAggregator();
    const merged = agg.merge([
      makeImplOutput('impl-0', ['src/a.ts']),
      makeImplOutput('impl-1', ['src/b.ts']),
    ]);

    const ctx = agg.buildStitcherContext(merged, []);

    expect(ctx).toContain('No conflicts detected');
    expect(ctx).not.toContain('needs-stitcher');
  });

  it('counts zero workers for an empty aggregation', () => {
    const ctx = new OutputAggregator().buildStitcherContext(
      { allFilesModified: [], allFilesCreated: [], perWorkerSummaries: [], conflicts: [] },
      [],
    );

    expect(ctx).toContain('Parallel workers completed:** 0');
  });
});

describe('OutputAggregator — edge cases', () => {
  it('merges an empty result set into an empty aggregation', () => {
    const merged = new OutputAggregator().merge([]);

    expect(merged.allFilesModified).toHaveLength(0);
    expect(merged.allFilesCreated).toHaveLength(0);
    expect(merged.conflicts).toHaveLength(0);
    expect(merged.perWorkerSummaries).toHaveLength(0);
  });

  it('handles a worker that touched no files but still reported a summary', () => {
    const merged = new OutputAggregator().merge([makeImplOutput('impl-0', [], [], 'nothing to do')]);

    expect(merged.allFilesModified).toHaveLength(0);
    expect(merged.perWorkerSummaries[0].summary).toBe('nothing to do');
  });
});
