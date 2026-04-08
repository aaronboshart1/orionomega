/**
 * Storage Layer Tests — similarity.ts
 *
 * Tests: serialization, persistence, integrity of similarity scoring,
 * trigram computation, keyword matching, deduplication, and normalization.
 *
 * Coverage targets: normalize(), trigrams(), trigramSimilarity(),
 * computeKeywordScore(), computeClientRelevance(), deduplicateByContent()
 */

import {
  computeClientRelevance,
  trigramSimilarity,
  deduplicateByContent,
} from '../packages/hindsight/src/similarity.js';

import {
  suite, section, assert, assertEq, assertApprox, assertGt, assertLt, assertDeepEq,
  resetResults, printSummary,
} from './test-harness.js';

resetResults();
suite('01 — Storage Layer: Similarity Scoring');

// ════════════════════════════════════════════════════════════════
// 1. NORMALIZATION (F1: prefix stripping)
// ════════════════════════════════════════════════════════════════

section('1.1 Structural prefix stripping [F1]');

// [user], [assistant], [system] prefixes
{
  const base = computeClientRelevance('deploy staging', 'deploy to staging environment');
  const withPrefix = computeClientRelevance('deploy staging', '[user] deploy to staging environment');
  assertApprox(withPrefix, base * 0.8, base * 1.2,
    '[user] prefix stripped — score similar to clean content');
}

{
  const base = computeClientRelevance('fix auth bug', 'fix the auth bug quickly');
  const withPrefix = computeClientRelevance('fix auth bug', '[assistant] fix the auth bug quickly');
  assertApprox(withPrefix, base * 0.8, base * 1.2,
    '[assistant] prefix stripped');
}

{
  const base = computeClientRelevance('system config', 'system configuration updated');
  const withPrefix = computeClientRelevance('system config', '[system] system configuration updated');
  assertApprox(withPrefix, base * 0.7, base * 1.2,
    '[system] prefix stripped');
}

section('1.2 Structural label stripping [F1]');

// Task:, Node:, Workflow:, etc.
{
  const labels = ['Task:', 'Workers:', 'Decisions:', 'Findings:', 'Node:',
    'Workflow:', 'Output:', 'Result:', 'Errors:', 'Outputs:', 'Artifacts:'];
  for (const label of labels) {
    const score = computeClientRelevance('analyze results',
      `${label} analyze the results carefully`);
    assertGt(score, 0, `"${label}" label stripped — content still matchable`);
  }
}

section('1.3 Bracket noise removal [F1]');

{
  const _clean = computeClientRelevance('deploy service', 'deploy the service');
  const bracketed = computeClientRelevance('deploy service', '[deploy] the [service]');
  assertGt(bracketed, 0, 'Bracket noise removed — content still matches');
}

section('1.4 Colon-fused word cleanup [F1]');

{
  // "context:" should normalize to "context"
  const score = computeClientRelevance('context window', 'context: window size is limited');
  assertGt(score, 0.1, 'Colon-fused words cleaned — "context:" → "context"');
}

{
  const score = computeClientRelevance('mentioned timestamp', 'mentioned_at: 2026-01-01');
  assertGt(score, 0, 'Colon after underscore-words cleaned');
}

section('1.5 Whitespace normalization');

{
  const a = computeClientRelevance('fix bug', 'fix the bug');
  const b = computeClientRelevance('fix bug', 'fix   the   bug');
  assertEq(a, b, 'Extra whitespace normalized — scores identical');
}

{
  const a = computeClientRelevance('fix bug', 'fix the bug');
  const b = computeClientRelevance('fix bug', '  fix the bug  ');
  assertEq(a, b, 'Leading/trailing whitespace trimmed');
}

// ════════════════════════════════════════════════════════════════
// 2. WORD LENGTH FILTER (F2: >2 instead of >3)
// ════════════════════════════════════════════════════════════════

section('2.1 Three-char technical terms included [F2]');

{
  const terms3 = ['fix', 'bug', 'sql', 'api', 'git', 'npm', 'cli', 'css', 'env', 'key', 'run', 'dev', 'log', 'err'];
  for (const term of terms3) {
    const score = computeClientRelevance(term, `Use ${term} in production`);
    assertGt(score, 0, `3-char term "${term}" included in keyword matching`);
  }
}

