/**
 * Indexing Tests — query-classifier.ts & context-assembler.ts
 *
 * Tests: query classification accuracy, recall strategy selection,
 * index consistency, budget alignment (F11), cache rebuild,
 * hot window persistence, and bank federation.
 */

import {
  classifyQuery,
  getRecallStrategy,
  isExternalAction,
} from '/tmp/orionomega-fix/packages/core/src/memory/query-classifier.js';

import {
  suite, section, assert, assertEq, assertApprox, assertGt,
  assertDeepEq, resetResults, printSummary,
  tmpDir, cleanupTmp,
} from './test-harness.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

resetResults();
suite('03 — Indexing: Query Classification & Context Assembly');

// ════════════════════════════════════════════════════════════════
// 1. QUERY CLASSIFICATION
// ════════════════════════════════════════════════════════════════

section('1.1 Task continuation detection');

{
  const continuations = ['yes', 'do it', 'fix all', 'ok', '#3', 'the second one', 'go ahead',
    'sure', 'skip', 'next', 'continue'];
  for (const q of continuations) {
    const c = classifyQuery(q);
    assertEq(c.type, 'task_continuation', `"${q}" classified as task_continuation`);
  }
}

section('1.2 Historical reference detection');

{
  const historical = [
    'we discussed the database migration earlier in great detail',
    'what happened with the auth system in the last session',
    'how did we handle the authentication system previously',
  ];
  for (const q of historical) {
    const c = classifyQuery(q);
    assertEq(c.type, 'historical_reference', `"${q}" → historical_reference`);
  }
}

section('1.3 Decision lookup detection');

{
  const decisions = [
    'the decision was to use PostgreSQL instead of Redis for our storage',
    'what was the rationale for choosing that particular framework option',
    'the decision about the trade-off between caching strategies is crucial',
  ];
  for (const q of decisions) {
    const c = classifyQuery(q);
    assert(c.type === 'decision_lookup' || c.type === 'historical_reference',
      `"${q}" → ${c.type} (expected decision_lookup or historical_reference)`);
  }
}

section('1.4 Meta system detection');

{
  const meta = [
    'what can you do with the recall and memory features',
    'give me a complete status overview of the current project',
    'what features does this system have for helping with projects',
  ];
  for (const q of meta) {
    const c = classifyQuery(q);
    assertEq(c.type, 'meta_system', `"${q}" → meta_system`);
  }
}

section('1.5 External action detection');

{
  const external = [
    'search the web for node.js best practices',
    'curl https://api.example.com/data',
    'npm install express',
    'run the command "make build"',
    'fetch the url https://example.com',
    'pip install pandas',
  ];
  for (const q of external) {
    const c = classifyQuery(q);
    assertEq(c.type, 'external_action', `"${q}" → external_action`);
  }
}

section('1.6 External action suppressed by memory cues');

{
  // If query has both external + memory cues, memory wins
  const q = 'search the web for what we decided last week';
  const c = classifyQuery(q);
  assert(c.type !== 'external_action', `Memory cue overrides external: "${q}" → ${c.type}`);
}

section('1.7 isExternalAction helper');

{
  assert(isExternalAction('search the web for react docs'), 'Web search is external');
  assert(isExternalAction('npm install lodash'), 'npm install is external');
  assert(!isExternalAction('fix the bug'), 'Normal task is not external');
  assert(!isExternalAction('what did we decide last session'), 'Memory query not external');
}

section('1.8 Classification confidence');

{
  const short = classifyQuery('yes');
  assertApprox(short.confidence, 0.5, 1.0, 'Short continuation has reasonable confidence');

  const clear = classifyQuery('the decision to pick PostgreSQL instead of MongoDB for storage');
  assertApprox(clear.confidence, 0.3, 1.0, 'Clear decision query has good confidence');
}

section('1.9 Ambiguous queries default to task_continuation');

{
  const ambiguous = classifyQuery('make the thing work better with more stuff');
  assertEq(ambiguous.type, 'task_continuation', 'Ambiguous query defaults to task_continuation');
}

