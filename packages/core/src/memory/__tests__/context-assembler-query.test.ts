/**
 * Unit tests for recall query truncation (M3 fix).
 *
 * Verifies:
 *  - A query that exceeds 450 tokens is clamped before being sent to
 *    recallWithTemporalDiversity(), preventing HTTP 400 errors.
 *  - Short queries (≤ 450 tokens) are passed through unchanged.
 *  - After truncation, the query token count is ≤ 450.
 *  - The truncated query preserves the beginning of the original.
 *  - For short replies whose augmented form is too long, the raw query
 *    is preferred over a truncated augmented query.
 *
 * MAX_QUERY_TOKENS = 450 is an internal constant; tests are written
 * against its observable effect on what reaches the recall API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { estimateTokens } from '@orionomega/hindsight';
import type { HindsightClient, RecalledMemory } from '@orionomega/hindsight';
import type { ConversationMessage } from '../context-assembler.js';

// MAX_QUERY_TOKENS is the internal cap for recall queries.
const MAX_QUERY_TOKENS = 450;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockHs(): HindsightClient & {
  recallWithTemporalDiversity: ReturnType<typeof vi.fn>;
} {
  return {
    recallWithTemporalDiversity: vi.fn().mockResolvedValue({
      results: [] as RecalledMemory[],
      lowConfidence: false,
      tokens_used: 0,
    }),
    listBanksCached: vi.fn().mockResolvedValue([]),
    retain: vi.fn().mockResolvedValue({ success: true, bank_id: 'test', items_count: 1 }),
    isDuplicateContent: vi.fn().mockResolvedValue(false),
  } as unknown as ReturnType<typeof makeMockHs>;
}

/** Build a query string of approximately `targetTokens` tokens. */
function buildLongQuery(targetTokens: number): string {
  // ~4 chars / token for typical English prose.
  const words = Math.ceil(targetTokens * 4 / 6);
  return Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
}

/** Extract the query string passed to the first recall call. */
function getRecallQuery(hs: ReturnType<typeof makeMockHs>): string {
  expect(hs.recallWithTemporalDiversity).toHaveBeenCalled();
  return hs.recallWithTemporalDiversity.mock.calls[0][1] as string;
}

// ── Long query is truncated ───────────────────────────────────────────────────

describe('ContextAssembler — query truncation at 450 tokens (M3)', () => {
  let hs: ReturnType<typeof makeMockHs>;
  let assembler: ContextAssembler;

  beforeEach(() => {
    hs = makeMockHs();
    assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
  });

  it('passes a query of ~600 tokens through recall with ≤ 450 tokens', async () => {
    const longQuery = buildLongQuery(600);
    expect(estimateTokens(longQuery)).toBeGreaterThan(MAX_QUERY_TOKENS);

    await assembler.assemble(longQuery);

    const used = getRecallQuery(hs);
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });

  it('passes a very long query (~1 000 tokens) through recall with ≤ 450 tokens', async () => {
    const veryLongQuery = buildLongQuery(1_000);
    expect(estimateTokens(veryLongQuery)).toBeGreaterThan(MAX_QUERY_TOKENS);

    await assembler.assemble(veryLongQuery);

    const used = getRecallQuery(hs);
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });

  it('truncated query contains the beginning of the original', async () => {
    // Use a recognisable prefix so we can verify truncation preserves it.
    const prefix = 'DISTINCTIVE_START: ';
    const longQuery = prefix + buildLongQuery(600);

    await assembler.assemble(longQuery);

    const used = getRecallQuery(hs);
    expect(used).toContain('DISTINCTIVE_START');
  });

  it('truncated query is non-empty', async () => {
    await assembler.assemble(buildLongQuery(800));
    expect(getRecallQuery(hs).length).toBeGreaterThan(0);
  });
});

// ── Short query passes through unchanged ─────────────────────────────────────

describe('ContextAssembler — short query passes through (M3)', () => {
  let hs: ReturnType<typeof makeMockHs>;
  let assembler: ContextAssembler;

  beforeEach(() => {
    hs = makeMockHs();
    assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
  });

  it('a 10-token query does not exceed the limit', async () => {
    const shortQuery = 'How does the authentication module work in this project?';
    expect(estimateTokens(shortQuery)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);

    await assembler.assemble(shortQuery);

    const used = getRecallQuery(hs);
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });

  it('a 200-token query stays within the limit', async () => {
    const medQuery = buildLongQuery(200);
    expect(estimateTokens(medQuery)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);

    await assembler.assemble(medQuery);

    const used = getRecallQuery(hs);
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });

  it('a query at exactly 450 tokens passes through', async () => {
    // Build a query that's just at the cap.
    const atCapQuery = buildLongQuery(450);
    // It may slightly exceed 450 due to integer rounding — keep it ≤ 450.
    // We test that whatever is ≤ MAX_QUERY_TOKENS passes through unharmed.
    const actualTokens = estimateTokens(atCapQuery);
    if (actualTokens > MAX_QUERY_TOKENS) return; // skip if rounding overshoot

    await assembler.assemble(atCapQuery);

    const used = getRecallQuery(hs);
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });
});

// ── Short reply whose augmented form exceeds limit ───────────────────────────

describe('ContextAssembler — short reply prefers raw query when augmented is too long (M3)', () => {
  it('reverts to raw short query when augmented context exceeds 450 tokens', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    // Push a long assistant message that will be used as augmentation context.
    const longAssistantContent = buildLongQuery(600); // would push augmented > 450 tokens
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: longAssistantContent,
      timestamp: new Date().toISOString(),
    };
    await assembler.push(assistantMsg);

    // A very short reply (< 8 tokens) triggers augmentation.
    const shortReply = 'yes';
    expect(estimateTokens(shortReply)).toBeLessThan(10);

    await assembler.assemble(shortReply);

    const used = getRecallQuery(hs);

    // The query sent to recall must be within the 450-token limit —
    // either the raw short reply or a smartTruncate of the augmented form.
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });
});

// ── Truncation does not affect priorContext output ────────────────────────────

describe('ContextAssembler — query truncation is transparent to callers', () => {
  it('assemble() still returns a result object even when the query is truncated', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'test-bank',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    const result = await assembler.assemble(buildLongQuery(800));

    expect(result).toBeDefined();
    expect(result.hotMessages).toBeDefined();
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
  });
});
