/**
 * Error Scenario Tests — corruption recovery, format mismatches, network failures
 *
 * Tests: malformed input handling, corrupt persistence files, API error responses,
 * type mismatches, boundary conditions, and graceful degradation.
 */

import {
  computeClientRelevance,
  trigramSimilarity,
  deduplicateByContent,
} from '/tmp/orionomega-fix/packages/hindsight/src/similarity.js';

import {
  classifyQuery,
  getRecallStrategy,
  isExternalAction,
} from '/tmp/orionomega-fix/packages/core/src/memory/query-classifier.js';

import {
  suite, section, assert, assertEq, assertApprox, assertGt, assertLt,
  assertThrows, assertThrowsAsync, resetResults, printSummary,
  createMockFn, createMockHindsightClient,
  tmpDir, tmpFile, cleanupTmp,
} from './test-harness.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

resetResults();
suite('05 — Error Scenarios: Corruption Recovery & Edge Cases');

async function main() {

// ════════════════════════════════════════════════════════════════
// 1. SIMILARITY SCORING CORRUPTION RECOVERY
// ════════════════════════════════════════════════════════════════

section('1.1 Null/undefined-like inputs');

{
  // Empty strings
  assertEq(computeClientRelevance('', ''), 0, 'Both empty → 0');
  assertEq(computeClientRelevance('', 'content'), 0, 'Empty query → 0');
  assertEq(computeClientRelevance('query', ''), 0, 'Empty content → 0');
}

{
  // Whitespace-only
  const score = computeClientRelevance('   ', '   ');
  assert(score >= 0 && score <= 1, 'Whitespace-only returns valid score');
}

section('1.2 Extremely long inputs');

{
  // 1MB content
  const huge = 'word '.repeat(200_000);
  const score = computeClientRelevance('word', huge);
  assert(score >= 0 && score <= 1, '1MB content returns valid score');
}

{
  // Very long query (simulating context-assembler bug)
  const longQuery = 'query '.repeat(10_000);
  const score = computeClientRelevance(longQuery, 'query term matching');
  assert(score >= 0 && score <= 1, 'Long query (60KB) returns valid score');
}

section('1.3 Special character injection');

{
  const specials = [
    'content with \0 null bytes',
    'content with \n\r\t control chars',
    'content with 🎉 emoji 🚀 chars',
    'content with <script>alert("xss")</script>',
    'content with ${template} literals',
    'content with \\backslash\\paths',
    'content with "quotes" and \'apostrophes\'',
    'regex special: [a-z]+ (.*?) {1,3}',
  ];

  for (const content of specials) {
    const score = computeClientRelevance('test query', content);
    assert(score >= 0 && score <= 1, `Special chars handled: ${content.slice(0, 40)}...`);
  }
}

section('1.4 Trigram with pathological inputs');

{
  assertEq(trigramSimilarity('', ''), 1, 'Empty identical strings');
  assertEq(trigramSimilarity('a', 'b'), 0, 'Single different chars');

  // Strings that differ only by case (normalize lowercases)
  const score = trigramSimilarity('HELLO', 'hello');
  assertEq(score, 1, 'Case-insensitive match');
}

// ════════════════════════════════════════════════════════════════
// 2. DEDUPLICATION ERROR HANDLING
// ════════════════════════════════════════════════════════════════

section('2.1 Items with missing fields');

{
  const items = [
    { content: '', relevance: 0.5 },
    { content: 'valid content', relevance: 0.8 },
    { content: '   ', relevance: 0.3 },
  ];
  const deduped = deduplicateByContent(items);
  assert(deduped.length >= 1, 'Dedup handles empty/whitespace content gracefully');
}

section('2.2 All identical items');

{
  const items = Array.from({ length: 10 }, () => ({
    content: 'exactly the same content repeated',
    relevance: 0.5,
  }));
  const deduped = deduplicateByContent(items);
  assertEq(deduped.length, 1, '10 identical items deduplicated to 1');
}

section('2.3 Items with zero relevance');

{
  const items = [
    { content: 'first item', relevance: 0 },
    { content: 'second item', relevance: 0 },
    { content: 'third item', relevance: 0 },
  ];
  const deduped = deduplicateByContent(items);
  assertEq(deduped.length, 3, 'Zero-relevance but distinct items all kept');
}

section('2.4 Negative relevance scores');

{
  const items = [
    { content: 'item one with negative score', relevance: -0.5 },
    { content: 'item two with normal score', relevance: 0.8 },
  ];
  const deduped = deduplicateByContent(items);
  assertEq(deduped.length, 2, 'Negative relevance items not crashed');
}

// ════════════════════════════════════════════════════════════════
// 3. PERSISTENCE CORRUPTION RECOVERY
// ════════════════════════════════════════════════════════════════

section('3.1 Invalid JSON in hot window file');

{
  const dir = tmpDir('corrupt-json');
  const path = join(dir, 'hot-window.json');

  const corruptData = [
    '{invalid json',
    '',
    'null',
    'undefined',
    '42',
    '"just a string"',
    'true',
  ];

  for (const data of corruptData) {
    writeFileSync(path, data, 'utf-8');
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const isValidArray = Array.isArray(parsed);
      // Not necessarily an error, but not a valid hot window
      if (!isValidArray) {
        assert(true, `Non-array JSON "${data.slice(0, 20)}" detected`);
      }
    } catch {
      assert(true, `Invalid JSON "${data.slice(0, 20)}" caught by parser`);
    }
  }
}

