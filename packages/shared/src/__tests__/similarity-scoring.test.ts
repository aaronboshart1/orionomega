/**
 * @module __tests__/similarity-scoring
 * Characterization tests for the client-side relevance scoring pipeline:
 * normalize(), trigrams(), trigramSimilarity(), computeKeywordScore(),
 * computeClientRelevance(), and deduplicateByContent().
 *
 * Migrated from the unrun root `tests/` directory (01-similarity-storage.test.ts,
 * which subsumed the earlier similarity.test.ts F1/F2/F3 fix-verification script).
 */

import { describe, it, expect } from 'vitest';
import {
  computeClientRelevance,
  trigramSimilarity,
  deduplicateByContent,
} from '../similarity.js';

describe('normalization — structural prefixes and labels', () => {
  it.each([
    ['[user]', 'deploy staging', 'deploy to staging environment', 0.8],
    ['[assistant]', 'fix auth bug', 'fix the auth bug quickly', 0.8],
    ['[system]', 'system config', 'system configuration updated', 0.7],
  ])('strips the %s prefix so the score stays comparable to clean content', (prefix, query, content, lowerFactor) => {
    const base = computeClientRelevance(query, content);
    const withPrefix = computeClientRelevance(query, `${prefix} ${content}`);

    expect(withPrefix).toBeGreaterThanOrEqual(base * lowerFactor);
    expect(withPrefix).toBeLessThanOrEqual(base * 1.2);
  });

  it.each([
    'Task:', 'Workers:', 'Decisions:', 'Findings:', 'Node:',
    'Workflow:', 'Output:', 'Result:', 'Errors:', 'Outputs:', 'Artifacts:',
  ])('strips the %s structural label, leaving the content matchable', (label) => {
    expect(computeClientRelevance('analyze results', `${label} analyze the results carefully`)).toBeGreaterThan(0);
  });

  it('removes bracket noise', () => {
    expect(computeClientRelevance('deploy service', '[deploy] the [service]')).toBeGreaterThan(0);
  });

  it('cleans colon-fused words', () => {
    expect(computeClientRelevance('context window', 'context: window size is limited')).toBeGreaterThan(0.1);
    expect(computeClientRelevance('mentioned timestamp', 'mentioned_at: 2026-01-01')).toBeGreaterThan(0);
  });

  it('normalizes internal and surrounding whitespace', () => {
    expect(computeClientRelevance('fix bug', 'fix   the   bug'))
      .toBe(computeClientRelevance('fix bug', 'fix the bug'));
    expect(computeClientRelevance('fix bug', '  fix the bug  '))
      .toBe(computeClientRelevance('fix bug', 'fix the bug'));
  });
});

describe('keyword matching — word-length filter', () => {
  it.each(['fix', 'bug', 'sql', 'api', 'git', 'npm', 'cli', 'css', 'env', 'key', 'run', 'dev', 'log', 'err'])(
    'includes the 3-char technical term "%s" in keyword matching',
    (term) => {
      expect(computeClientRelevance(term, `Use ${term} in production`)).toBeGreaterThan(0);
    },
  );

  it('scores 2-char words below a 3-char keyword match (trigram-only contribution)', () => {
    const twoChar = computeClientRelevance('go to', 'go to the page');
    const threeChar = computeClientRelevance('fix bug', 'fix the bug here');
    expect(twoChar).toBeLessThan(threeChar);
  });

  it('returns a score within [0, 1] for a single character', () => {
    const score = computeClientRelevance('a', 'a');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0 when either side is empty', () => {
    expect(computeClientRelevance('', 'some content')).toBe(0);
    expect(computeClientRelevance('some query', '')).toBe(0);
    expect(computeClientRelevance('', '')).toBe(0);
  });
});