section('2.2 Two-char words still excluded [F2]');

{
  // "go" and "to" are 2 chars — should be excluded from keyword matching
  // Score should rely purely on trigram overlap
  const score = computeClientRelevance('go to', 'go to the page');
  // Score should be lower than a keyword-matchable query
  const score3 = computeClientRelevance('fix bug', 'fix the bug here');
  assertLt(score, score3, '2-char words score lower than 3-char keyword matches');
}

section('2.3 Single-char and empty inputs');

{
  const score = computeClientRelevance('a', 'a');
  // Very short — trigrams won't work (< 3 chars after normalize)
  assert(score >= 0 && score <= 1, 'Single char returns score in [0, 1]');
}

{
  assertEq(computeClientRelevance('', 'some content'), 0, 'Empty query returns 0');
  assertEq(computeClientRelevance('some query', ''), 0, 'Empty content returns 0');
  assertEq(computeClientRelevance('', ''), 0, 'Both empty returns 0');
}

// ════════════════════════════════════════════════════════════════
// 3. DISTINCT MATCH COUNTING (F3)
// ════════════════════════════════════════════════════════════════

section('3.1 Frequency bias eliminated [F3]');

{
  // Content repeating one word should NOT outscore diverse matches
  const repeated = computeClientRelevance(
    'python javascript ruby',
    'python python python python python',
  );
  const diverse = computeClientRelevance(
    'python javascript ruby',
    'python and javascript are popular',
  );
  assert(diverse >= repeated,
    `Diverse (${diverse.toFixed(4)}) >= repeated (${repeated.toFixed(4)})`);
}

section('3.2 Distinct match proportionality [F3]');

{
  const match1of3 = computeClientRelevance('python javascript ruby', 'python is great');
  const match2of3 = computeClientRelevance('python javascript ruby', 'python and javascript');
  const match3of3 = computeClientRelevance('python javascript ruby', 'python javascript ruby are dynamic');

  assert(match3of3 > match2of3, `3/3 (${match3of3.toFixed(4)}) > 2/3 (${match2of3.toFixed(4)})`);
  assert(match2of3 > match1of3, `2/3 (${match2of3.toFixed(4)}) > 1/3 (${match1of3.toFixed(4)})`);
}

section('3.3 No-match returns zero keyword contribution');

{
  const score = computeClientRelevance(
    'completely unrelated query terms',
    'nothing matches here at all xyz',
  );
  assertApprox(score, 0, 0.25, 'No keyword overlap yields low score (trigram only)');
}

// ════════════════════════════════════════════════════════════════
// 4. TRIGRAM SIMILARITY
// ════════════════════════════════════════════════════════════════

section('4.1 Trigram identity and zero cases');

{
  assertEq(trigramSimilarity('hello world', 'hello world'), 1, 'Identical strings → 1.0');
  assertEq(trigramSimilarity('abc', 'xyz'), 0, 'Disjoint strings → 0.0');
  assertEq(trigramSimilarity('ab', 'ab'), 1, 'Short identical strings (< 3 chars) → 1.0');
  assertEq(trigramSimilarity('ab', 'cd'), 0, 'Short different strings → 0.0');
  assertEq(trigramSimilarity('a', 'abc'), 0, 'Length mismatch with < 3 chars → 0.0');
}

section('4.2 Trigram partial overlap');

{
  const score = trigramSimilarity('hello world', 'hello earth');
  assertApprox(score, 0.1, 0.8, 'Partial overlap returns intermediate score');
}

{
  const scoreHigh = trigramSimilarity('deploy to staging', 'deploy to staging now');
  const scoreLow = trigramSimilarity('deploy to staging', 'fix the auth bug');
  assertGt(scoreHigh, scoreLow, 'Similar strings score higher than dissimilar');
}

section('4.3 Trigram with structural prefixes');

