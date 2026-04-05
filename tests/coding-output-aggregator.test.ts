/**
 * Unit tests for OutputAggregator.
 *
 * Covers: merge(), detectConflicts(), and buildStitcherContext().
 */

import {
  suite, section, assert, assertEq, assertGt, printSummary,
} from './test-harness.js';
import { OutputAggregator } from '../packages/core/src/orchestration/coding/output-aggregator.js';
import type { WorkerResult } from '../packages/core/src/orchestration/worker.js';

suite('OutputAggregator Unit Tests');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWorkerResult(
  nodeId: string,
  outputPaths: string[],
  output?: object | string,
): WorkerResult {
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

// ── Section 1: merge() — no conflicts ─────────────────────────────────────────

section('1. merge() — no conflicts');

{
  const agg = new OutputAggregator();
  const results = [
    makeImplOutput('impl-0', ['src/a.ts', 'src/b.ts'], ['src/new.ts'], 'Chunk 0 done'),
    makeImplOutput('impl-1', ['src/c.ts'], [], 'Chunk 1 done'),
  ];

  const merged = agg.merge(results);

  assert(
    merged.allFilesModified.includes('src/a.ts') &&
    merged.allFilesModified.includes('src/b.ts') &&
    merged.allFilesModified.includes('src/c.ts'),
    '1.1 allFilesModified contains all files from both workers',
  );
  assert(
    merged.allFilesCreated.includes('src/new.ts'),
    '1.2 allFilesCreated contains files from worker with ImplementerOutput shape',
  );
  assertEq(merged.conflicts.length, 0, '1.3 no conflicts when workers touch different files');
  assertEq(merged.perWorkerSummaries.length, 2, '1.4 perWorkerSummaries has entry per worker');
  assertEq(merged.perWorkerSummaries[0].workerId, 'impl-0', '1.4 first summary worker ID');
  assertEq(merged.perWorkerSummaries[0].summary, 'Chunk 0 done', '1.4 summary text preserved');
}

// ── Section 2: merge() — with conflicts ───────────────────────────────────────

section('2. merge() — with conflicts');

{
  const agg = new OutputAggregator();
  const results = [
    makeImplOutput('impl-0', ['src/shared.ts', 'src/a.ts'], []),
    makeImplOutput('impl-1', ['src/shared.ts', 'src/b.ts'], []),
  ];

  const merged = agg.merge(results);

  assertEq(merged.conflicts.length, 1, '2.1 one conflict detected (shared.ts touched by both)');
  assertEq(merged.conflicts[0].file, 'src/shared.ts', '2.1 conflicting file is shared.ts');
  assert(
    merged.conflicts[0].workers.includes('impl-0') &&
    merged.conflicts[0].workers.includes('impl-1'),
    '2.1 both workers listed in conflict',
  );
  assertEq(merged.conflicts[0].resolution, 'needs-stitcher', '2.1 resolution is needs-stitcher');
}

{
  const agg = new OutputAggregator();
  // Three workers all touch the same file
  const results = [
    makeImplOutput('impl-0', ['src/shared.ts']),
    makeImplOutput('impl-1', ['src/shared.ts']),
    makeImplOutput('impl-2', ['src/shared.ts']),
  ];

  const merged = agg.merge(results);
  assertEq(merged.conflicts.length, 1, '2.2 single conflict for file touched by 3 workers');
  assertEq(merged.conflicts[0].workers.length, 3, '2.2 all 3 workers listed in conflict');
}

// ── Section 3: merge() — fallback to outputPaths ──────────────────────────────

section('3. merge() — fallback to outputPaths');

{
  const agg = new OutputAggregator();
  // No ImplementerOutput shape — uses outputPaths fallback
  const results = [
    makeWorkerResult('worker-0', ['src/fallback.ts'], 'plain string output'),
  ];

  const merged = agg.merge(results);
  assert(
    merged.allFilesModified.includes('src/fallback.ts'),
    '3.1 falls back to outputPaths when no ImplementerOutput shape',
  );
}

{
  const agg = new OutputAggregator();
  // Output is an object but missing required fields
  const results = [
    makeWorkerResult('worker-0', ['src/a.ts'], { something: 'else' }),
  ];

  const merged = agg.merge(results);
  assert(
    merged.allFilesModified.includes('src/a.ts'),
    '3.2 falls back to outputPaths when output lacks filesModified/filesCreated fields',
  );
}

// ── Section 4: merge() — deduplication ────────────────────────────────────────

section('4. merge() — file deduplication');

{
  const agg = new OutputAggregator();
  // Both workers list the same file in outputPaths (no ImplementerOutput)
  const results = [
    makeWorkerResult('worker-0', ['src/a.ts', 'src/b.ts']),
    makeWorkerResult('worker-1', ['src/b.ts', 'src/c.ts']),
  ];

  const merged = agg.merge(results);
  // allFilesModified uses a Set internally, so b.ts appears once
  const bCount = merged.allFilesModified.filter((f) => f === 'src/b.ts').length;
  assertEq(bCount, 1, '4.1 shared file deduplicated in allFilesModified');
  assertEq(merged.allFilesModified.length, 3, '4.1 total 3 unique modified files');
}

// ── Section 5: detectConflicts() ─────────────────────────────────────────────

section('5. detectConflicts()');

{
  const agg = new OutputAggregator();
  const results = [
    makeImplOutput('impl-0', ['src/a.ts']),
    makeImplOutput('impl-1', ['src/b.ts']),
  ];

  const conflicts = agg.detectConflicts(results);
  assertEq(conflicts.length, 0, '5.1 no conflicts for disjoint file sets');
}

{
  const agg = new OutputAggregator();
  const results = [
    makeImplOutput('impl-0', ['src/a.ts', 'shared/types.ts']),
    makeImplOutput('impl-1', ['src/b.ts', 'shared/types.ts']),
    makeImplOutput('impl-2', ['src/c.ts']),
  ];

  const conflicts = agg.detectConflicts(results);
  assertEq(conflicts.length, 1, '5.2 one conflict for types.ts touched by impl-0 and impl-1');
  assertEq(conflicts[0].file, 'shared/types.ts', '5.2 correct conflicting file');
}

{
  const agg = new OutputAggregator();
  // Empty results
  const conflicts = agg.detectConflicts([]);
  assertEq(conflicts.length, 0, '5.3 empty results → no conflicts');
}

// ── Section 6: buildStitcherContext() ────────────────────────────────────────

section('6. buildStitcherContext()');

{
  const agg = new OutputAggregator();
  const results = [
    makeImplOutput('impl-0', ['src/a.ts', 'src/shared.ts'], ['src/new.ts'], 'Added feature A'),
    makeImplOutput('impl-1', ['src/b.ts', 'src/shared.ts'], [], 'Added feature B'),
  ];

  const merged = agg.merge(results);
  const conflicts = merged.conflicts;
  const ctx = agg.buildStitcherContext(merged, conflicts);

  assert(typeof ctx === 'string', '6.1 buildStitcherContext returns a string');
  assertGt(ctx.length, 0, '6.1 context is non-empty');
  assert(ctx.includes('# Implementation Aggregation Report'), '6.2 contains header');
  assert(ctx.includes('impl-0'), '6.3 contains worker ID impl-0');
  assert(ctx.includes('impl-1'), '6.3 contains worker ID impl-1');
  assert(ctx.includes('Added feature A'), '6.4 contains worker summary text');
  assert(ctx.includes('src/shared.ts'), '6.5 mentions conflicting file');
  assert(ctx.includes('needs-stitcher'), '6.6 mentions conflict resolution strategy');
  assert(ctx.includes('Conflicts to Resolve'), '6.7 has conflict section when conflicts exist');
  assert(ctx.includes('src/new.ts'), '6.8 created files section includes new.ts');
}

{
  const agg = new OutputAggregator();
  const results = [
    makeImplOutput('impl-0', ['src/a.ts']),
    makeImplOutput('impl-1', ['src/b.ts']),
  ];

  const merged = agg.merge(results);
  const ctx = agg.buildStitcherContext(merged, []);

  assert(ctx.includes('No conflicts detected'), '6.9 no-conflict message when clean');
  assert(!ctx.includes('needs-stitcher'), '6.10 no stitcher action when no conflicts');
}

{
  const agg = new OutputAggregator();
  const ctx = agg.buildStitcherContext(
    { allFilesModified: [], allFilesCreated: [], perWorkerSummaries: [], conflicts: [] },
    [],
  );

  assert(ctx.includes('Parallel workers completed:** 0'), '6.11 zero workers counted correctly');
}

// ── Section 7: Edge cases ─────────────────────────────────────────────────────

section('7. Edge cases');

{
  const agg = new OutputAggregator();
  // merge with zero results
  const merged = agg.merge([]);
  assertEq(merged.allFilesModified.length, 0, '7.1 merge([]) → empty allFilesModified');
  assertEq(merged.allFilesCreated.length, 0, '7.1 merge([]) → empty allFilesCreated');
  assertEq(merged.conflicts.length, 0, '7.1 merge([]) → no conflicts');
  assertEq(merged.perWorkerSummaries.length, 0, '7.1 merge([]) → no worker summaries');
}

{
  const agg = new OutputAggregator();
  // Single worker, no files
  const results = [makeImplOutput('impl-0', [], [], 'nothing to do')];
  const merged = agg.merge(results);
  assertEq(merged.allFilesModified.length, 0, '7.2 single worker with no files is fine');
  assertEq(merged.perWorkerSummaries[0].summary, 'nothing to do', '7.2 summary preserved');
}

// ── Summary ───────────────────────────────────────────────────────────────────

const ok = printSummary('OutputAggregator');
if (!ok) process.exit(1);
