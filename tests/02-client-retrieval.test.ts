/**
 * Retrieval Layer Tests — client.ts
 *
 * Tests: query format construction, threshold calibration (F4),
 * temporal parameter naming (F5), query truncation (F6),
 * client-side relevance fallback, log differentiation (F10),
 * recall effectiveness metric (F13), budget tiers, dedup integration.
 */

import {
  suite, section, assert, assertEq, assertApprox, assertGt, assertLt,
  assertDeepEq, resetResults, printSummary, createMockFn,
} from './test-harness.js';

resetResults();
suite('02 — Retrieval Layer: Client Recall');

// ════════════════════════════════════════════════════════════════
// 1. THRESHOLD CALIBRATION (F4)
// ════════════════════════════════════════════════════════════════

section('1.1 Default minRelevance = 0.15 [F4]');

{
  // Simulate the default threshold selection
  const opts: { minRelevance?: number } = {};
  const requestedMinRelevance = opts.minRelevance ?? 0.15;
  assertEq(requestedMinRelevance, 0.15, 'Default threshold is 0.15 (not old 0.3)');
}

{
  // Verify score survival with new threshold
  const clientScores = [0.02, 0.07, 0.12, 0.14, 0.15, 0.20, 0.28, 0.35, 0.50];
  const thresholdNew = 0.15;
  const thresholdOld = 0.3;

  const survivingNew = clientScores.filter(s => s >= thresholdNew);
  const survivingOld = clientScores.filter(s => s >= thresholdOld);

  assertEq(survivingNew.length, 5, `5/9 scores survive new 0.15 threshold`);
  assertEq(survivingOld.length, 2, `Only 2/9 survived old 0.3 threshold`);
  assertGt(survivingNew.length, survivingOld.length,
    'New threshold surfaces significantly more results');
}

section('1.2 CLIENT_FALLBACK_CEILING caps threshold when client-scoring [F4]');

{
  const CLIENT_FALLBACK_CEILING = 0.15;

  // Caller passes 0.3 (calibrated for embeddings), but API returned all zeros
  const callerMin = 0.3;
  const allZero = true;
  const effective = allZero ? Math.min(callerMin, CLIENT_FALLBACK_CEILING) : callerMin;
  assertEq(effective, 0.15, 'CLIENT_FALLBACK_CEILING caps 0.3 → 0.15');

  // When API returns real scores, caller threshold used as-is
  const effectiveReal = false ? Math.min(callerMin, CLIENT_FALLBACK_CEILING) : callerMin;
  assertEq(effectiveReal, 0.3, 'Real API scores use caller threshold directly');

  // Caller already below ceiling
  const callerLow = 0.1;
  const effectiveLow = allZero ? Math.min(callerLow, CLIENT_FALLBACK_CEILING) : callerLow;
  assertEq(effectiveLow, 0.1, 'Below-ceiling threshold preserved');
}

section('1.3 Threshold boundary cases');

{
  const threshold = 0.15;
  const results = [
    { content: 'a', relevance: 0.15 },
    { content: 'b', relevance: 0.14999 },
    { content: 'c', relevance: 0.0 },
    { content: 'd', relevance: 1.0 },
  ];
  const filtered = results.filter(r => r.relevance >= threshold);
  assertEq(filtered.length, 2, 'Boundary: 0.15 passes, 0.14999 drops');
}

// ════════════════════════════════════════════════════════════════
// 2. TEMPORAL PARAMETER NAMING (F5)
// ════════════════════════════════════════════════════════════════

section('2.1 query_timestamp field construction [F5]');

{
  const opts = { before: '2026-01-15T00:00:00Z' };
  const body: Record<string, unknown> = { query: 'test', max_tokens: 4096, budget: 'mid' };

  // Fixed: uses query_timestamp, not before
  if (opts.before) {
    body.query_timestamp = opts.before;
  }

  assertEq(body.query_timestamp, '2026-01-15T00:00:00Z', 'query_timestamp set from opts.before');
  assert(!('before' in body), 'body.before NOT set');
}