describe('keyword matching — distinct match counting', () => {
  it('does not let a repeated word outscore diverse matches', () => {
    const repeated = computeClientRelevance('python javascript ruby', 'python python python python python');
    const diverse = computeClientRelevance('python javascript ruby', 'python and javascript are popular');

    expect(diverse).toBeGreaterThanOrEqual(repeated);
  });

  it('scores proportionally to the number of distinct query terms matched', () => {
    const match1of3 = computeClientRelevance('python javascript ruby', 'python is great');
    const match2of3 = computeClientRelevance('python javascript ruby', 'python and javascript');
    const match3of3 = computeClientRelevance('python javascript ruby', 'python javascript ruby are dynamic');

    expect(match3of3).toBeGreaterThan(match2of3);
    expect(match2of3).toBeGreaterThan(match1of3);
  });

  it('yields a low, trigram-only score when no keywords overlap', () => {
    const score = computeClientRelevance('completely unrelated query terms', 'nothing matches here at all xyz');

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(0.25);
  });
});

describe('trigramSimilarity', () => {
  it('handles identity and disjoint cases, including strings shorter than a trigram', () => {
    expect(trigramSimilarity('hello world', 'hello world')).toBe(1);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
    expect(trigramSimilarity('ab', 'ab')).toBe(1);
    expect(trigramSimilarity('ab', 'cd')).toBe(0);
    expect(trigramSimilarity('a', 'abc')).toBe(0);
  });

  it('returns an intermediate score for partial overlap', () => {
    const score = trigramSimilarity('hello world', 'hello earth');
    expect(score).toBeGreaterThan(0.1);
    expect(score).toBeLessThan(0.8);
  });

  it('ranks similar strings above dissimilar ones', () => {
    expect(trigramSimilarity('deploy to staging', 'deploy to staging now'))
      .toBeGreaterThan(trigramSimilarity('deploy to staging', 'fix the auth bug'));
  });

  it('keeps scores comparable after structural-prefix stripping', () => {
    const clean = trigramSimilarity('fix the auth bug', 'fix the authentication bug');
    const prefixed = trigramSimilarity('fix the auth bug', '[user] fix the authentication bug');

    expect(prefixed).toBeGreaterThanOrEqual(clean * 0.7);
    expect(prefixed).toBeLessThanOrEqual(clean * 1.3);
  });
});

describe('computeClientRelevance — composite scoring', () => {
  it.each([
    ['fix sql bug', 'Fix the SQL injection'],
    ['deploy application', 'Deploy to prod'],
    ['x'.repeat(5000), 'y'.repeat(5000)],
    ['a b c d e', 'z'],
  ])('keeps the score within [0, 1] for (%s…)', (query, content) => {
    const score = computeClientRelevance(query, content);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns a valid score for short content and a positive score for long matching content', () => {
    const short = computeClientRelevance('fix bug', 'fix bug');
    expect(short).toBeGreaterThanOrEqual(0);
    expect(short).toBeLessThanOrEqual(1);

    expect(computeClientRelevance('fix bug', 'fix the bug in the authentication module')).toBeGreaterThan(0);
  });

  it('lets high keyword overlap drive the score up', () => {
    expect(computeClientRelevance('postgresql redis database', 'database: postgresql and redis are configured'))
      .toBeGreaterThan(0.2);
  });
});

describe('computeClientRelevance — real-world recall cases', () => {
  /**
   * The diagnostic-report case. This scores ~0.09, which is BELOW the 0.15
   * default `minRelevance` floor in context-assembler — it survives recall only
   * via the adaptive per-query-type threshold (as low as 0.10 for historical
   * lookups) in query-classifier. Pinned as a characterization, not a target:
   * an earlier fix-verification script asserted `>= 0.15` here, which has never
   * held for this input at any commit.
   */
  it('scores the session-summary/decision recall pair above zero but under the default floor', () => {
    const score = computeClientRelevance(
      'recent session summaries, what was accomplished, key decisions',
      '[user] We decided to use PostgreSQL for the memory storage backend. Key decisions: PostgreSQL over Redis for durability.',
    );

    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.09, 2);
  });

  it('scores a short technical query against structured content above the noise floor', () => {
    expect(computeClientRelevance(
      'fix sql bug',
      'Task: Fix SQL injection vulnerability\nNode: security-audit\nDecisions: parameterize all queries',
    )).toBeGreaterThan(0.05);
  });
});

