/**
 * Tests for similarity.ts fixes (F1, F2, F3).
 *
 * These tests validate that the memory recall scoring pipeline correctly
 * handles structural prefixes, short technical terms, and distinct matching.
 */

// We test the functions directly by importing from the fixed file.
// In a real test runner these would use the project's test framework.
// Here we use a lightweight assertion approach for portability.

import { computeClientRelevance, trigramSimilarity, deduplicateByContent } from '../packages/hindsight/src/similarity.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

function assertApprox(actual: number, min: number, max: number, message: string): void {
  if (actual < min || actual > max) {
    throw new Error(`FAIL: ${message} — expected ${min}–${max}, got ${actual.toFixed(4)}`);
  }
  console.log(`  PASS: ${message} (${actual.toFixed(4)})`);
}

// ─────────────────────────────────────────────────────────
// F1: Structural prefix stripping
// ─────────────────────────────────────────────────────────

console.log('\n=== F1: Structural Prefix Stripping ===');

{
  // "[user] fix the bug" should match "Fixed the SQL bug in login.ts"
  const score = computeClientRelevance('fix the bug', '[user] fix the bug in auth');
  assertApprox(score, 0.2, 1.0, '[user] prefix stripped — query matches stored content');
}

{
  // "Task: analyze" prefix should not pollute matching
  const score = computeClientRelevance('analyze code', 'Task: analyze the codebase for issues');
  assertApprox(score, 0.15, 1.0, 'Task: prefix stripped — analyze matches');
}

{
  // "Decisions:" label stripped — content words should match without colon pollution
  // Note: "decisions" ≠ "decided" (no stemming), so use content with exact word
  const score = computeClientRelevance('decisions made', 'Decisions: important decisions were made about React');
  assertApprox(score, 0.15, 1.0, 'Decisions: prefix stripped — decisions and made both match');
}

{
  // Brackets stripped: "[assistant]" doesn't pollute
  const score = computeClientRelevance('deploy the service', '[assistant] Deploy the service to staging');
  assertApprox(score, 0.2, 1.0, '[assistant] prefix stripped');
}

{
  // After stripping "Node:", "Workflow:", "Result:" labels, content words
  // (not the labels themselves) remain matchable.
  const score = computeClientRelevance('completed successfully micro', 'Node: micro-abc123\nWorkflow: wf-456\nResult: completed successfully');
  assertApprox(score, 0.05, 1.0, 'Content words matchable after label stripping');
}

// ─────────────────────────────────────────────────────────
// F2: Word length filter (>2 instead of >3)
// ─────────────────────────────────────────────────────────

console.log('\n=== F2: Short Technical Term Inclusion ===');

{
  // "fix sql bug" — all 3-char words, previously queryWords.size === 0
  const score = computeClientRelevance('fix sql bug', 'Fixed the SQL injection bug in login.ts');
  assert(score > 0, '"fix sql bug" now returns score > 0 (was 0 with >3 filter)');
  assertApprox(score, 0.1, 1.0, '3-char technical terms included in matching');
}

{
  // "api key" — both terms are 3 chars
  const score = computeClientRelevance('api key', 'Store the API key in environment variables');
  assert(score > 0, '"api key" returns score > 0');
}

{
  // "git log" — short dev terms
  const score = computeClientRelevance('git log', 'Use git log to check recent commits');
  assert(score > 0, '"git log" returns score > 0');
}

{
  // "npm run dev" — mix of 3-char and longer
  const score = computeClientRelevance('npm run dev', 'Run npm run dev to start the development server');
  assert(score > 0, '"npm run dev" returns score > 0');
}

{
  // 2-char words should still be excluded (too much noise)
  // "go to" — "go" and "to" are 2 chars, should be filtered
  const scoreShort = computeClientRelevance('go to', 'go to the settings page');
  // This should rely purely on trigram similarity, not keyword matching
  console.log(`  INFO: "go to" score = ${scoreShort.toFixed(4)} (2-char words excluded, trigram only)`);
}