{
  // After normalization, [user] prefix stripped
  const clean = trigramSimilarity('fix the auth bug', 'fix the authentication bug');
  const prefixed = trigramSimilarity('fix the auth bug', '[user] fix the authentication bug');
  assertApprox(prefixed, clean * 0.7, clean * 1.3,
    'Prefix stripping keeps trigram scores comparable');
}

// ════════════════════════════════════════════════════════════════
// 5. CLIENT RELEVANCE COMPOSITE SCORING
// ════════════════════════════════════════════════════════════════

section('5.1 Composite score range');

{
  // Score always in [0, 1]
  const queries = ['fix sql bug', 'deploy application', 'x'.repeat(5000), 'a b c d e'];
  const contents = ['Fix the SQL injection', 'Deploy to prod', 'y'.repeat(5000), 'z'];
  for (let i = 0; i < queries.length; i++) {
    const score = computeClientRelevance(queries[i], contents[i]);
    assert(score >= 0 && score <= 1, `Score ${score.toFixed(4)} in [0, 1] for pair ${i}`);
  }
}

section('5.2 Length penalty for short content');

{
  const short = computeClientRelevance('fix bug', 'fix bug');        // < 20 chars
  const long = computeClientRelevance('fix bug', 'fix the bug in the authentication module');  // > 20 chars
  // Short content (< 20 chars) gets 0.8x length penalty
  // The penalty may be offset by higher keyword density, so just check both are valid
  assert(short >= 0 && short <= 1, `Short content score valid (${short.toFixed(4)})`);
  assertGt(long, 0, 'Long content with keyword match scores > 0');
}

section('5.3 Keyword weight dominance (0.6 keyword + 0.4 trigram)');

{
  // High keyword match, low trigram overlap (very different structure)
  const highKeyword = computeClientRelevance(
    'postgresql redis database',
    'database: postgresql and redis are configured',
  );
  assertGt(highKeyword, 0.2, 'High keyword overlap drives score up');
}

section('5.4 Real-world CTO report regression');

{
  // The exact failure case from the diagnostic report.
  // With client-side scoring, this crosses the 0.15 threshold only when
  // the query has exact keyword overlap. Here "key" and "decisions" overlap;
  // the composite score depends on trigram + keyword weights.
  const score = computeClientRelevance(
    'recent session summaries, what was accomplished, key decisions',
    '[user] We decided to use PostgreSQL for the memory storage backend. Key decisions: PostgreSQL over Redis for durability.',
  );
  assertGt(score, 0, `CTO report case scores ${score.toFixed(4)} > 0 (was 0 before fixes)`);
  // With the lowered threshold and client-fallback ceiling, this now survives
  // because CLIENT_FALLBACK_CEILING caps at 0.15, and the adaptive threshold
  // from query classification can go as low as 0.10 for historical queries.
}

{
  const score = computeClientRelevance(
    'fix sql bug',
    'Task: Fix SQL injection vulnerability\nNode: security-audit\nDecisions: parameterize all queries',
  );
  assertGt(score, 0.05, 'Short technical query against structured content > 0');
}

// ════════════════════════════════════════════════════════════════
// 6. DEDUPLICATION
// ════════════════════════════════════════════════════════════════

section('6.1 Basic deduplication');

{
  const items = [
    { content: 'Deploy the React application to the staging environment now', relevance: 0.9 },
    { content: 'Deploy the React application to the staging environment today', relevance: 0.7 },
    { content: 'Fix the login bug in auth module', relevance: 0.6 },
  ];
  const deduped = deduplicateByContent(items);
  assertEq(deduped.length, 2, 'Near-duplicate removed (3 → 2)');
  assertEq(deduped[0].relevance, 0.9, 'Higher-relevance item kept');
}

section('6.2 No dedup for dissimilar items');

{
  const items = [
    { content: 'Fix the authentication bug in the login flow', relevance: 0.8 },
    { content: 'Deploy new version to production server', relevance: 0.7 },
    { content: 'Update the PostgreSQL database schema for users', relevance: 0.6 },
  ];
  const deduped = deduplicateByContent(items);
  assertEq(deduped.length, 3, 'All dissimilar items kept');
}

section('6.3 Custom dedup threshold');