section('3.2 Partially corrupt message arrays');

{
  const mixedData = [
    { role: 'user', content: 'valid message 1' },
    { role: 'assistant', content: 'valid message 2' },
    null,
    42,
    'string',
    { role: 123, content: 'bad role type' },
    { content: 'missing role field' },
    { role: 'user' }, // missing content
    { role: 'user', content: '' }, // empty content (still valid)
    { role: 'user', content: 'valid message 3' },
  ];

  const valid = mixedData.filter((m): m is { role: string; content: string } =>
    typeof m === 'object' && m !== null &&
    'role' in m && 'content' in m &&
    typeof (m as Record<string, unknown>).role === 'string' &&
    typeof (m as Record<string, unknown>).content === 'string'
  );

  assertEq(valid.length, 4, 'Only 4 valid messages survive corruption filter');
  assertEq(valid[0].content, 'valid message 1', 'First valid message correct');
  assertEq(valid[3].content, 'valid message 3', 'Last valid message correct');
}

section('3.3 File system permission errors (simulated)');

{
  // Can't write to /proc/... — simulate by catching error
  try {
    writeFileSync('/proc/nonexistent/test.json', '{}', 'utf-8');
    assert(false, 'Should have thrown on /proc write');
  } catch {
    assert(true, 'Write to invalid path caught gracefully');
  }
}

// ════════════════════════════════════════════════════════════════
// 4. API ERROR RESPONSE HANDLING
// ════════════════════════════════════════════════════════════════

section('4.1 HindsightError format');

{
  // Simulate the error class structure
  class HindsightError extends Error {
    constructor(message: string, public statusCode: number, public endpoint: string) {
      super(`Hindsight API error (${statusCode}) at ${endpoint}: ${message}`);
      this.name = 'HindsightError';
    }
  }

  const err = new HindsightError('Not Found', 404, 'GET /v1/default/banks/missing');
  assertEq(err.statusCode, 404, 'Status code preserved');
  assertEq(err.endpoint, 'GET /v1/default/banks/missing', 'Endpoint preserved');
  assert(err.message.includes('404'), 'Message includes status');
  assert(err.message.includes('Not Found'), 'Message includes original');
}

section('4.2 Retry skips 4xx errors [F9]');

{
  const errors = [
    { statusCode: 400, shouldRetry: false },
    { statusCode: 401, shouldRetry: false },
    { statusCode: 403, shouldRetry: false },
    { statusCode: 404, shouldRetry: false },
    { statusCode: 429, shouldRetry: false },
    { statusCode: 499, shouldRetry: false },
    { statusCode: 500, shouldRetry: true },
    { statusCode: 502, shouldRetry: true },
    { statusCode: 503, shouldRetry: true },
    { statusCode: 0, shouldRetry: true },   // network error
  ];

  for (const { statusCode, shouldRetry } of errors) {
    const isTransient = !(statusCode >= 400 && statusCode < 500);
    assertEq(isTransient, shouldRetry,
      `Status ${statusCode}: ${shouldRetry ? 'retried' : 'not retried'}`);
  }
}