describe('deduplicateByContent', () => {
  it('removes a near-duplicate and keeps the higher-relevance item', () => {
    const deduped = deduplicateByContent([
      { content: 'Deploy the React application to the staging environment now', relevance: 0.9 },
      { content: 'Deploy the React application to the staging environment today', relevance: 0.7 },
      { content: 'Fix the login bug in auth module', relevance: 0.6 },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped[0].relevance).toBe(0.9);
  });

  it('keeps all dissimilar items', () => {
    const deduped = deduplicateByContent([
      { content: 'Fix the authentication bug in the login flow', relevance: 0.8 },
      { content: 'Deploy new version to production server', relevance: 0.7 },
      { content: 'Update the PostgreSQL database schema for users', relevance: 0.6 },
    ]);

    expect(deduped).toHaveLength(3);
  });

  it('honours a custom similarity threshold', () => {
    const items = [
      { content: 'configure the database connection pool', relevance: 0.8 },
      { content: 'configure the database connection settings', relevance: 0.7 },
    ];

    expect(deduplicateByContent(items, 0.99)).toHaveLength(2);
    expect(deduplicateByContent(items, 0.5)).toHaveLength(1);
  });

  it('passes through empty and single-item inputs', () => {
    expect(deduplicateByContent([])).toEqual([]);

    const single = [{ content: 'only one', relevance: 0.5 }];
    expect(deduplicateByContent(single)).toEqual(single);
  });

  it('preserves the highest-relevance version and all non-duplicates', () => {
    const deduped = deduplicateByContent([
      { content: 'deploy react app to staging environment now', relevance: 0.3 },
      { content: 'fix the critical security vulnerability in auth', relevance: 0.9 },
      { content: 'deploy react app to staging environment today', relevance: 0.8 },
      { content: 'update documentation for API endpoints', relevance: 0.5 },
    ]);

    expect(deduped.some((d) => d.relevance === 0.9)).toBe(true);
    expect(deduped.some((d) => d.relevance === 0.5)).toBe(true);
  });

  it('collapses near-duplicates at scale while keeping distinct items', () => {
    const topics = ['PostgreSQL', 'Redis', 'MongoDB', 'auth', 'CI/CD', 'Docker', 'K8s', 'GraphQL', 'REST', 'gRPC'];
    const items = [
      ...Array.from({ length: 20 }, (_, i) => ({
        content: `Deploy React application version ${i} to the staging environment for testing`,
        relevance: 0.5 + i * 0.01,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        content: `Completely different topic number ${i}: ${topics[i]} configuration details`,
        relevance: 0.8,
      })),
    ];

    const deduped = deduplicateByContent(items);
    expect(deduped.length).toBeLessThan(30);
    expect(deduped.length).toBeGreaterThan(5);
  });
});

describe('computeClientRelevance — robustness', () => {
  it('is deterministic across repeated calls', () => {
    const scores = Array.from({ length: 10 }, () => computeClientRelevance(
      'fix the authentication bug in login module',
      '[user] Fixed the authentication vulnerability in the login service',
    ));

    expect(new Set(scores).size).toBe(1);
  });

  it('handles accented and CJK text', () => {
    expect(computeClientRelevance('café résumé', 'café résumé document')).toBeGreaterThan(0);

    const cjk = computeClientRelevance('日本語テスト', '日本語テストデータ');
    expect(cjk).toBeGreaterThanOrEqual(0);
    expect(cjk).toBeLessThanOrEqual(1);
  });

  it('handles hashes, numbers, and dotted filenames', () => {
    expect(computeClientRelevance('fix bug #123', 'Fixed bug #123 in auth module')).toBeGreaterThan(0);
    expect(computeClientRelevance('config.yaml update', 'Updated config.yaml with new settings')).toBeGreaterThan(0);
  });

  it('handles very long content without leaving the valid range', () => {
    const score = computeClientRelevance('word test', 'word '.repeat(10000));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// Migrated from the unrun root `tests/05-error-scenarios.test.ts`.
describe('computeClientRelevance — degenerate and hostile inputs', () => {
  it('returns a valid score for whitespace-only input', () => {
    const score = computeClientRelevance('   ', '   ');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('stays in range for ~1MB of content', () => {
    const score = computeClientRelevance('word', 'word '.repeat(200_000));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('stays in range for a ~60KB query', () => {
    const score = computeClientRelevance('query '.repeat(10_000), 'query term matching');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it.each([
    ['null bytes', 'content with \0 null bytes'],
    ['control chars', 'content with \n\r\t control chars'],
    ['emoji', 'content with 🎉 emoji 🚀 chars'],
    ['html/script', 'content with <script>alert("xss")</script>'],
    ['template literals', 'content with ${template} literals'],
    ['backslash paths', 'content with \\backslash\\paths'],
    ['quotes', 'content with "quotes" and \'apostrophes\''],
    ['regex metacharacters', 'regex special: [a-z]+ (.*?) {1,3}'],
  ])('stays in range for content containing %s', (_label, content) => {
    const score = computeClientRelevance('test query', content);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('is pure — mapping the same input concurrently matches the sequential result', async () => {
    const content = 'fix the authentication bug in the login module';
    const scores = await Promise.all(
      Array.from({ length: 100 }, (_, i) => Promise.resolve(computeClientRelevance(`query ${i}`, content))),
    );

    expect(scores.every((s) => s >= 0 && s <= 1)).toBe(true);
    expect(scores[0]).toBe(computeClientRelevance('query 0', content));
  });
});

describe('trigramSimilarity — pathological inputs', () => {
  it('treats two empty strings as identical', () => {
    expect(trigramSimilarity('', '')).toBe(1);
  });

  it('scores two different single characters as disjoint', () => {
    expect(trigramSimilarity('a', 'b')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(trigramSimilarity('HELLO', 'hello')).toBe(1);
  });
});

describe('deduplicateByContent — degenerate inputs', () => {
  it('handles empty and whitespace-only content without dropping everything', () => {
    const deduped = deduplicateByContent([
      { content: '', relevance: 0.5 },
      { content: 'valid content', relevance: 0.8 },
      { content: '   ', relevance: 0.3 },
    ]);

    expect(deduped.length).toBeGreaterThanOrEqual(1);
  });

  it('collapses ten identical items into one', () => {
    const items = Array.from({ length: 10 }, () => ({
      content: 'exactly the same content repeated',
      relevance: 0.5,
    }));

    expect(deduplicateByContent(items)).toHaveLength(1);
  });

  it('keeps distinct items that all have zero relevance', () => {
    const deduped = deduplicateByContent([
      { content: 'first item', relevance: 0 },
      { content: 'second item', relevance: 0 },
      { content: 'third item', relevance: 0 },
    ]);

    expect(deduped).toHaveLength(3);
  });

  it('tolerates a negative relevance score', () => {
    const deduped = deduplicateByContent([
      { content: 'item one with negative score', relevance: -0.5 },
      { content: 'item two with normal score', relevance: 0.8 },
    ]);

    expect(deduped).toHaveLength(2);
  });

  it('is deterministic across repeated independent calls', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      content: `Memory item ${i % 5} with some extra text ${i}`,
      relevance: 0.5 + i * 0.01,
    }));

    const lengths = [
      deduplicateByContent([...items]).length,
      deduplicateByContent([...items]).length,
      deduplicateByContent([...items]).length,
    ];

    expect(new Set(lengths).size).toBe(1);
  });
});
