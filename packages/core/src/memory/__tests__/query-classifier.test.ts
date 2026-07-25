/**
 * @module __tests__/query-classifier
 * Unit tests for query-classifier.ts — classifyQuery, getRecallStrategy,
 * isExternalAction.
 *
 * Migrated from the unrun root `tests/03-indexing.test.ts`. Only the sections
 * exercising real product code were carried over; the remainder of that file
 * asserted arithmetic over locally-declared constants.
 */

import { describe, it, expect } from 'vitest';
import { classifyQuery, getRecallStrategy, isExternalAction } from '../query-classifier.js';

describe('classifyQuery', () => {
  it.each(['yes', 'do it', 'fix all', 'ok', '#3', 'the second one', 'go ahead', 'sure', 'skip', 'next', 'continue'])(
    'classifies the short follow-up "%s" as task_continuation',
    (query) => {
      expect(classifyQuery(query).type).toBe('task_continuation');
    },
  );

  it.each([
    'we discussed the database migration earlier in great detail',
    'what happened with the auth system in the last session',
    'how did we handle the authentication system previously',
  ])('classifies "%s" as historical_reference', (query) => {
    expect(classifyQuery(query).type).toBe('historical_reference');
  });

  it.each([
    'the decision was to use PostgreSQL instead of Redis for our storage',
    'what was the rationale for choosing that particular framework option',
    'the decision about the trade-off between caching strategies is crucial',
  ])('routes the decision query "%s" to a memory-backed type', (query) => {
    expect(['decision_lookup', 'historical_reference']).toContain(classifyQuery(query).type);
  });

  it.each([
    'what can you do with the recall and memory features',
    'give me a complete status overview of the current project',
    'what features does this system have for helping with projects',
  ])('classifies "%s" as meta_system', (query) => {
    expect(classifyQuery(query).type).toBe('meta_system');
  });

  it.each([
    'search the web for node.js best practices',
    'curl https://api.example.com/data',
    'npm install express',
    'run the command "make build"',
    'fetch the url https://example.com',
    'pip install pandas',
  ])('classifies "%s" as external_action', (query) => {
    expect(classifyQuery(query).type).toBe('external_action');
  });

  it('lets a memory cue override an external-action cue', () => {
    expect(classifyQuery('search the web for what we decided last week').type).not.toBe('external_action');
  });

  it('reports a confidence in range for both terse and clearly-worded queries', () => {
    const short = classifyQuery('yes');
    expect(short.confidence).toBeGreaterThanOrEqual(0.5);
    expect(short.confidence).toBeLessThanOrEqual(1.0);

    const clear = classifyQuery('the decision to pick PostgreSQL instead of MongoDB for storage');
    expect(clear.confidence).toBeGreaterThanOrEqual(0.3);
    expect(clear.confidence).toBeLessThanOrEqual(1.0);
  });

  it('defaults an ambiguous query to task_continuation', () => {
    expect(classifyQuery('make the thing work better with more stuff').type).toBe('task_continuation');
  });
});

describe('isExternalAction', () => {
  it('flags web searches and package installs', () => {
    expect(isExternalAction('search the web for react docs')).toBe(true);
    expect(isExternalAction('npm install lodash')).toBe(true);
  });

  it('does not flag ordinary tasks or memory queries', () => {
    expect(isExternalAction('fix the bug')).toBe(false);
    expect(isExternalAction('what did we decide last session')).toBe(false);
  });
});

