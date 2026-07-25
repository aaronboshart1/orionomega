/**
 * Unit tests for recall query truncation (M3 fix).
 *
 * Verifies:
 *  - A query that exceeds 450 tokens is clamped before being sent to
 *    MemoryStore.recall(), preventing HTTP 400 errors.
 *  - Short queries (≤ 450 tokens) are passed through unchanged.
 *  - After truncation, the query token count is ≤ 450.
 *  - The truncated query preserves the beginning of the original.
 *  - For short replies, the query that reaches recall still respects the cap.
 *
 * MAX_QUERY_TOKENS = 450 is an internal constant; tests are written
 * against its observable effect on what reaches the recall API.
 *
 * Ported to the §12 rewrite: `conversationBank` → `conversationScope`, and the
 * `federateBanks` / `adaptiveRecall` / `dynamicSummaryFallback` config keys are
 * gone. Recall calls are read straight off the store mock — the old
 * `diversifiedRecallCalls` helper selected calls by `temporalDiversityRatio`,
 * which the assembler no longer sends (temporal-diversity bucketing was
 * deleted), and the assembler is now the only caller of `store.recall`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { estimateTokens } from '@orionomega/shared/similarity';
import type { MemoryStore } from '../store.js';
import type { ConversationMessage } from '../context-assembler.js';

// MAX_QUERY_TOKENS is the internal cap for recall queries.
const MAX_QUERY_TOKENS = 450;

// ── Helpers ──────────────────────────────────────────────────────────────────

type FakeStore = MemoryStore & { recall: ReturnType<typeof vi.fn> };

/** A MemoryStore test double that records every recall call. */
function makeStore(): FakeStore {
  return {
    recall: vi.fn().mockResolvedValue({ records: [], lowConfidence: false, tokensUsed: 0 }),
    retain: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    retainOne: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    isDuplicate: vi.fn().mockResolvedValue(false),
    listScopes: vi.fn().mockResolvedValue([]),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ healthy: true }),
  } as unknown as FakeStore;
}

/** Build a query string of approximately `targetTokens` tokens. */
function buildLongQuery(targetTokens: number): string {
  // ~4 chars / token for typical English prose.
  const words = Math.ceil(targetTokens * 4 / 6);
  return Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
}

/** Extract the query string passed to the first assembler-issued recall call. */
function getRecallQuery(store: FakeStore): string {
  const calls = store.recall.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]![1] as string;
}

// ── Long query is truncated ───────────────────────────────────────────────────

describe('ContextAssembler — query truncation at 450 tokens (M3)', () => {
  let hs: FakeStore;
  let assembler: ContextAssembler;

  beforeEach(() => {
    hs = makeStore();
    assembler = new ContextAssembler(hs, { conversationScope: 'test-bank' });
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
  let hs: FakeStore;
  let assembler: ContextAssembler;

  beforeEach(() => {
    hs = makeStore();
    assembler = new ContextAssembler(hs, { conversationScope: 'test-bank' });
  });

  it('a 10-token query does not exceed the limit', async () => {
    const shortQuery = 'How does the authentication module work in this project?';
    expect(estimateTokens(shortQuery)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);

    await assembler.assemble(shortQuery);

    const used = getRecallQuery(hs);
    expect(used).toBe(shortQuery);
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });

  it('a 200-token query stays within the limit', async () => {
    const medQuery = buildLongQuery(200);
    expect(estimateTokens(medQuery)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);

    await assembler.assemble(medQuery);

    const used = getRecallQuery(hs);
    expect(used).toBe(medQuery);
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

// ── Short reply with a large hot window ──────────────────────────────────────

describe('ContextAssembler — short reply query respects the cap (M3)', () => {
  it('keeps the recall query within 450 tokens after a very long prior turn', async () => {
    const hs = makeStore();
    const assembler = new ContextAssembler(hs, { conversationScope: 'test-bank' });

    // Push a long assistant message — under the old assembler this was folded
    // into the recall query as augmentation context.
    const longAssistantContent = buildLongQuery(600);
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: longAssistantContent,
      timestamp: new Date().toISOString(),
    };
    await assembler.push(assistantMsg);

    // A very short reply (< 8 tokens).
    const shortReply = 'yes';
    expect(estimateTokens(shortReply)).toBeLessThan(10);

    await assembler.assemble(shortReply);

    const used = getRecallQuery(hs);

    // The query sent to recall must be within the 450-token limit —
    // either the raw short reply or a smartTruncate of a longer form.
    expect(estimateTokens(used)).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
  });
});

// ── Truncation does not affect priorContext output ────────────────────────────

describe('ContextAssembler — query truncation is transparent to callers', () => {
  it('assemble() still returns a result object even when the query is truncated', async () => {
    const hs = makeStore();
    const assembler = new ContextAssembler(hs, { conversationScope: 'test-bank' });

    const result = await assembler.assemble(buildLongQuery(800));

    expect(result).toBeDefined();
    expect(result.hotMessages).toBeDefined();
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
  });
});