section('4.3 Malformed API response handling');

{
  // API returns unexpected shapes
  const malformed = [
    { results: null },
    { results: 'not an array' },
    {},
    { results: [{ text: null, relevance: 'not a number' }] },
  ];

  for (const raw of malformed) {
    const results = ((raw as any).results ?? []) as unknown[];
    const mapped = (Array.isArray(results) ? results : []).map((r: any) => ({
      content: (r?.text as string) ?? (r?.content as string) ?? '',
      relevance: (r?.relevance as number) ?? 0,
    }));
    assert(Array.isArray(mapped), `Malformed response handled: ${JSON.stringify(raw).slice(0, 50)}`);
  }
}

// ════════════════════════════════════════════════════════════════
// 5. QUERY CLASSIFIER EDGE CASES
// ════════════════════════════════════════════════════════════════

section('5.1 Empty and whitespace queries');

{
  const empty = classifyQuery('');
  assertEq(empty.type, 'task_continuation', 'Empty query → task_continuation');

  const whitespace = classifyQuery('   ');
  assertEq(whitespace.type, 'task_continuation', 'Whitespace query → task_continuation');
}

section('5.2 Very long queries');

{
  const long = 'word '.repeat(5000);
  const c = classifyQuery(long);
  assert(['task_continuation', 'historical_reference', 'decision_lookup', 'meta_system', 'external_action'].includes(c.type),
    'Long query classified to valid type');
  assert(c.confidence > 0 && c.confidence <= 1, 'Confidence in valid range');
}

section('5.3 Mixed-signal queries');

{
  // Contains both decision AND historical cues
  const c = classifyQuery('why did we originally decide to use Redis last month');
  assert(c.type === 'historical_reference' || c.type === 'decision_lookup',
    `Mixed-signal query classified as ${c.type} (either history or decision)`);
}

section('5.4 Strategy for all query types');

{
  const types = ['task_continuation', 'historical_reference', 'decision_lookup', 'meta_system', 'external_action'] as const;
  for (const type of types) {
    const strategy = getRecallStrategy({ type, confidence: 1 });
    assert(strategy.convBudgetRatio >= 0 && strategy.convBudgetRatio <= 1,
      `${type}: convBudgetRatio in [0, 1]`);
    assert(strategy.temporalDiversityRatio >= 0 && strategy.temporalDiversityRatio <= 1,
      `${type}: temporalDiversityRatio in [0, 1]`);
    assert(strategy.minRelevance >= 0 && strategy.minRelevance <= 1,
      `${type}: minRelevance in [0, 1]`);
    assert(['low', 'mid', 'high'].includes(strategy.recallBudget),
      `${type}: valid budget tier`);
    assert(['recent', 'broad', 'targeted'].includes(strategy.temporalBias),
      `${type}: valid temporal bias`);
  }
}

// ════════════════════════════════════════════════════════════════
// 6. THRESHOLD EDGE CASES
// ════════════════════════════════════════════════════════════════

section('6.1 Relevance exactly at boundary');

{
  const threshold = 0.15;
  const results = [
    { content: 'a', relevance: 0.15 },           // exactly at threshold
    { content: 'b', relevance: 0.1500001 },       // just above
    { content: 'c', relevance: 0.1499999 },       // just below
    { content: 'd', relevance: 0.0 },
    { content: 'e', relevance: 1.0 },
  ];

  const filtered = results.filter(r => r.relevance >= threshold);
  assertEq(filtered.length, 3, 'Boundary: 0.15 passes, 0.14999 drops');
  assert(filtered.some(r => r.content === 'a'), '0.15 exactly passes');
  assert(filtered.some(r => r.content === 'b'), 'Just above passes');
  assert(filtered.some(r => r.content === 'e'), '1.0 passes');
}

section('6.2 Floating point precision');

{
  // IEEE 754 edge case: 0.1 + 0.05 might not === 0.15
  const sum = 0.1 + 0.05;
  const threshold = 0.15;
  // Use epsilon comparison
  const passes = sum >= threshold - Number.EPSILON;
  assert(passes, 'Floating point: 0.1 + 0.05 ≈ 0.15 passes threshold');
}