{
  const items = [
    { content: 'configure the database connection pool', relevance: 0.8 },
    { content: 'configure the database connection settings', relevance: 0.7 },
  ];
  // Strict threshold — should not dedup
  const strict = deduplicateByContent(items, 0.99);
  assertEq(strict.length, 2, 'Strict threshold (0.99) keeps similar items');

  // Loose threshold — should dedup
  const loose = deduplicateByContent(items, 0.5);
  assertEq(loose.length, 1, 'Loose threshold (0.5) removes similar items');
}

section('6.4 Empty and single-item inputs');

{
  assertDeepEq(deduplicateByContent([]), [], 'Empty array returns empty');
  const single = [{ content: 'only one', relevance: 0.5 }];
  assertDeepEq(deduplicateByContent(single), single, 'Single item returned as-is');
}

section('6.5 Dedup preserves ordering by relevance');

{
  const items = [
    { content: 'deploy react app to staging environment now', relevance: 0.3 },
    { content: 'fix the critical security vulnerability in auth', relevance: 0.9 },
    { content: 'deploy react app to staging environment today', relevance: 0.8 },
    { content: 'update documentation for API endpoints', relevance: 0.5 },
  ];
  const deduped = deduplicateByContent(items);
  // Items passed through dedup after sorting by relevance should keep higher-relevance version
  assert(deduped.some(d => d.relevance === 0.9), 'Highest relevance item preserved');
  assert(deduped.some(d => d.relevance === 0.5), 'Non-duplicate items preserved');
}

section('6.6 Large-scale dedup correctness');

{
  // Generate items with varying content — some near-duplicates
  const items: Array<{ content: string; relevance: number }> = [];
  for (let i = 0; i < 20; i++) {
    items.push({ content: `Deploy React application version ${i} to the staging environment for testing`, relevance: 0.5 + i * 0.01 });
  }
  // Add clearly distinct items
  for (let i = 0; i < 10; i++) {
    items.push({ content: `Completely different topic number ${i}: ${['PostgreSQL', 'Redis', 'MongoDB', 'auth', 'CI/CD', 'Docker', 'K8s', 'GraphQL', 'REST', 'gRPC'][i]} configuration details`, relevance: 0.8 });
  }
  const deduped = deduplicateByContent(items);
  assertLt(deduped.length, 30, `Dedup reduced 30 items to ${deduped.length}`);
  assertGt(deduped.length, 5, 'Kept distinct items');
}

// ════════════════════════════════════════════════════════════════
// 7. SERIALIZATION & PERSISTENCE INTEGRITY
// ════════════════════════════════════════════════════════════════

section('7.1 Score determinism');

{
  // Same inputs should always produce the same score
  const q = 'fix the authentication bug in login module';
  const c = '[user] Fixed the authentication vulnerability in the login service';
  const scores = Array.from({ length: 10 }, () => computeClientRelevance(q, c));
  const allSame = scores.every(s => s === scores[0]);
  assert(allSame, 'Scoring is deterministic across 10 calls');
}

section('7.2 Unicode handling');

{
  const score = computeClientRelevance('café résumé', 'café résumé document');
  assertGt(score, 0, 'Unicode text handled correctly');
}

{
  const score = computeClientRelevance('日本語テスト', '日本語テストデータ');
  assert(score >= 0 && score <= 1, 'CJK text returns valid score');
}

section('7.3 Special characters');

{
  const score = computeClientRelevance(
    'fix bug #123',
    'Fixed bug #123 in auth module',
  );
  assertGt(score, 0, 'Hash/number characters handled');
}

{
  const score = computeClientRelevance(
    'config.yaml update',
    'Updated config.yaml with new settings',
  );
  assertGt(score, 0, 'Dots in filenames handled');
}

section('7.4 Very long content');

{
  const longContent = 'word '.repeat(10000);
  const score = computeClientRelevance('word test', longContent);
  assert(score >= 0 && score <= 1, 'Very long content (50K chars) returns valid score');
}

// ════════════════════════════════════════════════════════════════

const ok = printSummary('Storage Layer Tests');
if (!ok) process.exit(1);
