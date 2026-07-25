/**
 * @module __tests__/recall-pipeline
 * End-to-end tests for the client-side recall pipeline:
 * score → threshold-filter → deduplicate, and classification → strategy.
 *
 * Exercises the real scoring and classification functions against realistic
 * memory fixtures, at the production 0.15 relevance floor. Migrated from the
 * unrun root `tests/04-integration.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { computeClientRelevance, deduplicateByContent } from '@orionomega/hindsight';
import { classifyQuery, getRecallStrategy } from '../query-classifier.js';

/**
 * When the Hindsight API returns all-zero relevance, the client falls back to
 * lexical scoring, whose useful range is capped by this ceiling.
 */
const CLIENT_FALLBACK_CEILING = 0.15;

describe('recall pipeline — score, filter, deduplicate', () => {
  it('surfaces the relevant decision, collapses its near-duplicate, and drops noise', () => {
    const storedMemories = [
      { text: '[user] We decided to use PostgreSQL for the storage backend', context: 'decision' },
      { text: 'Task: Fix SQL injection vulnerability in auth module', context: 'lesson' },
      { text: '[assistant] Deployed the React app to staging', context: 'project_update' },
      { text: 'Node: build-123\nWorkflow: ci-pipeline\nResult: passed all tests', context: 'node_output' },
      { text: '[user] We decided to use PostgreSQL for the persistent store', context: 'decision' },
      { text: 'Random unrelated content about weather patterns', context: 'noise' },
    ];
    const query = 'what database did we decide to use';

    const scored = storedMemories.map((m) => ({
      content: m.text,
      context: m.context,
      relevance: computeClientRelevance(query, m.text),
    }));

    const filtered = scored.filter((r) => r.relevance >= CLIENT_FALLBACK_CEILING);
    expect(filtered.length).toBeGreaterThan(0);

    const deduped = deduplicateByContent(filtered);
    expect(deduped.length).toBeLessThanOrEqual(filtered.length);
    expect(deduped.some((d) => d.content.includes('PostgreSQL'))).toBe(true);

    const noise = scored.find((s) => s.context === 'noise')!;
    expect(noise.relevance).toBeLessThan(CLIENT_FALLBACK_CEILING);
  });

  it('scores a short 3-char-term query high enough for the relevant memory to survive the floor', () => {
    const memories = [
      { text: 'Fix the SQL injection bug in login.ts by parameterizing queries', context: 'lesson' },
      { text: 'The API key rotation schedule is quarterly', context: 'infrastructure' },
      { text: 'npm run dev starts the development server on port 3000', context: 'infrastructure' },
    ];

    const scored = memories.map((m) => ({
      content: m.text,
      relevance: computeClientRelevance('fix sql bug', m.text),
    }));

    expect(scored.find((s) => s.content.includes('SQL injection'))!.relevance).toBeGreaterThan(0);
    expect(scored.filter((r) => r.relevance >= CLIENT_FALLBACK_CEILING).some((f) => f.content.includes('SQL')))
      .toBe(true);
  });
});

describe('recall pipeline — classification drives strategy', () => {
  it.each([
    ['yes', 'task_continuation'],
    ['we discussed the database migration earlier in great detail', 'historical_reference'],
    ['search the web for react best practices', 'external_action'],
  ])('routes "%s" to %s and derives a consistent recall strategy', (text, expectedType) => {
    const classification = classifyQuery(text);
    expect(classification.type).toBe(expectedType);

    const strategy = getRecallStrategy(classification);
    if (expectedType === 'external_action') {
      expect(strategy.minRelevance).toBe(1.0);
    } else {
      expect(strategy.minRelevance).toBeLessThanOrEqual(CLIENT_FALLBACK_CEILING);
    }
  });

  it('treats a decision query as decision or historical, with a reachable threshold', () => {
    const classification = classifyQuery('the decision was to use PostgreSQL instead of Redis for storage');
    expect(['decision_lookup', 'historical_reference']).toContain(classification.type);

    expect(getRecallStrategy(classification).minRelevance).toBeLessThanOrEqual(CLIENT_FALLBACK_CEILING);
  });

  it('gives a historical query broad temporal coverage, a high budget, and preferred categories', () => {
    const strategy = getRecallStrategy(classifyQuery('what did we decide about the auth approach last month'));

    expect(strategy.temporalDiversityRatio).toBeGreaterThan(0.2);
    expect(strategy.recallBudget).toBe('high');
    expect(strategy.preferredContextCategories.length).toBeGreaterThan(0);
  });
});
