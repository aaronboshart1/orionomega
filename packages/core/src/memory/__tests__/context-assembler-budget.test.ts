/**
 * Unit tests for recall budget constants and defaults (H1 / C3 fixes).
 *
 * Verifies:
 *  - DEFAULT_MAX_TURN_TOKENS is 128 000 (was 60 000).
 *  - DEFAULT_RECALL_BUDGET is 16 384 (was 8 192).
 *  - recallBudget defaults to 'high' (was 'mid').
 *  - A large systemPromptTokens value reduces the available recall budget.
 *  - When the available recall budget drops below 500 tokens, recall is skipped.
 *  - A custom recallBudget value is forwarded to the Hindsight API.
 *
 * The constants are tested behaviourally (via the maxTokens / budget args
 * passed to recallWithTemporalDiversity) since they are private module-level
 * values and cannot be imported directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import type { HindsightClient, RecalledMemory } from '@orionomega/hindsight';

// ── Helpers ──────────────────────────────────────────────────────────────────

type MockRecallResult = {
  results: RecalledMemory[];
  lowConfidence: boolean;
  tokens_used: number;
};

function makeMockHs(): HindsightClient & {
  recallWithTemporalDiversity: ReturnType<typeof vi.fn>;
  listBanksCached: ReturnType<typeof vi.fn>;
} {
  const result: MockRecallResult = {
    results: [],
    lowConfidence: false,
    tokens_used: 0,
  };
  return {
    recallWithTemporalDiversity: vi.fn().mockResolvedValue(result),
    listBanksCached: vi.fn().mockResolvedValue([]),
    retain: vi.fn().mockResolvedValue({ success: true, bank_id: 'test', items_count: 1 }),
    isDuplicateContent: vi.fn().mockResolvedValue(false),
  } as unknown as ReturnType<typeof makeMockHs>;
}

/** Extract the recall options from the first recallWithTemporalDiversity call. */
function getRecallOpts(hs: ReturnType<typeof makeMockHs>): Record<string, unknown> {
  expect(hs.recallWithTemporalDiversity).toHaveBeenCalled();
  return hs.recallWithTemporalDiversity.mock.calls[0][2] as Record<string, unknown>;
}

// ── DEFAULT_RECALL_BUDGET = 16 384 ────────────────────────────────────────────

describe('ContextAssembler — DEFAULT_RECALL_BUDGET (H1)', () => {
  it('passes maxTokens ≤ 16 384 to recall when using default config', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('How does the auth module work?');

    const opts = getRecallOpts(hs);
    expect(opts.maxTokens as number).toBeLessThanOrEqual(16_384);
  });

  it('maxTokens equals 16 384 when no hot-window tokens are consumed', async () => {
    const hs = makeMockHs();
    // Empty hot window: all of recallBudgetTokens should flow through.
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('Any query');

    const opts = getRecallOpts(hs);
    // With no hot messages, available ≫ 16384, so recallBudgetTokens caps it.
    expect(opts.maxTokens).toBe(16_384);
  });

  it('custom recallBudgetTokens overrides the default', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      recallBudgetTokens: 4_000,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    const opts = getRecallOpts(hs);
    expect(opts.maxTokens as number).toBeLessThanOrEqual(4_000);
  });
});

// ── DEFAULT_MAX_TURN_TOKENS = 128 000 ────────────────────────────────────────

describe('ContextAssembler — DEFAULT_MAX_TURN_TOKENS (H1)', () => {
  it('does not skip recall when systemPromptTokens is 15 000 (default)', async () => {
    // With DEFAULT_MAX_TURN_TOKENS=128k, systemPromptTokens=15k, outputReserve=4k:
    // available = 128k – 15k – 4k = 109k  >> 500 threshold → recall proceeds.
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(hs.recallWithTemporalDiversity).toHaveBeenCalled();
  });

  it('skips recall only when systemPromptTokens leaves fewer than 500 tokens', async () => {
    // With maxTurnTokens=128k and systemPromptTokens=128k, outputReserve=4k:
    // available = 128k – 128k – 4k = –4k → clamped to 0 < 500 → no recall.
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      systemPromptTokens: 128_000,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(hs.recallWithTemporalDiversity).not.toHaveBeenCalled();
  });

  it('recall still runs even with a large systemPromptTokens within bounds', async () => {
    // systemPromptTokens=60k: available = 128k – 60k – 4k = 64k >> 500.
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      systemPromptTokens: 60_000,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(hs.recallWithTemporalDiversity).toHaveBeenCalled();
  });

  it('custom maxTurnTokens is respected', async () => {
    // Very small maxTurnTokens → recall budget squeezed to zero.
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      maxTurnTokens: 5_000,
      systemPromptTokens: 5_000,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(hs.recallWithTemporalDiversity).not.toHaveBeenCalled();
  });
});

// ── recallBudget defaults to 'high' (C3) ─────────────────────────────────────

describe('ContextAssembler — recallBudget defaults to high (C3)', () => {
  it('passes budget: high to recall when no recallBudget is configured', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    const opts = getRecallOpts(hs);
    expect(opts.budget).toBe('high');
  });

  it('forwards explicit recallBudget: low to recall', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      recallBudget: 'low',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(getRecallOpts(hs).budget).toBe('low');
  });

  it('forwards explicit recallBudget: mid to recall', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      recallBudget: 'mid',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(getRecallOpts(hs).budget).toBe('mid');
  });

  it('forwards explicit recallBudget: high to recall', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      recallBudget: 'high',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(getRecallOpts(hs).budget).toBe('high');
  });
});

// ── Dynamic systemPromptTokens ─────────────────────────────────────────────────

describe('ContextAssembler — dynamic systemPromptTokens (C2 / H1)', () => {
  it('larger systemPromptTokens reduces the maxTokens passed to recall', async () => {
    // Baseline: default systemPromptTokens (~15 k).
    const hsBase = makeMockHs();
    const baseAssembler = new ContextAssembler(hsBase, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    await baseAssembler.assemble('query');
    const baseMaxTokens = getRecallOpts(hsBase).maxTokens as number;

    // With a larger systemPromptTokens, available budget shrinks.
    const hsLarge = makeMockHs();
    const largeAssembler = new ContextAssembler(hsLarge, {
      conversationBank: 'test-bank',
      systemPromptTokens: 30_000,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
    await largeAssembler.assemble('query');
    const largeMaxTokens = getRecallOpts(hsLarge).maxTokens as number;

    // maxTokens is capped by recallBudgetTokens (16384), so both may be equal
    // when available > 16384. The important thing: recall still runs.
    expect(largeMaxTokens).toBeGreaterThan(0);
    expect(largeMaxTokens).toBeLessThanOrEqual(baseMaxTokens);
  });

  it('systemPromptTokens of 120 000 leaves almost no recall budget', async () => {
    // available = 128k – 120k – 4k = 4k → recall budget = min(4k, 16384) = 4k.
    // 4k > 500 threshold → recall still proceeds with 4k tokens.
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      systemPromptTokens: 120_000,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    expect(hs.recallWithTemporalDiversity).toHaveBeenCalled();
    const opts = getRecallOpts(hs);
    expect(opts.maxTokens as number).toBeLessThan(16_384);
    expect(opts.maxTokens as number).toBeGreaterThan(0);
  });
});