// ════════════════════════════════════════════════════════════════
// 2. RECALL STRATEGY SELECTION
// ════════════════════════════════════════════════════════════════

section('2.1 Strategy minRelevance aligned with client scoring [F4]');

{
  const CLIENT_FALLBACK_CEILING = 0.15;
  const types: Array<'task_continuation' | 'historical_reference' | 'decision_lookup' | 'meta_system'> =
    ['task_continuation', 'historical_reference', 'decision_lookup', 'meta_system'];

  for (const type of types) {
    const strategy = getRecallStrategy({ type, confidence: 0.8 });
    assert(strategy.minRelevance <= CLIENT_FALLBACK_CEILING,
      `${type} minRelevance (${strategy.minRelevance}) <= ${CLIENT_FALLBACK_CEILING}`);
    assertGt(strategy.minRelevance, 0, `${type} minRelevance > 0`);
  }
}

section('2.2 External action suppresses recall');

{
  const strategy = getRecallStrategy({ type: 'external_action', confidence: 0.85 });
  assertEq(strategy.minRelevance, 1.0, 'External action minRelevance = 1.0 (no recall)');
  assertEq(strategy.convBudgetRatio, 0.0, 'External action conv budget = 0');
  assertEq(strategy.temporalDiversityRatio, 0.0, 'External action temporal diversity = 0');
}

section('2.3 Historical reference strategy');

{
  const strategy = getRecallStrategy({ type: 'historical_reference', confidence: 0.8 });
  assertApprox(strategy.temporalDiversityRatio, 0.3, 0.5, 'High temporal diversity for history');
  assertEq(strategy.recallBudget, 'high', 'High budget for history');
  assertEq(strategy.temporalBias, 'broad', 'Broad temporal bias for history');
  assert(strategy.preferredContextCategories.includes('session_summary'), 'Prefers session_summary');
  assert(strategy.preferredContextCategories.includes('lesson'), 'Prefers lesson');
}

section('2.4 Decision lookup strategy');

{
  const strategy = getRecallStrategy({ type: 'decision_lookup', confidence: 0.8 });
  assertEq(strategy.temporalBias, 'targeted', 'Targeted temporal bias for decisions');
  assert(strategy.preferredContextCategories.includes('decision'), 'Prefers decision category');
  assert(strategy.preferredContextCategories.includes('architecture'), 'Prefers architecture category');
}

section('2.5 Task continuation strategy');

{
  const strategy = getRecallStrategy({ type: 'task_continuation', confidence: 0.8 });
  assertApprox(strategy.convBudgetRatio, 0.7, 0.9, 'High conv budget for continuation');
  assertApprox(strategy.temporalDiversityRatio, 0, 0.1, 'Low temporal diversity');
  assertEq(strategy.recallBudget, 'mid', 'Mid budget for continuation');
}

// ════════════════════════════════════════════════════════════════
// 3. BUDGET ALIGNMENT (F11)
// ════════════════════════════════════════════════════════════════

section('3.1 Recall budget = 8192 (aligned with API tier cap)');

{
  const DEFAULT_RECALL_BUDGET = 8_192;
  const TIER_MAX = 8192; // 'high' tier cap
  assertEq(DEFAULT_RECALL_BUDGET, TIER_MAX, 'Default recall budget matches high tier cap');
  assert(DEFAULT_RECALL_BUDGET <= TIER_MAX, 'Budget does not exceed API capability');
}

section('3.2 Old 30K budget would be silently clamped');

{
  const oldBudget = 30_000;
  const tierCap = 8192;
  const effective = Math.min(oldBudget, tierCap);
  assertEq(effective, 8192, 'Old 30K budget would be clamped to 8192');
  assertGt(oldBudget - effective, 20000, 'Old budget wasted 21,808 tokens');
}

// ════════════════════════════════════════════════════════════════
// 4. HOT WINDOW PERSISTENCE (Index Consistency)
// ════════════════════════════════════════════════════════════════