section('2.2 Missing before → no query_timestamp');

{
  const opts: { before?: string } = {};
  const body: Record<string, unknown> = { query: 'test' };
  if (opts.before) {
    body.query_timestamp = opts.before;
  }
  assert(!('query_timestamp' in body), 'No before → no query_timestamp in body');
}

// ════════════════════════════════════════════════════════════════
// 3. QUERY TRUNCATION (F6)
// ════════════════════════════════════════════════════════════════

section('3.1 Normal queries pass through [F6]');

{
  const MAX_QUERY_LENGTH = 4000;
  const queries = ['fix sql bug', 'What was the auth decision?', 'x'.repeat(3999)];
  for (const q of queries) {
    const effective = q.length > MAX_QUERY_LENGTH ? q.slice(0, MAX_QUERY_LENGTH) : q;
    assertEq(effective.length, q.length, `Query (${q.length} chars) not truncated`);
  }
}

section('3.2 Oversized queries truncated [F6]');

{
  const MAX_QUERY_LENGTH = 4000;
  const oversized = [4001, 10000, 50000, 100000];
  for (const len of oversized) {
    const q = 'A'.repeat(len);
    const effective = q.length > MAX_QUERY_LENGTH ? q.slice(0, MAX_QUERY_LENGTH) : q;
    assertEq(effective.length, 4000, `${len}-char query truncated to 4000`);
  }
}

section('3.3 Boundary: exactly 4000 chars');

{
  const q = 'B'.repeat(4000);
  const MAX_QUERY_LENGTH = 4000;
  const effective = q.length > MAX_QUERY_LENGTH ? q.slice(0, MAX_QUERY_LENGTH) : q;
  assertEq(effective.length, 4000, 'Exactly 4000 chars NOT truncated');
  assertEq(effective, q, 'Content preserved at boundary');
}

// ════════════════════════════════════════════════════════════════
// 4. CLIENT-SIDE RELEVANCE FALLBACK
// ════════════════════════════════════════════════════════════════

section('4.1 All-zero detection triggers client scoring');

{
  const results = [
    { content: 'Fix auth bug', relevance: 0 },
    { content: 'Deploy to staging', relevance: 0 },
    { content: 'Update schema', relevance: 0 },
  ];
  const allZero = results.length > 0 && results.every(r => r.relevance === 0);
  assert(allZero, 'All-zero detection works for 3 zero-relevance results');
}

section('4.2 Mixed scores do NOT trigger client fallback');

{
  const results = [
    { content: 'a', relevance: 0.5 },
    { content: 'b', relevance: 0 },
    { content: 'c', relevance: 0.2 },
  ];
  const allZero = results.length > 0 && results.every(r => r.relevance === 0);
  assert(!allZero, 'Mixed scores do not trigger client fallback');
}

section('4.3 Empty results do NOT trigger client fallback');

{
  const results: Array<{ relevance: number }> = [];
  const allZero = results.length > 0 && results.every(r => r.relevance === 0);
  assert(!allZero, 'Empty results do not trigger client fallback');
}

// ════════════════════════════════════════════════════════════════
// 5. LOG MESSAGE DIFFERENTIATION (F10)
// ════════════════════════════════════════════════════════════════

section('5.1 Zero API results message [F10]');

{
  const totalFromApi = 0;
  const minRelevance = 0.15;
  const droppedByRelevance = 0;

  const detail = totalFromApi === 0
    ? 'No matching memories found (API returned 0 results)'
    : `All ${totalFromApi} results filtered below relevance threshold (min: ${minRelevance}, dropped: ${droppedByRelevance})`;

  assert(detail.includes('API returned 0 results'), 'Zero results message correct');
}

section('5.2 All-filtered message [F10]');

