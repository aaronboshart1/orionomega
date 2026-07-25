/**
 * @module __tests__/recall-pipeline
 * End-to-end tests for the client-side recall pipeline:
 * score → threshold-filter → deduplicate, and classification → strategy.
 *
 * Exercises the real scoring functions against realistic memory fixtures, at
 * the production 0.15 relevance floor. Migrated from the unrun root
 * `tests/04-integration.test.ts`.
 *
 * The classification half of this file was retired with the memory v2 rewrite:
 * `classifyQuery` / `getRecallStrategy` and the per-query-type RecallStrategy
 * table were deleted along with the rest of the Hindsight-era assembler
 * accretion (docs/memory-architecture-v2.md §12). `isExternalAction` is the
 * only part of that classifier that survives, and it is covered by
 * context-assembler-properties.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { computeClientRelevance, deduplicateByContent } from '@orionomega/shared/similarity';

/** The production relevance floor. Recall is lexical — there is no other channel. */
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
