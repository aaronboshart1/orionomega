/**
 * Comprehensive validation of all memory storage layer fixes (F1–F14).
 *
 * This script reads the fixed source files and validates that every
 * documented fix has been correctly applied. It serves as both a
 * regression test and a deployment verification checklist.
 */

import { readFileSync } from 'node:fs';

const BASE = '/tmp/orionomega-fix';

function readSource(relPath: string): string {
  return readFileSync(`${BASE}/${relPath}`, 'utf-8');
}

let passed = 0;
let failed = 0;

function check(condition: boolean, fixId: string, description: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ [${fixId}] ${description}`);
  } else {
    failed++;
    console.error(`  ✗ [${fixId}] ${description}`);
  }
}

// ═══════════════════════════════════════════════════════════
// PHASE 1 — CRITICAL FIXES
// ═══════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════');
console.log('Phase 1: CRITICAL FIXES (F1–F4)');
console.log('══════════════════════════════════════════\n');

const similarity = readSource('packages/hindsight/src/similarity.ts');
const client = readSource('packages/hindsight/src/client.ts');

// F1: Strip structural prefixes
check(
  similarity.includes('STRUCTURAL_PREFIX_RE'),
  'F1', 'Structural prefix regex defined',
);
check(
  similarity.includes('STRUCTURAL_LABEL_RE'),
  'F1', 'Structural label regex defined (Task:, Node:, etc.)',
);
check(
  similarity.includes('BRACKET_NOISE_RE'),
  'F1', 'Bracket noise regex defined',
);
check(
  similarity.includes("t.replace(STRUCTURAL_PREFIX_RE, '')"),
  'F1', 'normalize() strips role prefixes ([user], [assistant])',
);
check(
  similarity.includes("t.replace(STRUCTURAL_LABEL_RE, '')"),
  'F1', 'normalize() strips structural labels (Task:, Node:)',
);
check(
  similarity.includes("t.replace(BRACKET_NOISE_RE, '')"),
  'F1', 'normalize() strips bracket characters',
);

// F2: Word length filter
check(
  similarity.includes('w.length > 2'),
  'F2', 'Word length filter lowered to >2',
);
check(
  !similarity.includes('w.length > 3'),
  'F2', 'Old >3 filter removed',
);

// F3: Distinct match counting
check(
  similarity.includes('contentWordSet'),
  'F3', 'Content words stored as Set (for distinct matching)',
);
check(
  similarity.includes('distinctHits'),
  'F3', 'Distinct hit counter used (not raw frequency)',
);
check(
  !similarity.includes('let hits = 0'),
  'F3', 'Old frequency-based hits counter removed',
);
check(
  similarity.includes('for (const w of queryWords)'),
  'F3', 'Iterates query words against content set (not content against query)',
);

// F4: Threshold calibration
check(
  client.includes("opts?.minRelevance ?? 0.15"),
  'F4', 'Default minRelevance lowered to 0.15',
);
check(
  !client.includes("opts?.minRelevance ?? 0.3"),
  'F4', 'Old 0.3 threshold removed from recall()',
);

// ═══════════════════════════════════════════════════════════
// PHASE 2 — HIGH PRIORITY FIXES
// ═══════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════');
console.log('Phase 2: HIGH PRIORITY FIXES (F5–F7)');
console.log('══════════════════════════════════════════\n');

const bridge = readSource('packages/core/src/agent/memory-bridge.ts');

// F5: Temporal parameter name
check(
  client.includes('body.query_timestamp = opts.before'),
  'F5', 'Temporal param sent as query_timestamp',
);
check(
  !client.includes('body.before = opts.before'),
  'F5', 'Old body.before assignment removed',
);

// F6: Query truncation
check(
  client.includes('MAX_QUERY_LENGTH = 4000'),
  'F6', 'MAX_QUERY_LENGTH constant defined',
);
check(
  client.includes('query.slice(0, MAX_QUERY_LENGTH)'),
  'F6', 'Query truncation applied',
);
check(
  client.includes('query: effectiveQuery'),
  'F6', 'Truncated query used in request body',
);

// F7: Mental model seeding
check(
  bridge.includes('seedMentalModelsIfNeeded'),
  'F7', 'seedMentalModelsIfNeeded method defined',
);
check(
  bridge.includes("modelId: 'user-profile'"),
  'F7', 'Seeds user-profile model',
);
check(
  bridge.includes("modelId: 'session-context'"),
  'F7', 'Seeds session-context model',
);
check(
  bridge.includes("modelId: 'infra-map'"),
  'F7', 'Seeds infra-map model',
);
check(
  bridge.includes('getMentalModel(bankId, modelId)'),
  'F7', 'Checks existence before seeding',
);
check(
  bridge.includes('refreshMentalModel(bankId, modelId)'),
  'F7', 'Creates via refresh if missing',
);

// ═══════════════════════════════════════════════════════════
// PHASE 3 — MEDIUM PRIORITY FIXES
// ═══════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════');
console.log('Phase 3: MEDIUM PRIORITY FIXES (F9–F14)');
console.log('══════════════════════════════════════════\n');

const summary = readSource('packages/core/src/memory/session-summary.ts');
const assembler = readSource('packages/core/src/memory/context-assembler.ts');

// F9: Retry with backoff
check(
  summary.includes('MAX_RETRIES = 3'),
  'F9', 'Retry max attempts defined',
);
check(
  summary.includes('INITIAL_BACKOFF_MS = 500'),
  'F9', 'Initial backoff defined',
);
check(
  summary.includes('Math.pow(2, attempt)'),
  'F9', 'Exponential backoff formula present',
);
check(
  summary.includes('withRetry('),
  'F9', 'withRetry helper used',
);
check(
  summary.includes('status >= 400 && status < 500'),
  'F9', '4xx errors not retried',
);

// F10: Log differentiation
check(
  client.includes('API returned 0 results'),
  'F10', '"No results from API" message present',
);
check(
  client.includes('results filtered below relevance threshold'),
  'F10', '"All filtered" message present',
);
check(
  !client.includes("detail: 'No matching memories found'"),
  'F10', 'Old ambiguous message removed',
);

// F11: Budget alignment
check(
  assembler.includes('DEFAULT_RECALL_BUDGET = 8_192'),
  'F11', 'Recall budget aligned to API tier cap (8192)',
);
check(
  !assembler.includes('DEFAULT_RECALL_BUDGET = 30_000'),
  'F11', 'Old 30,000 budget removed',
);
check(
  assembler.includes('config.minRelevance ?? 0.15'),
  'F11', 'Context assembler minRelevance aligned to 0.15',
);

// F14: Debounce
check(
  summary.includes('DEBOUNCE_WINDOW_MS = 5 * 60 * 1000'),
  'F14', 'Debounce window defined at 5 minutes',
);
check(
  summary.includes('lastSummaryTime'),
  'F14', 'Debounce state tracking present',
);
check(
  summary.includes('debounce window active'),
  'F14', 'Debounce skip is logged',
);

// ═══════════════════════════════════════════════════════════
// CROSS-CUTTING VALIDATION
// ═══════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════');
console.log('Cross-cutting: Consistency Checks');
console.log('══════════════════════════════════════════\n');

// All files referencing 0.3 as default relevance should be updated
check(
  !assembler.includes('config.minRelevance ?? 0.3'),
  'CROSS', 'No 0.3 default in context-assembler.ts',
);
check(
  bridge.includes('relevanceFloor: 0.15'),
  'CROSS', 'Bootstrap config relevanceFloor aligned to 0.15',
);

// Backward compatibility: RecallOptions.before still accepted
check(
  client.includes("opts?.before"),
  'COMPAT', 'RecallOptions.before still accepted as input',
);

// ═══════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════');
console.log(`RESULTS: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log('══════════════════════════════════════════\n');

if (failed > 0) {
  process.exit(1);
}