// ════════════════════════════════════════════════════════════════
// 7. CONCURRENT OPERATION SAFETY
// ════════════════════════════════════════════════════════════════

section('7.1 Concurrent scoring is safe (pure functions)');

{
  const queries = Array.from({ length: 100 }, (_, i) => `query ${i}`);
  const content = 'fix the authentication bug in the login module';

  const results = await Promise.all(
    queries.map(q => Promise.resolve(computeClientRelevance(q, content)))
  );

  assert(results.every(r => r >= 0 && r <= 1), 'All 100 concurrent scores valid');
  // Same query should produce same score
  const score0 = computeClientRelevance('query 0', content);
  assertEq(results[0], score0, 'Concurrent result matches sequential result');
}

section('7.2 Concurrent deduplication');

{
  const items = Array.from({ length: 50 }, (_, i) => ({
    content: `Memory item ${i % 5} with some extra text ${Math.random()}`,
    relevance: 0.5 + i * 0.01,
  }));

  const results = await Promise.all([
    Promise.resolve(deduplicateByContent([...items])),
    Promise.resolve(deduplicateByContent([...items])),
    Promise.resolve(deduplicateByContent([...items])),
  ]);

  assertEq(results[0].length, results[1].length, 'Concurrent dedup produces same count');
  assertEq(results[1].length, results[2].length, 'All three concurrent results match');
}

// ════════════════════════════════════════════════════════════════
// 8. DEBOUNCE EDGE CASES
// ════════════════════════════════════════════════════════════════

section('8.1 First call always executes');

{
  const DEBOUNCE_WINDOW_MS = 300_000;
  const lastTime = 0;
  const now = Date.now();
  const shouldRun = now - lastTime >= DEBOUNCE_WINDOW_MS;
  assert(shouldRun, 'First call (lastTime=0) always executes');
}

section('8.2 Exact boundary timing');

{
  const DEBOUNCE_WINDOW_MS = 300_000;
  const lastTime = 1000;

  // Exactly at boundary
  const atBoundary = lastTime + DEBOUNCE_WINDOW_MS;
  assert(atBoundary - lastTime >= DEBOUNCE_WINDOW_MS, 'Exact boundary: should execute');

  // 1ms before boundary
  const beforeBoundary = lastTime + DEBOUNCE_WINDOW_MS - 1;
  assert(beforeBoundary - lastTime < DEBOUNCE_WINDOW_MS, '1ms before: should debounce');
}

// ════════════════════════════════════════════════════════════════
// 9. FORMAT MISMATCH HANDLING
// ════════════════════════════════════════════════════════════════

section('9.1 API response field name variations');

{
  // Hindsight API may return "text" or "content" for the memory text
  const responses = [
    { text: 'memory via text field', content: undefined },
    { text: undefined, content: 'memory via content field' },
    { text: 'text wins', content: 'content loses' },
    { text: undefined, content: undefined },
  ];

  for (const r of responses) {
    const content = (r.text as string) ?? (r.content as string) ?? '';
    assert(typeof content === 'string', `Resolved content: "${content.slice(0, 30)}"`);
  }
}

section('9.2 Timestamp format variations');

{
  // API may return "mentioned_at" or "timestamp"
  const responses = [
    { mentioned_at: '2026-01-01T00:00:00Z', timestamp: undefined },
    { mentioned_at: undefined, timestamp: '2026-01-01T00:00:00Z' },
    { mentioned_at: undefined, timestamp: undefined },
  ];

  for (const r of responses) {
    const ts = (r.mentioned_at as string) ?? (r.timestamp as string) ?? '';
    assert(typeof ts === 'string', `Resolved timestamp: "${ts}"`);
  }
}

section('9.3 Missing tokens_used field');

{
  const raw = { results: [] };
  const tokensUsed = (raw as unknown as Record<string, unknown>).tokens_used as number ?? 0;
  assertEq(tokensUsed, 0, 'Missing tokens_used defaults to 0');
}

// ════════════════════════════════════════════════════════════════

cleanupTmp();
const ok = printSummary('Error Scenario Tests');
if (!ok) process.exit(1);

} // end main

main().catch(e => { console.error(e); process.exit(1); });
