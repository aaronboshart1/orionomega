/**
 * Performance Benchmarks
 *
 * Measures throughput and latency for critical memory operations:
 * similarity scoring, deduplication, query classification, and data serialization.
 * Establishes baseline performance expectations for regression detection.
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
  suite, section, assert, assertGt, assertLt,
  resetResults, printSummary, bench,
} from './test-harness.js';

resetResults();
suite('06 — Performance Benchmarks');

// ════════════════════════════════════════════════════════════════
// 1. SIMILARITY SCORING BENCHMARKS
// ════════════════════════════════════════════════════════════════

section('1.1 trigramSimilarity throughput');

{
  const a = 'Fix the authentication bug in the login flow for production users';
  const b = 'Fixed authentication vulnerability in the user login service endpoint';

  const result = bench('trigramSimilarity (short strings)', () => {
    trigramSimilarity(a, b);
  }, 10_000);

  assertGt(result.opsPerSec, 5_000, 'trigramSimilarity: > 5K ops/s');
}

{
  const a = 'word '.repeat(500);
  const b = 'word '.repeat(500).replace(/word/g, (_, i) => i > 1000 ? 'diff' : 'word');

  const result = bench('trigramSimilarity (2.5KB strings)', () => {
    trigramSimilarity(a, b);
  }, 1_000);

  assertGt(result.opsPerSec, 100, 'trigramSimilarity (long): > 100 ops/s');
}

section('1.2 computeClientRelevance throughput');

{
  const query = 'fix sql bug in authentication module';
  const content = '[user] Fix the SQL injection vulnerability in auth service login.ts';

  const result = bench('computeClientRelevance (typical)', () => {
    computeClientRelevance(query, content);
  }, 10_000);

  assertGt(result.opsPerSec, 5_000, 'computeClientRelevance: > 5K ops/s');
}

{
  const query = 'recent session summaries, what was accomplished, key decisions and outcomes';
  const content = '[user] We decided to use PostgreSQL for the memory storage backend. Key decisions: PostgreSQL over Redis for durability. Session summary: completed migration.';

  const result = bench('computeClientRelevance (real-world)', () => {
    computeClientRelevance(query, content);
  }, 10_000);

  assertGt(result.opsPerSec, 3_000, 'Real-world scoring: > 3K ops/s');
}

section('1.3 Scoring with structural prefixes');

{
  const query = 'fix the database connection issue';
  const content = 'Task: Fix database connectivity\nNode: db-migration\nWorkflow: deploy-pipeline\nResult: connection pool reconfigured';

  const result = bench('computeClientRelevance (structured)', () => {
    computeClientRelevance(query, content);
  }, 10_000);

  assertGt(result.opsPerSec, 3_000, 'Structured content scoring: > 3K ops/s');
}

// ════════════════════════════════════════════════════════════════
// 2. DEDUPLICATION BENCHMARKS
// ════════════════════════════════════════════════════════════════

section('2.1 Deduplication — small batches');

{
  const items = Array.from({ length: 10 }, (_, i) => ({
    content: `Memory item ${i}: Fix the authentication bug in module ${i % 3}`,
    relevance: 0.5 + i * 0.05,
  }));

  const result = bench('deduplicateByContent (10 items)', () => {
    deduplicateByContent([...items]);
  }, 5_000);

  assertGt(result.opsPerSec, 500, 'Dedup 10 items: > 500 ops/s');
}

section('2.2 Deduplication — medium batches');

{
  const items = Array.from({ length: 50 }, (_, i) => ({
    content: `Memory item ${i}: detailed content about topic ${i % 10} with extra words for length ${i}`,
    relevance: 0.3 + i * 0.01,
  }));

  const result = bench('deduplicateByContent (50 items)', () => {
    deduplicateByContent([...items]);
  }, 500);

  assertGt(result.opsPerSec, 20, 'Dedup 50 items: > 20 ops/s');
}

section('2.3 Deduplication — large batches with duplicates');

{
  const items: Array<{ content: string; relevance: number }> = [];
  for (let i = 0; i < 50; i++) {
    items.push({
      content: `Unique memory about topic ${i} with specific details and context`,
      relevance: 0.5 + i * 0.01,
    });
    // Add near-duplicate
    items.push({
      content: `Unique memory about topic ${i} with specific details and data`,
      relevance: 0.3 + i * 0.01,
    });
  }

  const result = bench('deduplicateByContent (100 items, 50% dups)', () => {
    deduplicateByContent([...items]);
  }, 200);

  assertGt(result.opsPerSec, 5, 'Dedup 100 items with dups: > 5 ops/s');
}

// ════════════════════════════════════════════════════════════════
// 3. QUERY CLASSIFICATION BENCHMARKS
// ════════════════════════════════════════════════════════════════

section('3.1 classifyQuery throughput');

{
  const queries = [
    'yes',
    'fix the bug in auth module',
    'what did we decide about the database last week',
    'search the web for react docs',
    'how does the memory system work',
    'why did we choose PostgreSQL over Redis for the storage backend',
  ];

  let idx = 0;
  const result = bench('classifyQuery (mixed queries)', () => {
    classifyQuery(queries[idx % queries.length]);
    idx++;
  }, 10_000);

  assertGt(result.opsPerSec, 10_000, 'classifyQuery: > 10K ops/s');
}

section('3.2 getRecallStrategy throughput');

{
  const types = ['task_continuation', 'historical_reference', 'decision_lookup', 'meta_system', 'external_action'] as const;
  let idx = 0;

  const result = bench('getRecallStrategy (all types)', () => {
    getRecallStrategy({ type: types[idx % types.length], confidence: 0.8 });
    idx++;
  }, 50_000);

  assertGt(result.opsPerSec, 100_000, 'getRecallStrategy: > 100K ops/s');
}

section('3.3 isExternalAction throughput');

{
  const queries = [
    'search the web for react docs',
    'npm install express',
    'fix the bug',
    'curl https://api.example.com',
    'what did we decide',
  ];
  let idx = 0;

  const result = bench('isExternalAction (mixed)', () => {
    isExternalAction(queries[idx % queries.length]);
    idx++;
  }, 10_000);

  assertGt(result.opsPerSec, 10_000, 'isExternalAction: > 10K ops/s');
}

// ════════════════════════════════════════════════════════════════
// 4. SERIALIZATION BENCHMARKS
// ════════════════════════════════════════════════════════════════

section('4.1 Hot window serialization');

{
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}: ${'x'.repeat(200)}`,
    timestamp: new Date().toISOString(),
  }));

  const result = bench('JSON.stringify (20 messages)', () => {
    JSON.stringify(messages);
  }, 10_000);

  assertGt(result.opsPerSec, 10_000, 'Hot window serialize: > 10K ops/s');
}

{
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}: ${'x'.repeat(200)}`,
    timestamp: new Date().toISOString(),
  }));
  const json = JSON.stringify(messages);

  const result = bench('JSON.parse (20 messages)', () => {
    JSON.parse(json);
  }, 10_000);

  assertGt(result.opsPerSec, 10_000, 'Hot window deserialize: > 10K ops/s');
}

section('4.2 Token estimation');

{
  const texts = [
    'short',
    'medium length text with several words in it',
    'A'.repeat(10_000),
    'B'.repeat(100_000),
  ];
  let idx = 0;

  const result = bench('estimateTokens (mixed)', () => {
    Math.ceil(texts[idx % texts.length].length / 4);
    idx++;
  }, 100_000);

  assertGt(result.opsPerSec, 1_000_000, 'Token estimation: > 1M ops/s');
}

// ════════════════════════════════════════════════════════════════
// 5. FULL PIPELINE BENCHMARKS
// ════════════════════════════════════════════════════════════════

section('5.1 Full recall pipeline (classify → score → filter → dedup)');

{
  const memories = Array.from({ length: 20 }, (_, i) => ({
    content: `Memory item ${i}: Fix the authentication bug in module ${i % 5} with detailed context about the issue`,
    context: ['decision', 'lesson', 'preference', 'infrastructure', 'project_update'][i % 5],
    relevance: 0,
  }));

  const query = 'what decisions did we make about authentication';

  const result = bench('full recall pipeline (20 items)', () => {
    // 1. Classify
    const classification = classifyQuery(query);
    const strategy = getRecallStrategy(classification);

    // 2. Client-side score
    const scored = memories.map(m => ({
      ...m,
      relevance: computeClientRelevance(query, m.content),
    }));

    // 3. Filter
    const filtered = scored.filter(r => r.relevance >= strategy.minRelevance);

    // 4. Dedup
    deduplicateByContent(filtered);
  }, 2_000);

  assertGt(result.opsPerSec, 500, 'Full pipeline (20 items): > 500 ops/s');
  assertLt(result.p95Ms, 10, 'Full pipeline p95 < 10ms');
}

section('5.2 Batch scoring (100 items)');

{
  const query = 'fix the sql injection vulnerability in the authentication module';
  const items = Array.from({ length: 100 }, (_, i) => ({
    content: `[user] Memory ${i}: ${'word '.repeat(20 + i % 30)}`,
    relevance: 0,
  }));

  const result = bench('batch score 100 items', () => {
    for (const item of items) {
      item.relevance = computeClientRelevance(query, item.content);
    }
  }, 500);

  assertGt(result.opsPerSec, 50, 'Batch score 100 items: > 50 ops/s');
}

// ════════════════════════════════════════════════════════════════
// 6. NORMALIZATION COST
// ════════════════════════════════════════════════════════════════

section('6.1 Prefix stripping overhead');

{
  const clean = 'Fix the authentication bug in the login service module';
  const prefixed = '[user] Task: Fix the authentication bug in the login service module\nNode: auth-fix\nWorkflow: bugfix-pipeline';

  const cleanResult = bench('score (clean content)', () => {
    computeClientRelevance('fix auth bug', clean);
  }, 10_000);

  const prefixedResult = bench('score (prefixed content)', () => {
    computeClientRelevance('fix auth bug', prefixed);
  }, 10_000);

  // Prefix stripping should add < 50% overhead
  const overhead = (prefixedResult.avgMs - cleanResult.avgMs) / cleanResult.avgMs;
  assertLt(overhead, 0.5, `Prefix stripping overhead: ${(overhead * 100).toFixed(0)}% (< 50%)`);
}

// ════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════

const ok = printSummary('Performance Benchmarks');
if (!ok) process.exit(1);
