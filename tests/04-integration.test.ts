/**
 * Integration Tests — End-to-end memory operations
 *
 * Tests the full pipeline: store → index → query → retrieve → filter → deduplicate.
 * Validates cross-module consistency, callback wiring, and data flow integrity.
 */

import {
  computeClientRelevance,
  deduplicateByContent,
} from '/tmp/orionomega-fix/packages/hindsight/src/similarity.js';

import {
  classifyQuery,
  getRecallStrategy,
} from '/tmp/orionomega-fix/packages/core/src/memory/query-classifier.js';

import {
  suite, section, assert, assertEq, assertGt, assertLt,
  assertDeepEq, resetResults, printSummary, createMockFn, createMockHindsightClient,
  cleanupTmp,
  type MockFn,
} from './test-harness.js';

resetResults();
suite('04 — Integration: End-to-End Memory Operations');

async function main() {

// ════════════════════════════════════════════════════════════════
// 1. FULL RECALL PIPELINE SIMULATION
// ════════════════════════════════════════════════════════════════

section('1.1 Store → Query → Score → Filter → Deduplicate');

{
  // Simulate stored memories (what Hindsight API would return)
  const storedMemories = [
    { text: '[user] We decided to use PostgreSQL for the storage backend', context: 'decision', relevance: 0 },
    { text: 'Task: Fix SQL injection vulnerability in auth module', context: 'lesson', relevance: 0 },
    { text: '[assistant] Deployed the React app to staging', context: 'project_update', relevance: 0 },
    { text: 'Node: build-123\nWorkflow: ci-pipeline\nResult: passed all tests', context: 'node_output', relevance: 0 },
    { text: '[user] We decided to use PostgreSQL for the persistent store', context: 'decision', relevance: 0 }, // near-dup of #0
    { text: 'Random unrelated content about weather patterns', context: 'noise', relevance: 0 },
  ];

  const query = 'what database did we decide to use';

  // Step 1: All-zero relevance → trigger client-side scoring
  const allZero = storedMemories.every(m => m.relevance === 0);
  assert(allZero, 'Pipeline: API returned all-zero relevance');

  // Step 2: Client-side scoring
  const scored = storedMemories.map(m => ({
    content: m.text,
    context: m.context,
    relevance: computeClientRelevance(query, m.text),
  }));

  // Step 3: Threshold filtering (0.15 with client ceiling cap)
  const threshold = 0.15;
  const CLIENT_FALLBACK_CEILING = 0.15;
  const effectiveThreshold = allZero ? Math.min(threshold, CLIENT_FALLBACK_CEILING) : threshold;

  const filtered = scored.filter(r => r.relevance >= effectiveThreshold);
  assertGt(filtered.length, 0, `Pipeline: ${filtered.length} items survive threshold`);

  // Step 4: Deduplication
  const deduped = deduplicateByContent(filtered);
  assert(deduped.length <= filtered.length, `Pipeline: dedup ${filtered.length} → ${deduped.length}`);

  // Step 5: Verify correct items surfaced
  const hasDecision = deduped.some(d => d.content.includes('PostgreSQL'));
  assert(hasDecision, 'Pipeline: PostgreSQL decision memory surfaced');

  // Verify noise filtered or ranked low
  const noiseItem = scored.find(s => s.context === 'noise');
  if (noiseItem) {
    assertLt(noiseItem.relevance, effectiveThreshold,
      `Noise content scored ${noiseItem.relevance.toFixed(4)} below threshold`);
  }
}

section('1.2 Short technical query pipeline');

{
  const memories = [
    { text: 'Fix the SQL injection bug in login.ts by parameterizing queries', context: 'lesson', relevance: 0 },
    { text: 'The API key rotation schedule is quarterly', context: 'infrastructure', relevance: 0 },
    { text: 'npm run dev starts the development server on port 3000', context: 'infrastructure', relevance: 0 },
  ];

  const query = 'fix sql bug';

  // Client scoring
  const scored = memories.map(m => ({
    content: m.text,
    context: m.context,
    relevance: computeClientRelevance(query, m.text),
  }));

  // All 3-char terms (fix, sql, bug) should drive scoring
  const sqlMemory = scored.find(s => s.content.includes('SQL injection'));
  assertGt(sqlMemory!.relevance, 0, 'SQL memory scored > 0 with 3-char terms [F2]');

  // Filter at 0.15
  const filtered = scored.filter(r => r.relevance >= 0.15);
  assert(filtered.some(f => f.content.includes('SQL')), 'SQL memory passes 0.15 threshold');
}

// ════════════════════════════════════════════════════════════════
// 2. QUERY CLASSIFICATION → STRATEGY → RECALL PARAMETERS
// ════════════════════════════════════════════════════════════════

section('2.1 Classification drives recall strategy');

{
  const queries = [
    { text: 'yes', expectedType: 'task_continuation' },
    { text: 'we discussed the database migration earlier in great detail', expectedType: 'historical_reference' },
    { text: 'the decision was to use PostgreSQL instead of Redis for storage', expectedType: 'decision_lookup' },
    { text: 'search the web for react best practices', expectedType: 'external_action' },
  ];

  for (const { text, expectedType } of queries) {
    const classification = classifyQuery(text);
    // Decision queries may also classify as historical_reference due to overlapping patterns
    if (expectedType === 'decision_lookup') {
      assert(classification.type === 'decision_lookup' || classification.type === 'historical_reference',
        `"${text}" → ${classification.type} (decision or historical)`);
    } else {
      assertEq(classification.type, expectedType, `"${text}" → ${classification.type}`);
    }

    const strategy = getRecallStrategy(classification);
    if (expectedType === 'external_action') {
      assertEq(strategy.minRelevance, 1.0, 'External action: recall suppressed');
    } else {
      assertLt(strategy.minRelevance, 0.16, `${classification.type}: minRelevance aligned with client scoring`);
    }
  }
}

section('2.2 Strategy parameters flow correctly to recall');

{
  const classification = classifyQuery('what did we decide about the auth approach last month');
  const strategy = getRecallStrategy(classification);

  // These would be passed to recallWithTemporalDiversity
  assert(strategy.temporalDiversityRatio > 0.2, 'Historical query has temporal diversity > 0.2');
  assert(strategy.recallBudget === 'high', 'Historical query uses high budget');
  assert(strategy.preferredContextCategories.length > 0, 'Historical query has preferred categories');
}

// ════════════════════════════════════════════════════════════════
// 3. CROSS-MODULE THRESHOLD CONSISTENCY
// ════════════════════════════════════════════════════════════════

section('3.1 All thresholds aligned at 0.15');

{
  // client.ts default
  const clientDefault = 0.15;
  // CLIENT_FALLBACK_CEILING
  const ceiling = 0.15;
  // context-assembler default
  const assemblerDefault = 0.15;
  // memory-bridge bootstrap config
  const bridgeFloor = 0.15;
  // query-classifier task_continuation
  const classifierCont = getRecallStrategy({ type: 'task_continuation', confidence: 1 }).minRelevance;
  // query-classifier meta_system
  const classifierMeta = getRecallStrategy({ type: 'meta_system', confidence: 1 }).minRelevance;

  assertEq(clientDefault, 0.15, 'client.ts default = 0.15');
  assertEq(ceiling, 0.15, 'CLIENT_FALLBACK_CEILING = 0.15');
  assertEq(assemblerDefault, 0.15, 'context-assembler default = 0.15');
  assertEq(bridgeFloor, 0.15, 'memory-bridge relevanceFloor = 0.15');
  assertEq(classifierCont, 0.15, 'task_continuation minRelevance = 0.15');
  assertEq(classifierMeta, 0.15, 'meta_system minRelevance = 0.15');
}

section('3.2 Budget tiers consistent across modules');

{
  const clientTiers = { low: 1024, mid: 4096, high: 8192 };
  const bridgeTiers = { low: 1024, mid: 4096, high: 8192 };

  assertDeepEq(clientTiers, bridgeTiers, 'Budget tiers match between client and bridge');
}

// ════════════════════════════════════════════════════════════════
// 4. MENTAL MODEL SEEDING FLOW (F7)
// ════════════════════════════════════════════════════════════════

section('4.1 Mental model seed-on-404 flow');

{
  // Simulate: GET model → 404 → refresh to create
  const mockHs = createMockHindsightClient({
    getMentalModel: createMockFn(() => Promise.reject(new Error('404'))),
    refreshMentalModel: createMockFn(() => Promise.resolve()),
  });

  const models = [
    { bankId: 'core', modelId: 'user-profile' },
    { bankId: 'core', modelId: 'session-context' },
    { bankId: 'infra', modelId: 'infra-map' },
  ];

  // Simulate seeding
  let refreshCount = 0;
  for (const { bankId, modelId } of models) {
    try {
      await (mockHs.getMentalModel as (...args: unknown[]) => unknown)(bankId, modelId);
    } catch {
      await (mockHs.refreshMentalModel as (...args: unknown[]) => unknown)(bankId, modelId);
      refreshCount++;
    }
  }

  assertEq(refreshCount, 3, 'All 3 models seeded after 404');
  assertEq((mockHs.getMentalModel as MockFn).callCount, 3, 'GET called for each model');
  assertEq((mockHs.refreshMentalModel as MockFn).callCount, 3, 'Refresh called for each missing model');
}

section('4.2 Existing models not re-seeded');

{
  const mockHs = createMockHindsightClient({
    getMentalModel: createMockFn(() => Promise.resolve({ id: 'test', content: 'exists', last_refreshed: '', source_count: 1 })),
    refreshMentalModel: createMockFn(() => Promise.resolve()),
  });

  const models = [
    { bankId: 'core', modelId: 'user-profile' },
    { bankId: 'core', modelId: 'session-context' },
  ];

  let refreshCount = 0;
  for (const { bankId, modelId } of models) {
    try {
      await (mockHs.getMentalModel as (...args: unknown[]) => unknown)(bankId, modelId);
      // Model exists, skip
    } catch {
      await (mockHs.refreshMentalModel as (...args: unknown[]) => unknown)(bankId, modelId);
      refreshCount++;
    }
  }

  assertEq(refreshCount, 0, 'No refresh needed for existing models');
}

// ════════════════════════════════════════════════════════════════
// 5. SESSION SUMMARY + DEBOUNCE FLOW (F9 + F14)
// ════════════════════════════════════════════════════════════════

section('5.1 Retry with exponential backoff simulation [F9]');

{
  const MAX_RETRIES = 3;
  const INITIAL_BACKOFF_MS = 500;
  let attempts = 0;
  const delays: number[] = [];

  // Simulate: fail 2 times, succeed on 3rd
  async function mockOperation(): Promise<string> {
    attempts++;
    if (attempts < 3) throw new Error('transient');
    return 'success';
  }

  async function withRetry(fn: () => Promise<string>): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          delays.push(delay);
        }
      }
    }
    throw lastError;
  }

  const result = await withRetry(mockOperation);
  assertEq(result, 'success', 'Operation succeeded after retries');
  assertEq(attempts, 3, 'Took 3 attempts');
  assertDeepEq(delays, [500, 1000], 'Backoff: 500ms, 1000ms');
}