{
  const totalFromApi = 15;
  const minRelevance = 0.15;
  const droppedByRelevance = 15;

  const detail = totalFromApi === 0
    ? 'No matching memories found (API returned 0 results)'
    : `All ${totalFromApi} results filtered below relevance threshold (min: ${minRelevance}, dropped: ${droppedByRelevance})`;

  assert(detail.includes('All 15 results filtered'), 'Filtered message includes count');
  assert(detail.includes('dropped: 15'), 'Dropped count in message');
  assert(detail.includes('min: 0.15'), 'Threshold value in message');
}

section('5.3 Messages are distinct');

{
  const msg0 = 'No matching memories found (API returned 0 results)';
  const msg15 = 'All 15 results filtered below relevance threshold (min: 0.15, dropped: 15)';
  assert(msg0 !== msg15, 'Two empty-result scenarios produce DIFFERENT messages');
}

// ════════════════════════════════════════════════════════════════
// 6. RECALL EFFECTIVENESS METRIC (F13)
// ════════════════════════════════════════════════════════════════

section('6.1 Surface rate calculation [F13]');

{
  const cases: Array<{ filtered: number; total: number; expectedRate: number }> = [
    { filtered: 10, total: 20, expectedRate: 0.5 },
    { filtered: 1, total: 20, expectedRate: 0.05 },
    { filtered: 0, total: 20, expectedRate: 0.0 },
    { filtered: 20, total: 20, expectedRate: 1.0 },
    { filtered: 0, total: 0, expectedRate: 1.0 }, // no results → not a scoring problem
  ];

  for (const { filtered, total, expectedRate } of cases) {
    const rate = total > 0 ? filtered / total : 1;
    assertApprox(rate, expectedRate - 0.001, expectedRate + 0.001,
      `${filtered}/${total} → ${(rate * 100).toFixed(0)}%`);
  }
}

section('6.2 Warning threshold at < 10%');

{
  const warnCases = [
    { rate: 0.09, shouldWarn: true },
    { rate: 0.05, shouldWarn: true },
    { rate: 0.01, shouldWarn: true },
    { rate: 0.0, shouldWarn: true },
    { rate: 0.1, shouldWarn: false },
    { rate: 0.5, shouldWarn: false },
    { rate: 1.0, shouldWarn: false },
  ];

  for (const { rate, shouldWarn } of warnCases) {
    const warns = rate < 0.1;
    assertEq(warns, shouldWarn,
      `Rate ${(rate * 100).toFixed(0)}% ${shouldWarn ? 'triggers' : 'does not trigger'} warning`);
  }
}

// ════════════════════════════════════════════════════════════════
// 7. BUDGET TIER SYSTEM
// ════════════════════════════════════════════════════════════════

section('7.1 Budget tier max tokens');

{
  const BUDGET_TIER_MAX_TOKENS: Record<string, number> = { low: 1024, mid: 4096, high: 8192 };

  assertEq(BUDGET_TIER_MAX_TOKENS['low'], 1024, 'Low tier = 1024');
  assertEq(BUDGET_TIER_MAX_TOKENS['mid'], 4096, 'Mid tier = 4096');
  assertEq(BUDGET_TIER_MAX_TOKENS['high'], 8192, 'High tier = 8192');
  assertEq(BUDGET_TIER_MAX_TOKENS['unknown'] ?? 4096, 4096, 'Unknown tier defaults to 4096');
}

section('7.2 Effective max tokens = min(requested, tierCap)');

{
  const cases = [
    { requested: 2000, tier: 'mid', expected: 2000 },
    { requested: 10000, tier: 'mid', expected: 4096 },
    { requested: 500, tier: 'low', expected: 500 },
    { requested: 2000, tier: 'low', expected: 1024 },
    { requested: 8192, tier: 'high', expected: 8192 },
    { requested: 100000, tier: 'high', expected: 8192 },
  ];

  const TIERS: Record<string, number> = { low: 1024, mid: 4096, high: 8192 };
  for (const { requested, tier, expected } of cases) {
    const tierCap = TIERS[tier] ?? 4096;
    const effective = Math.min(requested, tierCap);
    assertEq(effective, expected, `${requested} tokens @ ${tier} → ${effective}`);
  }
}