// ─────────────────────────────────────────────────────────
// F3: Distinct keyword match counting
// ─────────────────────────────────────────────────────────

console.log('\n=== F3: Distinct Match Counting ===');

{
  // Content repeating "python" 5× should NOT outscore content matching 2/3 query words
  const repeating = computeClientRelevance(
    'python javascript ruby',
    'python python python python python is great',
  );
  const diverse = computeClientRelevance(
    'python javascript ruby',
    'python and javascript are popular languages',
  );
  assert(diverse >= repeating,
    `Diverse match (${diverse.toFixed(4)}) >= repeated match (${repeating.toFixed(4)})`);
}

{
  // 1 out of 3 query words matched = ~0.33 keyword score
  const score1of3 = computeClientRelevance(
    'python javascript ruby',
    'python is a great language for data science',
  );
  // 3 out of 3 query words matched = 1.0 keyword score
  const score3of3 = computeClientRelevance(
    'python javascript ruby',
    'python javascript and ruby are all dynamic languages',
  );
  assert(score3of3 > score1of3,
    `3/3 match (${score3of3.toFixed(4)}) > 1/3 match (${score1of3.toFixed(4)})`);
}

{
  // Frequency no longer inflates — "python python python" vs query "python javascript ruby"
  // Should score 1/3 (one distinct match), not 3/3 or 1.0
  const score = computeClientRelevance(
    'python javascript ruby',
    'python python python is repeated many times',
  );
  // keywordScore should be ~0.33 (1 distinct match / 3 query words)
  // composite = 0.33 * 0.6 + trigram * 0.4
  assertApprox(score, 0.05, 0.5, 'Repeated word correctly scores as 1 distinct match');
}

// ─────────────────────────────────────────────────────────
// Regression: deduplication still works
// ─────────────────────────────────────────────────────────

console.log('\n=== Regression: Deduplication ===');

{
  const items = [
    { content: 'Deploy the React application to the staging environment now', relevance: 0.8 },
    { content: 'Deploy the React application to the staging environment today', relevance: 0.7 },
    { content: 'Fix the login bug in auth module', relevance: 0.6 },
  ];
  const deduped = deduplicateByContent(items);
  assert(deduped.length <= 2, `Dedup removed near-duplicate (${deduped.length} items remain)`);
}

{
  const score = trigramSimilarity('hello world', 'hello world');
  assert(score === 1, 'Identical strings return similarity 1.0');
}

{
  const score = trigramSimilarity('abc', 'xyz');
  assert(score === 0, 'Completely different strings return similarity 0');
}

// ─────────────────────────────────────────────────────────
// Combined: End-to-end scoring with all fixes
// ─────────────────────────────────────────────────────────

console.log('\n=== End-to-End: Combined Fix Validation ===');

{
  // Simulates the exact failure from the CTO report:
  // Query: "recent session summaries, what was accomplished, key decisions"
  // Content: "[user] We decided to use PostgreSQL for the memory storage backend"
  const score = computeClientRelevance(
    'recent session summaries, what was accomplished, key decisions',
    '[user] We decided to use PostgreSQL for the memory storage backend. Key decisions: PostgreSQL over Redis for durability.',
  );
  // With all fixes, this should score > 0.15 (the new threshold)
  assert(score >= 0.15,
    `Real-world query scores ${score.toFixed(4)} >= 0.15 threshold (would have been dropped before)`);
}

{
  // Another real-world case: short technical query against structured content
  const score = computeClientRelevance(
    'fix sql bug',
    'Task: Fix SQL injection vulnerability\nNode: security-audit\nDecisions: parameterize all queries',
  );
  assert(score > 0.05, `Technical query against structured content scores ${score.toFixed(4)} > 0`);
}

console.log('\n✓ All similarity.ts tests passed\n');