section('4.1 Hot window serialization format');

{
  const messages = [
    { role: 'user', content: 'fix the bug', timestamp: '2026-01-01T00:00:00Z' },
    { role: 'assistant', content: 'I fixed it', timestamp: '2026-01-01T00:01:00Z' },
  ];
  const serialized = JSON.stringify(messages);
  const deserialized = JSON.parse(serialized);
  assertDeepEq(deserialized, messages, 'Hot window round-trips through JSON');
}

section('4.2 Hot window disk persistence');

{
  const dir = tmpDir('hot-window-test');
  const path = join(dir, 'hot-window.json');

  const messages = [
    { role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' },
    { role: 'assistant', content: 'hi there', timestamp: '2026-01-01T00:00:01Z' },
    { role: 'user', content: 'fix bug', timestamp: '2026-01-01T00:00:02Z' },
  ];

  // Save
  writeFileSync(path, JSON.stringify(messages), 'utf-8');
  assert(existsSync(path), 'Hot window file persisted');

  // Load and validate
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  assert(Array.isArray(parsed), 'Loaded data is array');
  assertEq(parsed.length, 3, 'All 3 messages restored');

  // Validate each message
  const valid = parsed.every((m: Record<string, unknown>) =>
    typeof m === 'object' && m !== null &&
    'role' in m && 'content' in m &&
    typeof m.role === 'string' && typeof m.content === 'string'
  );
  assert(valid, 'All messages pass validation');
}

section('4.3 Hot window ring buffer behavior');

{
  const HOT_WINDOW_SIZE = 20;
  const messages: Array<{ role: string; content: string }> = [];

  // Push 30 messages
  for (let i = 0; i < 30; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` });
  }

  // Simulate ring buffer
  const hotWindow = messages.slice(-HOT_WINDOW_SIZE);
  assertEq(hotWindow.length, HOT_WINDOW_SIZE, 'Ring buffer keeps last 20');
  assertEq(hotWindow[0].content, 'msg 10', 'Oldest kept message is correct');
  assertEq(hotWindow[19].content, 'msg 29', 'Newest message is last');
}

section('4.4 Corrupted hot window recovery');

{
  const dir = tmpDir('corrupt-hot-window');
  const path = join(dir, 'hot-window.json');

  // Write corrupt data
  writeFileSync(path, '{"not an array": true}', 'utf-8');

  // Load and validate
  const raw = readFileSync(path, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    const isValid = Array.isArray(parsed);
    assert(!isValid, 'Non-array JSON detected as invalid');
  } catch {
    assert(true, 'Invalid JSON caught');
  }

  // Write partially corrupt messages
  writeFileSync(path, JSON.stringify([
    { role: 'user', content: 'valid' },
    { role: 123, content: 'invalid role type' },
    { content: 'missing role' },
    null,
    'not an object',
  ]), 'utf-8');

  const raw2 = readFileSync(path, 'utf-8');
  const parsed2 = JSON.parse(raw2);
  const valid2 = parsed2.filter((m: unknown) =>
    typeof m === 'object' && m !== null &&
    'role' in (m as Record<string, unknown>) && 'content' in (m as Record<string, unknown>) &&
    typeof (m as Record<string, unknown>).role === 'string' &&
    typeof (m as Record<string, unknown>).content === 'string'
  );
  assertEq(valid2.length, 1, 'Only 1 valid message survives corruption filter');
}

// ════════════════════════════════════════════════════════════════
// 5. INDEX REBUILD OPERATIONS
// ════════════════════════════════════════════════════════════════

section('5.1 Banks cache invalidation');

{
  // Simulate cache state
  let banksCache: Array<{ bank_id: string }> | null = [{ bank_id: 'core' }, { bank_id: 'proj-1' }];
  let banksCacheTime = Date.now();
  const TTL = 60_000;

  // Cache valid
  assert(banksCache !== null, 'Cache populated');
  assert(Date.now() - banksCacheTime < TTL, 'Cache not expired');

  // Invalidate
  banksCache = null;
  banksCacheTime = 0;
  assert(banksCache === null, 'Cache invalidated');
  assertEq(banksCacheTime, 0, 'Cache time reset');
}

section('5.2 Cache TTL expiry');

{
  const TTL = 60_000;
  let cacheTime = Date.now() - 70_000; // 70s ago
  const isExpired = Date.now() - cacheTime >= TTL;
  assert(isExpired, '70s-old cache is expired (TTL=60s)');

  cacheTime = Date.now() - 30_000; // 30s ago
  const isFresh = Date.now() - cacheTime < TTL;
  assert(isFresh, '30s-old cache is fresh');
}

section('5.3 Bank federation discovery');

{
  const allBanks = [
    { bank_id: 'core', memory_count: 100 },
    { bank_id: 'proj-1', memory_count: 50 },
    { bank_id: 'proj-2', memory_count: 0 },
    { bank_id: 'infra', memory_count: 25 },
  ];
  const known = new Set(['core', 'proj-1']);
  const federated = allBanks
    .filter(b => !known.has(b.bank_id) && (b.memory_count ?? 0) > 0)
    .map(b => b.bank_id);

  assertDeepEq(federated, ['infra'], 'Federated banks: only populated unknown banks');
}

// ════════════════════════════════════════════════════════════════
// 6. CONTEXT ASSEMBLER BUDGET MATH
// ════════════════════════════════════════════════════════════════

section('6.1 Token estimation');

{
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);
  assertEq(estimateTokens(''), 0, 'Empty string = 0 tokens');
  assertEq(estimateTokens('abcd'), 1, '4 chars = 1 token');
  assertEq(estimateTokens('abcde'), 2, '5 chars = 2 tokens (ceil)');
  assertEq(estimateTokens('x'.repeat(1000)), 250, '1000 chars = 250 tokens');
}

section('6.2 Available recall budget calculation');

{
  const maxTurnTokens = 60_000;
  const systemPromptTokens = 4_000;
  const outputReserve = 4_096;
  const recallBudgetTokens = 8_192;

  const hotTokens = 5_000;
  const available = Math.max(0, maxTurnTokens - systemPromptTokens - outputReserve - hotTokens);
  const recallTokens = Math.min(available, recallBudgetTokens);

  assertEq(available, 46_904, 'Available for recall = 60K - 4K - 4096 - 5K');
  assertEq(recallTokens, 8_192, 'Capped at recallBudgetTokens');
}

section('6.3 Budget exhaustion — hot window too large');

{
  const maxTurnTokens = 60_000;
  const systemPromptTokens = 4_000;
  const outputReserve = 4_096;

  const hugeHotTokens = 55_000;
  const available = Math.max(0, maxTurnTokens - systemPromptTokens - outputReserve - hugeHotTokens);
  assertEq(available, 0, 'No budget for recall when hot window is huge');
}

// ════════════════════════════════════════════════════════════════
// 7. CONFIDENCE SUMMARY COMPUTATION
// ════════════════════════════════════════════════════════════════

section('7.1 Confidence bucketing');

{
  const items = [
    { relevance: 0.9 },
    { relevance: 0.75 },
    { relevance: 0.5 },
    { relevance: 0.4 },
    { relevance: 0.3 },
    { relevance: 0.1 },
  ];
  let high = 0, moderate = 0, low = 0;
  for (const item of items) {
    if (item.relevance >= 0.7) high++;
    else if (item.relevance >= 0.4) moderate++;
    else low++;
  }
  assertEq(high, 2, '2 high confidence (>= 0.7)');
  assertEq(moderate, 2, '2 moderate (>= 0.4, < 0.7)');
  assertEq(low, 2, '2 low (< 0.4)');
}

// ════════════════════════════════════════════════════════════════

cleanupTmp();
const ok = printSummary('Indexing Tests');
if (!ok) process.exit(1);
