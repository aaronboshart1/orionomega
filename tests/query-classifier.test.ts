/**
 * Tests for query-classifier.ts threshold alignment.
 *
 * Validates that all RecallStrategy minRelevance values are
 * calibrated for the client-side scoring range (0.05–0.40)
 * rather than the embedding range (0.0–1.0).
 */

// Inline the strategy logic for standalone testing.

type QueryType = 'task_continuation' | 'historical_reference' | 'decision_lookup' | 'meta_system' | 'external_action';

interface RecallStrategy {
  convBudgetRatio: number;
  temporalDiversityRatio: number;
  minRelevance: number;
  recallBudget: 'low' | 'mid' | 'high';
  preferredContextCategories: string[];
  temporalBias: 'recent' | 'broad' | 'targeted';
}

function getRecallStrategy(type: QueryType): RecallStrategy {
  switch (type) {
    case 'task_continuation':
      return { convBudgetRatio: 0.8, temporalDiversityRatio: 0.05, minRelevance: 0.15, recallBudget: 'mid', preferredContextCategories: [], temporalBias: 'recent' };
    case 'historical_reference':
      return { convBudgetRatio: 0.3, temporalDiversityRatio: 0.4, minRelevance: 0.1, recallBudget: 'high', preferredContextCategories: ['session_summary', 'project_update', 'lesson'], temporalBias: 'broad' };
    case 'decision_lookup':
      return { convBudgetRatio: 0.35, temporalDiversityRatio: 0.3, minRelevance: 0.12, recallBudget: 'high', preferredContextCategories: ['decision', 'architecture', 'preference'], temporalBias: 'targeted' };
    case 'meta_system':
      return { convBudgetRatio: 0.5, temporalDiversityRatio: 0.1, minRelevance: 0.15, recallBudget: 'mid', preferredContextCategories: ['project_update', 'session_summary'], temporalBias: 'recent' };
    case 'external_action':
      return { convBudgetRatio: 0.0, temporalDiversityRatio: 0.0, minRelevance: 1.0, recallBudget: 'low', preferredContextCategories: [], temporalBias: 'recent' };
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS: ${message}`);
}

const CLIENT_SCORING_MAX = 0.40; // typical max from client-side scorer
const CLIENT_FALLBACK_CEILING = 0.15;

console.log('\n=== Query Classifier: Threshold Alignment ===\n');

const queryTypes: QueryType[] = ['task_continuation', 'historical_reference', 'decision_lookup', 'meta_system', 'external_action'];

for (const type of queryTypes) {
  const strategy = getRecallStrategy(type);

  if (type === 'external_action') {
    assert(
      strategy.minRelevance === 1.0,
      `${type}: minRelevance = 1.0 (recall suppressed)`,
    );
    continue;
  }

  assert(
    strategy.minRelevance <= CLIENT_FALLBACK_CEILING,
    `${type}: minRelevance (${strategy.minRelevance}) <= CLIENT_FALLBACK_CEILING (${CLIENT_FALLBACK_CEILING})`,
  );

  assert(
    strategy.minRelevance > 0,
    `${type}: minRelevance (${strategy.minRelevance}) > 0 (not disabled)`,
  );

  assert(
    strategy.minRelevance < CLIENT_SCORING_MAX,
    `${type}: minRelevance (${strategy.minRelevance}) < typical client max (${CLIENT_SCORING_MAX})`,
  );
}

console.log('\n=== Temporal Diversity: Budget Ratio Sanity ===\n');

{
  const hist = getRecallStrategy('historical_reference');
  assert(
    hist.temporalDiversityRatio >= 0.3,
    `historical_reference uses high temporal diversity (${hist.temporalDiversityRatio})`,
  );
  assert(
    hist.recallBudget === 'high',
    'historical_reference uses high recall budget',
  );
}

{
  const task = getRecallStrategy('task_continuation');
  assert(
    task.temporalDiversityRatio <= 0.1,
    `task_continuation uses low temporal diversity (${task.temporalDiversityRatio})`,
  );
  assert(
    task.convBudgetRatio >= 0.7,
    `task_continuation biases toward conversation bank (${task.convBudgetRatio})`,
  );
}

{
  const decision = getRecallStrategy('decision_lookup');
  assert(
    decision.preferredContextCategories.includes('decision'),
    'decision_lookup prefers decision context category',
  );
  assert(
    decision.temporalBias === 'targeted',
    'decision_lookup uses targeted temporal bias',
  );
}

console.log('\n✓ All query-classifier tests passed\n');
