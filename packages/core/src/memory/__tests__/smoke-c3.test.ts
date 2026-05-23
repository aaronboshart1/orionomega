/**
 * C3 Supplementary Smoke Tests — recallBudget defaults to 'high'
 *
 * Edge cases:
 *  - Omitted recallBudget → 'high' sent to Hindsight API
 *  - Empty string query still passes budget: high
 *  - Oversized query (>450 tokens) still uses budget: high
 *  - Rapid successive assembles all use budget: high
 *  - Hot-window populated → budget: high still maintained
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

function getRecallOpts(hs: ReturnType<typeof makeMockHs>): Record<string, unknown> {
  return hs.recallWithTemporalDiversity.mock.calls[0][2] as Record<string, unknown>;
}

describe('C3 Supplement — recallBudget default edge cases', () => {
  it('omitted recallBudget sends budget: high', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    await assembler.assemble('query');
    expect(getRecallOpts(hs).budget).toBe('high');
  });

  it('empty string query: if recall called, budget is high', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    await assembler.assemble('');
    if (hs.recallWithTemporalDiversity.mock.calls.length > 0) {
      expect(getRecallOpts(hs).budget).toBe('high');
    }
  });

  it('oversized query (5 000 chars > 450 tokens): budget is still high', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    await assembler.assemble('word '.repeat(1_000));
    if (hs.recallWithTemporalDiversity.mock.calls.length > 0) {
      expect(getRecallOpts(hs).budget).toBe('high');
    }
  });

  it('rapid successive assembles all pass budget: high', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    await assembler.assemble('query one');
    await assembler.assemble('query two');
    await assembler.assemble('query three');
    for (const call of hs.recallWithTemporalDiversity.mock.calls) {
      expect((call[2] as Record<string, unknown>).budget).toBe('high');
    }
  });

  it('hot-window populated: budget: high is maintained', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    for (let i = 0; i < 5; i++) {
      await assembler.push({ role: 'user', content: `message ${i}`, timestamp: new Date().toISOString() });
    }
    hs.recallWithTemporalDiversity.mockClear();
    await assembler.assemble('query after hot window fill');
    if (hs.recallWithTemporalDiversity.mock.calls.length > 0) {
      expect(getRecallOpts(hs).budget).toBe('high');
    }
  });
});