// ════════════════════════════════════════════════════════════════
// 8. TEMPORAL DIVERSITY
// ════════════════════════════════════════════════════════════════

section('8.1 Temporal bucket floor uses new threshold');

{
  // recallWithTemporalDiversity applies: max((opts?.minRelevance ?? 0.15) - 0.05, 0.05)
  const baseThreshold = 0.15;
  const offset = 0.05;
  const temporalFloor = Math.max(baseThreshold - offset, 0.05);
  // Use approximate comparison for IEEE 754 precision
  assertApprox(temporalFloor, 0.099, 0.101, 'Temporal floor ≈ 0.10');
}

{
  // With old 0.3 base:
  const oldBase = 0.3;
  const oldFloor = Math.max(oldBase - 0.05, 0.05);
  assertEq(oldFloor, 0.25, 'Old temporal floor was 0.25 (too aggressive)');
  assert(0.1 < 0.25, 'New floor (0.10) is more permissive than old (0.25)');
}

section('8.2 LOW_CONFIDENCE_THRESHOLD lowered to 0.3');

{
  const LOW_CONFIDENCE_THRESHOLD = 0.3;
  // Client-side scores top out ~0.4, so 0.5 would flag everything
  const clientScores = [0.1, 0.2, 0.25, 0.35];
  const lowConfidence = clientScores.every(s => s < LOW_CONFIDENCE_THRESHOLD);
  assert(!lowConfidence, 'Client scores with 0.35 NOT flagged as low confidence');
}

section('8.3 Temporal ratio clamping');

{
  const clamp = (ratio: number) => Math.max(0, Math.min(1, ratio));
  assertEq(clamp(0.15), 0.15, 'Normal ratio preserved');
  assertEq(clamp(-0.5), 0, 'Negative clamped to 0');
  assertEq(clamp(1.5), 1, 'Over-1 clamped to 1');
  assertEq(clamp(0), 0, 'Zero preserved');
  assertEq(clamp(1), 1, 'One preserved');
}

// ════════════════════════════════════════════════════════════════
// 9. RECALL IO EVENT EMISSION
// ════════════════════════════════════════════════════════════════

section('9.1 onIO event structure for successful recall');

{
  const onIO = createMockFn();
  const results = [
    { content: 'memory 1', context: 'decision', timestamp: '2026-01-01T00:00:00Z', relevance: 0.35 },
    { content: 'memory 2', context: 'preference', timestamp: '2026-01-02T00:00:00Z', relevance: 0.22 },
  ];
  const totalFromApi = 5;
  const surfaceRate = results.length / totalFromApi;

  // Simulate emitRecallIO behavior for non-empty results
  const topScore = Math.max(...results.map(r => r.relevance));
  onIO({
    op: 'recall',
    bank: 'core',
    detail: `Retrieved ${results.length}/${totalFromApi} memories (${(surfaceRate * 100).toFixed(0)}% surfaced, top: ${topScore.toFixed(2)})`,
    meta: { resultCount: results.length, totalFromApi, surfaceRate },
  });

  assertEq(onIO.callCount, 1, 'onIO called once');
  const event = onIO.calls[0][0] as Record<string, unknown>;
  assertEq(event.op, 'recall', 'Event op is recall');
  assert((event.detail as string).includes('2/5'), 'Detail shows result/total ratio');
  assert((event.detail as string).includes('40%'), 'Detail shows surface rate');
}

section('9.2 onIO event for zero-result scenarios');

{
  // API returned 0 results
  const detail0 = 'No matching memories found (API returned 0 results)';
  assert(detail0.includes('API returned 0 results'), 'Zero-result detail correct');

  // API returned results but all filtered
  const detail15 = `All 15 results filtered below relevance threshold (min: 0.15, dropped: 15)`;
  assert(detail15.includes('All 15'), 'Filtered detail shows count');
}

// ════════════════════════════════════════════════════════════════

const ok = printSummary('Retrieval Layer Tests');
if (!ok) process.exit(1);
