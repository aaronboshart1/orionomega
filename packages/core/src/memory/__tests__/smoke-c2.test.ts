/**
 * C2 Supplementary Smoke Tests — DEFAULT_SYSTEM_PROMPT_TOKENS = 15 000
 *
 * Edge cases:
 *  - assemble() with empty string query
 *  - assemble() with 10 000-char query
 *  - assemble() with special characters
 *  - assemble() with no scope configured (no store calls)
 *  - assemble() with systemPromptTokens=15000 → recall still runs
 *  - recall returns empty results (non-existent key)
 *  - recall store error → graceful degradation (no crash)
 *
 * Ported to the §12 rewrite's API: `conversationBank` -> `conversationScope`,
 * and the `federateBanks` / `adaptiveRecall` / `dynamicSummaryFallback` flags
 * are gone — they only ever switched OFF features that no longer exist, so
 * dropping them preserves each assertion's meaning exactly.
 *
 * Recall calls are counted off `store.recall.mock.calls` directly rather than
 * via the helper's `diversifiedRecallCalls()`, which filtered on the deleted
 * `temporalDiversityRatio` option.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { makeMockStore } from './helpers/mock-store.js';

describe('C2 Supplement — retrieval edge cases', () => {
  it('assemble() with empty string query does not crash', async () => {
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'scope',
    });
    const result = await assembler.assemble('');
    expect(result).toBeDefined();
    // priorContext is string | null — either is valid for an empty query with no recalls
    expect(result.priorContext === null || typeof result.priorContext === 'string').toBe(true);
  });

  it('assemble() with 10 000-char query does not crash', async () => {
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'scope',
    });
    const result = await assembler.assemble('a'.repeat(10_000));
    expect(result).toBeDefined();
  });

  it('assemble() with special characters does not crash', async () => {
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'scope',
    });
    const result = await assembler.assemble('!@#$%^&*(<>\n\t\r{}[]\\|"\'`~)');
    expect(result).toBeDefined();
  });

  it('assemble() with no conversationScope skips recall gracefully', async () => {
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {});
    const result = await assembler.assemble('some query');
    expect(result).toBeDefined();
    expect(store.recall).not.toHaveBeenCalled();
  });

  it('with systemPromptTokens=15000 (C2 default value), recall still proceeds', async () => {
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'scope',
      systemPromptTokens: 15_000,
    });
    await assembler.assemble('query');
    // 128k - 15k - 4k = 109k >> 500 → recall should run
    expect(store.recall.mock.calls.length).toBeGreaterThan(0);
    // One recall per scope: the conversation scope only.
    expect(store.recall.mock.calls.map((c: unknown[]) => c[0])).toEqual(['scope']);
  });

  it('recall returning empty results (non-existent key) produces empty priorContext', async () => {
    const store = makeMockStore({
      recall: vi.fn().mockResolvedValue({
        records: [],
        lowConfidence: true,
        tokensUsed: 0,
      }),
    });
    const assembler = new ContextAssembler(store, {
      conversationScope: 'scope',
    });
    const result = await assembler.assemble('nonexistent-key-xyz123456789');
    expect(store.recall).toHaveBeenCalled();
    // priorContext is null when no results — null means "no prior context available"
    expect(result.priorContext == null || result.priorContext === '').toBe(true);
  });

  it('recall store error does not crash assembler — returns empty context', async () => {
    const store = makeMockStore({
      recall: vi.fn().mockRejectedValue(new Error('network failure')),
    });
    const assembler = new ContextAssembler(store, {
      conversationScope: 'scope',
    });
    const result = await assembler.assemble('query after error');
    expect(result).toBeDefined();
    // priorContext is string | null — null means graceful degradation (no crash)
    expect(result.priorContext === null || typeof result.priorContext === 'string').toBe(true);
  });
});
