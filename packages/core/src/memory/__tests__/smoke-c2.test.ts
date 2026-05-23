/**
 * C2 Supplementary Smoke Tests — DEFAULT_SYSTEM_PROMPT_TOKENS = 15 000
 *
 * Edge cases:
 *  - assemble() with empty string query
 *  - assemble() with 10 000-char query
 *  - assemble() with special characters
 *  - assemble() with no bank configured (no HS calls)
 *  - assemble() with systemPromptTokens=15000 → recall still runs
 *  - recall returns empty results (non-existent key)
 *  - recall HS error → graceful degradation (no crash)
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import type { HindsightClient, RecalledMemory } from '@orionomega/hindsight';

function makeMockHs(): HindsightClient & { recallWithTemporalDiversity: ReturnType<typeof vi.fn> } {
  return {
    recallWithTemporalDiversity: vi.fn().mockResolvedValue({
      results: [] as RecalledMemory[],
      lowConfidence: false,
      tokens_used: 0,
    }),
    listBanksCached: vi.fn().mockResolvedValue([]),
    retain: vi.fn().mockResolvedValue({ success: true, bank_id: 'bank', items_count: 0 }),
    isDuplicateContent: vi.fn().mockResolvedValue(false),
  } as unknown as HindsightClient & { recallWithTemporalDiversity: ReturnType<typeof vi.fn> };
}

describe('C2 Supplement — retrieval edge cases', () => {
  it('assemble() with empty string query does not crash', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    const result = await assembler.assemble('');
    expect(result).toBeDefined();
    // priorContext is string | null — either is valid for an empty query with no recalls
    expect(result.priorContext === null || typeof result.priorContext === 'string').toBe(true);
  });

  it('assemble() with 10 000-char query does not crash', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    const result = await assembler.assemble('a'.repeat(10_000));
    expect(result).toBeDefined();
  });

  it('assemble() with special characters does not crash', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    const result = await assembler.assemble('!@#$%^&*(<>\n\t\r{}[]\\|"\'`~)');
    expect(result).toBeDefined();
  });

  it('assemble() with no conversationBank skips recall gracefully', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    const result = await assembler.assemble('some query');
    expect(result).toBeDefined();
    expect(hs.recallWithTemporalDiversity).not.toHaveBeenCalled();
  });

  it('with systemPromptTokens=15000 (C2 default value), recall still proceeds', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      systemPromptTokens: 15_000,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    await assembler.assemble('query');
    // 128k - 15k - 4k = 109k >> 500 → recall should run
    expect(hs.recallWithTemporalDiversity).toHaveBeenCalled();
  });

  it('recall returning empty results (non-existent key) produces empty priorContext', async () => {
    const hs = makeMockHs();
    hs.recallWithTemporalDiversity = vi.fn().mockResolvedValue({
      results: [],
      lowConfidence: true,
      tokens_used: 0,
    });
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    const result = await assembler.assemble('nonexistent-key-xyz123456789');
    // priorContext is null when no results — null means "no prior context available"
    expect(result.priorContext == null || result.priorContext === '').toBe(true);
  });

  it('recall HS error does not crash assembler — returns empty context', async () => {
    const hs = makeMockHs();
    hs.recallWithTemporalDiversity = vi.fn().mockRejectedValue(new Error('network failure'));
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    const result = await assembler.assemble('query after error');
    expect(result).toBeDefined();
    // priorContext is string | null — null means graceful degradation (no crash)
    expect(result.priorContext === null || typeof result.priorContext === 'string').toBe(true);
  });
});
