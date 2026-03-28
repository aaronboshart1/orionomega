import { createLogger } from '../logging/logger.js';

const log = createLogger('query-classifier');

export type QueryType =
  | 'task_continuation'
  | 'historical_reference'
  | 'decision_lookup'
  | 'meta_system'
  | 'external_action';

export interface QueryClassification {
  type: QueryType;
  confidence: number;
}

export interface RecallStrategy {
  convBudgetRatio: number;
  temporalDiversityRatio: number;
  minRelevance: number;
  recallBudget: 'low' | 'mid' | 'high';
  preferredContextCategories: string[];
  temporalBias: 'recent' | 'broad' | 'targeted';
}

const HISTORICAL_PATTERNS = [
  /\b(last (week|month|time|session|year)|earlier|previous(ly)?|yesterday|ago|history|before|back when|remember when)\b/i,
  /\b(we (decided|discussed|agreed|talked|did|built|used|chose)|what (was|were|did|happened))\b/i,
  /\b(how did we|when did we|why did we)\b/i,
  /\b(originally|initially|at first|in the beginning)\b/i,
];

const DECISION_PATTERNS = [
  /\b(why did (we|I|you) (choose|pick|decide|go with|select|use))\b/i,
  /\b(what (was|were) the (reason|rationale|decision|choice))\b/i,
  /\b(decision|chose|picked|selected|opted|trade-?off)\b/i,
  /\b(alternative|option|instead of|rather than|compared to)\b/i,
  /\b(let'?s go with|I'?ve decided|the plan is|switch to)\b/i,
];

const META_PATTERNS = [
  /\b(how (does|do) (you|the system|hindsight|memory|this) work)\b/i,
  /\b(what (can you|do you) (do|remember|recall|know))\b/i,
  /\b(status|overview|summary|recap|what'?s (going on|happening|the state))\b/i,
  /\b(help|capabilities|features|settings|config)\b/i,
];

const EXTERNAL_ACTION_STRONG = [
  /^search (the )?(web|internet|online)\b/i,
  /\bsearch (the )?(web|internet|online) for\b/i,
  /\bweb search\b/i,
  /\blook ?up .{1,60} (on |via )(google|the web|the internet|stack ?overflow)\b/i,
  /\bsearch (for|about) .{1,60} (online|on the web|on google)\b/i,
  /^(curl|wget) /i,
  /^(fetch|open|visit|browse|go to|navigate to) https?:\/\//i,
  /\bfetch (the |this |that )?(url|link|page|site)\b/i,
  /^(npm|yarn|pnpm|pip|apt|brew|cargo) (install|uninstall|add|remove|run)\b/i,
  /^(install|uninstall) /i,
  /^(run|execute) (the |this |that )?(command|script|shell|bash)\b/i,
  /^(run|execute) ["`']/i,
];

const CONTINUATION_PATTERNS = [
  /^(yes|no|ok|sure|do it|go ahead|that one|fix|skip|all|fix all|do all|continue|next)\b/i,
  /(?:^|\s)(#\d+|number \d+|\b(first|second|third|fourth|fifth|last|that|those|this|these) (one|option|item|change|suggestion)\b)/i,
  /\b(now|next|then|also|and|plus|add|update|change|modify|remove|delete|rename)\b/i,
];

function hasMemoryCues(text: string): boolean {
  return scorePatterns(text, HISTORICAL_PATTERNS) > 0 ||
    scorePatterns(text, DECISION_PATTERNS) > 0;
}

function hasStrongExternalIntent(text: string): boolean {
  for (const p of EXTERNAL_ACTION_STRONG) {
    if (p.test(text)) return true;
  }
  return false;
}

export function isExternalAction(text: string): boolean {
  const trimmed = text.trim();
  if (hasMemoryCues(trimmed)) return false;
  return hasStrongExternalIntent(trimmed);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function scorePatterns(text: string, patterns: RegExp[]): number {
  let matches = 0;
  for (const p of patterns) {
    if (p.test(text)) matches++;
  }
  return matches / patterns.length;
}

export function classifyQuery(query: string): QueryClassification {
  const trimmed = query.trim();
  const tokens = estimateTokens(trimmed);

  const historicalScore = scorePatterns(trimmed, HISTORICAL_PATTERNS);
  const decisionScore = scorePatterns(trimmed, DECISION_PATTERNS);
  const metaScore = scorePatterns(trimmed, META_PATTERNS);
  const continuationScore = scorePatterns(trimmed, CONTINUATION_PATTERNS);

  if (historicalScore === 0 && decisionScore === 0 && hasStrongExternalIntent(trimmed)) {
    const conf = 0.85;
    log.debug('Query classified as external_action', {
      confidence: conf.toFixed(2),
      tokenEstimate: tokens,
    });
    return { type: 'external_action', confidence: conf };
  }

  if (tokens < 8) {
    return { type: 'task_continuation', confidence: 0.9 };
  }

  const scores: Array<{ type: QueryType; score: number }> = [
    { type: 'historical_reference', score: historicalScore * 1.2 },
    { type: 'decision_lookup', score: decisionScore * 1.3 },
    { type: 'meta_system', score: metaScore },
    { type: 'task_continuation', score: continuationScore + (tokens < 30 ? 0.15 : 0) },
  ];

  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  if (best.score < 0.1) {
    return { type: 'task_continuation', confidence: 0.5 };
  }

  const confidence = Math.min(1, best.score + 0.3);

  log.debug('Query classified', {
    type: best.type,
    confidence: confidence.toFixed(2),
    tokenEstimate: tokens,
  });

  return { type: best.type, confidence };
}

export function getRecallStrategy(classification: QueryClassification): RecallStrategy {
  switch (classification.type) {
    case 'task_continuation':
      return {
        convBudgetRatio: 0.8,
        temporalDiversityRatio: 0.05,
        minRelevance: 0.3,
        recallBudget: 'mid',
        preferredContextCategories: [],
        temporalBias: 'recent',
      };

    case 'historical_reference':
      return {
        convBudgetRatio: 0.3,
        temporalDiversityRatio: 0.4,
        minRelevance: 0.2,
        recallBudget: 'high',
        preferredContextCategories: ['session_summary', 'project_update', 'lesson'],
        temporalBias: 'broad',
      };

    case 'decision_lookup':
      return {
        convBudgetRatio: 0.35,
        temporalDiversityRatio: 0.3,
        minRelevance: 0.25,
        recallBudget: 'high',
        preferredContextCategories: ['decision', 'architecture', 'preference'],
        temporalBias: 'targeted',
      };

    case 'meta_system':
      return {
        convBudgetRatio: 0.5,
        temporalDiversityRatio: 0.1,
        minRelevance: 0.3,
        recallBudget: 'mid',
        preferredContextCategories: ['project_update', 'session_summary'],
        temporalBias: 'recent',
      };

    case 'external_action':
      return {
        convBudgetRatio: 0.0,
        temporalDiversityRatio: 0.0,
        minRelevance: 1.0,
        recallBudget: 'low',
        preferredContextCategories: [],
        temporalBias: 'recent',
      };
  }
}