describe('getRecallStrategy', () => {
  // Client-side relevance scores are capped by the client-fallback ceiling, so
  // every recall-enabled strategy must sit at or below it to be reachable.
  const CLIENT_FALLBACK_CEILING = 0.15;

  it.each(['task_continuation', 'historical_reference', 'decision_lookup', 'meta_system'] as const)(
    'keeps %s minRelevance within the reachable client-scoring range',
    (type) => {
      const strategy = getRecallStrategy({ type, confidence: 0.8 });
      expect(strategy.minRelevance).toBeGreaterThan(0);
      expect(strategy.minRelevance).toBeLessThanOrEqual(CLIENT_FALLBACK_CEILING);
    },
  );

  it('suppresses recall entirely for external actions', () => {
    const strategy = getRecallStrategy({ type: 'external_action', confidence: 0.85 });

    expect(strategy.minRelevance).toBe(1.0);
    expect(strategy.convBudgetRatio).toBe(0.0);
    expect(strategy.temporalDiversityRatio).toBe(0.0);
  });

  it('broadens temporal coverage for historical references', () => {
    const strategy = getRecallStrategy({ type: 'historical_reference', confidence: 0.8 });

    expect(strategy.temporalDiversityRatio).toBeGreaterThanOrEqual(0.3);
    expect(strategy.temporalDiversityRatio).toBeLessThanOrEqual(0.5);
    expect(strategy.recallBudget).toBe('high');
    expect(strategy.temporalBias).toBe('broad');
    expect(strategy.preferredContextCategories).toEqual(
      expect.arrayContaining(['session_summary', 'lesson']),
    );
  });

  it('targets decision and architecture context for decision lookups', () => {
    const strategy = getRecallStrategy({ type: 'decision_lookup', confidence: 0.8 });

    expect(strategy.temporalBias).toBe('targeted');
    expect(strategy.preferredContextCategories).toEqual(
      expect.arrayContaining(['decision', 'architecture']),
    );
  });

  it('favours conversation budget over temporal diversity for task continuation', () => {
    const strategy = getRecallStrategy({ type: 'task_continuation', confidence: 0.8 });

    expect(strategy.convBudgetRatio).toBeGreaterThanOrEqual(0.7);
    expect(strategy.convBudgetRatio).toBeLessThanOrEqual(0.9);
    expect(strategy.temporalDiversityRatio).toBeLessThanOrEqual(0.1);
    expect(strategy.recallBudget).toBe('mid');
  });
});

// Migrated from the unrun root `tests/05-error-scenarios.test.ts`.
describe('classifyQuery — edge cases', () => {
  it('defaults empty and whitespace-only queries to task_continuation', () => {
    expect(classifyQuery('').type).toBe('task_continuation');
    expect(classifyQuery('   ').type).toBe('task_continuation');
  });

  it('classifies a very long query to a valid type with in-range confidence', () => {
    const c = classifyQuery('word '.repeat(5000));

    expect(['task_continuation', 'historical_reference', 'decision_lookup', 'meta_system', 'external_action'])
      .toContain(c.type);
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
  });

  it('resolves a query carrying both decision and historical cues to one of the two', () => {
    const c = classifyQuery('why did we originally decide to use Redis last month');

    expect(['historical_reference', 'decision_lookup']).toContain(c.type);
  });
});

describe('getRecallStrategy — invariants across every query type', () => {
  it.each([
    'task_continuation', 'historical_reference', 'decision_lookup', 'meta_system', 'external_action',
  ] as const)('returns well-formed ratios and enum values for %s', (type) => {
    const strategy = getRecallStrategy({ type, confidence: 1 });

    expect(strategy.convBudgetRatio).toBeGreaterThanOrEqual(0);
    expect(strategy.convBudgetRatio).toBeLessThanOrEqual(1);
    expect(strategy.temporalDiversityRatio).toBeGreaterThanOrEqual(0);
    expect(strategy.temporalDiversityRatio).toBeLessThanOrEqual(1);
    expect(strategy.minRelevance).toBeGreaterThanOrEqual(0);
    expect(strategy.minRelevance).toBeLessThanOrEqual(1);
    expect(['low', 'mid', 'high']).toContain(strategy.recallBudget);
    expect(['recent', 'broad', 'targeted']).toContain(strategy.temporalBias);
  });
});