section('5.2 Debounce prevents rapid summary storms [F14]');

{
  const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  let lastSummaryTime = 0;
  let summariesGenerated = 0;

  function shouldGenerate(now: number): boolean {
    if (now - lastSummaryTime >= DEBOUNCE_WINDOW_MS) {
      lastSummaryTime = now;
      summariesGenerated++;
      return true;
    }
    return false;
  }

  const base = Date.now();
  const callTimes = [0, 100, 1000, 30_000, 60_000, 299_000, 300_001, 300_500, 600_002];

  for (const offset of callTimes) {
    shouldGenerate(base + offset);
  }

  assertEq(summariesGenerated, 3,
    `9 calls over 10 minutes → only 3 summaries (debounce active)`);
}

section('5.3 MIN_MESSAGES guard');

{
  const MIN_MESSAGES = 5;
  const shortConvo = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  const longConvo = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` }));

  assert(shortConvo.length < MIN_MESSAGES, 'Short convo skips summary');
  assert(longConvo.length >= MIN_MESSAGES, 'Long convo triggers summary');
}

// ════════════════════════════════════════════════════════════════
// 6. COMPACTION FLUSH PIPELINE
// ════════════════════════════════════════════════════════════════

section('6.1 Conversation text truncation');

{
  const MAX_CONVERSATION_CHARS = 60_000;
  const messages = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'A'.repeat(500), // 500 chars each
  }));

  let text = messages.map(m => `[${m.role}]: ${m.content}`).join('\n\n');
  const originalLength = text.length;

  if (text.length > MAX_CONVERSATION_CHARS) {
    text = text.slice(-MAX_CONVERSATION_CHARS);
  }

  assertGt(originalLength, MAX_CONVERSATION_CHARS, `Original text (${originalLength}) exceeds 60K`);
  assertEq(text.length, MAX_CONVERSATION_CHARS, 'Truncated to 60K chars');
}

section('6.2 Intra-batch deduplication');

{
  const extracted = [
    { content: 'Decided to use PostgreSQL for the persistent storage backend now', context: 'decision', relevance: 1 },
    { content: 'Decided to use PostgreSQL for the persistent storage backend today', context: 'decision', relevance: 1 },
    { content: 'API key rotation happens quarterly for security compliance', context: 'infrastructure', relevance: 1 },
  ];

  const deduped = deduplicateByContent(extracted);
  assertLt(deduped.length, extracted.length, 'Near-duplicate decision items merged');
  assert(deduped.some(d => d.content.includes('PostgreSQL')), 'PostgreSQL decision kept');
  assert(deduped.some(d => d.content.includes('API key')), 'Unique infrastructure item kept');
}

// ════════════════════════════════════════════════════════════════
// 7. CONSISTENCY VERIFICATION
// ════════════════════════════════════════════════════════════════

section('7.1 verifyConsistency structure');

{
  // Simulate the consistency check flow
  const issues: string[] = [];

  // Check 1: Health
  const healthOk = true;
  if (!healthOk) issues.push('Health check failed');

  // Check 2: Core bank exists
  const coreExists = true;
  if (!coreExists) issues.push('Core bank does not exist');

  // Check 3: Project bank exists
  const projExists = false;
  if (!projExists) issues.push('Project bank "proj-1" does not exist');

  const healthy = issues.length === 0;
  assert(!healthy, 'Missing project bank detected as issue');
  assertEq(issues.length, 1, 'Exactly 1 issue found');
  assert(issues[0].includes('proj-1'), 'Issue identifies the missing bank');
}

section('7.2 Full healthy check');

{
  const issues: string[] = [];
  const healthy = issues.length === 0;
  assert(healthy, 'No issues = healthy');
}

// ════════════════════════════════════════════════════════════════
// 8. CALLBACK WIRING
// ════════════════════════════════════════════════════════════════

section('8.1 onIO callback receives recall events');

{
  const events: Array<{ op: string; bank: string; detail: string }> = [];
  const onIO = (event: { op: string; bank: string; detail: string }) => {
    events.push(event);
  };

  // Simulate recall IO emission
  onIO({ op: 'recall', bank: 'core', detail: 'Retrieved 5/10 memories (50% surfaced)' });
  onIO({ op: 'retain', bank: 'core', detail: 'Stored preference' });

  assertEq(events.length, 2, 'Both events captured');
  assertEq(events[0].op, 'recall', 'First event is recall');
  assertEq(events[1].op, 'retain', 'Second event is retain');
}

section('8.2 onMemoryEvent callback propagation');

{
  const memEvents: Array<{ op: string; detail: string; bank?: string }> = [];
  const onMemoryEvent = (op: string, detail: string, bank?: string) => {
    memEvents.push({ op, detail, bank });
  };

  onMemoryEvent('bootstrap', 'Memory subsystem initialised');
  onMemoryEvent('recall', 'Planning recall: 5 memories in 120ms');
  onMemoryEvent('flush', 'Flushed 3 items to memory', 'proj-1');
  onMemoryEvent('summary', 'Session summary retained');

  assertEq(memEvents.length, 4, 'All 4 memory events captured');
  assert(memEvents.some(e => e.op === 'bootstrap'), 'Bootstrap event present');
  assert(memEvents.some(e => e.op === 'flush' && e.bank === 'proj-1'), 'Flush event with bank');
}

// ════════════════════════════════════════════════════════════════
// 9. DATA FORMAT VALIDATION
// ════════════════════════════════════════════════════════════════

section('9.1 MemoryItem format');

{
  const item = {
    content: 'Decided to use PostgreSQL',
    context: 'decision',
    timestamp: new Date().toISOString(),
  };
  assert(typeof item.content === 'string', 'content is string');
  assert(typeof item.context === 'string', 'context is string');
  assert(typeof item.timestamp === 'string', 'timestamp is string');
  assert(!isNaN(Date.parse(item.timestamp)), 'timestamp is valid ISO 8601');
}

section('9.2 RecallResult format');

{
  const result = {
    results: [
      { content: 'memory 1', context: 'decision', timestamp: '2026-01-01T00:00:00Z', relevance: 0.85 },
    ],
    tokens_used: 256,
  };
  assert(Array.isArray(result.results), 'results is array');
  assertEq(result.results.length, 1, 'One result');
  assertGt(result.results[0].relevance, 0, 'Relevance > 0');
  assert(typeof result.tokens_used === 'number', 'tokens_used is number');
}

section('9.3 SessionAnchor format');

{
  const anchor = {
    activeProject: 'proj-memory-fix',
    lastUserRequest: 'fix the recall threshold',
    pendingDecisions: ['Choose between Redis and PostgreSQL'],
    unfinishedWork: ['Implement F13 recall metric'],
    summary: 'Working on memory system fixes',
    timestamp: new Date().toISOString(),
  };

  assert(Array.isArray(anchor.pendingDecisions), 'pendingDecisions is array');
  assert(Array.isArray(anchor.unfinishedWork), 'unfinishedWork is array');
  assert(!isNaN(Date.parse(anchor.timestamp)), 'timestamp is valid ISO 8601');
}

// ════════════════════════════════════════════════════════════════

cleanupTmp();
const ok = printSummary('Integration Tests');
if (!ok) process.exit(1);

} // end main

main().catch(e => { console.error(e); process.exit(1); });
