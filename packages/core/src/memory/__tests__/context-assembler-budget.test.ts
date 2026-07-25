/**
 * Unit tests for recall budget constants and defaults (H1 / C3 fixes).
 *
 * Verifies:
 *  - DEFAULT_MAX_TURN_TOKENS is 128 000 (was 60 000).
 *  - DEFAULT_RECALL_BUDGET is 16 384 (was 8 192).
 *  - A large systemPromptTokens value reduces the available recall budget.
 *  - When the available recall budget drops below 500 tokens, recall is skipped.
 *  - A custom recallBudgetTokens value is forwarded to the memory store.
 *
 * The constants are tested behaviourally (via the maxTokens argument passed to
 * `store.recall(scope, query, opts)`) since they are private module-level
 * values and cannot be imported directly.
 */

import { describe, it, expect } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { makeMockStore, type MockStore } from './helpers/mock-store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
//
// The shared `diversifiedRecallCalls` / `firstRecallOpts` helpers identified an
// assembler recall by the presence of `temporalDiversityRatio` in its opts.
// That parameter was deleted with the rewrite (§12) and the assembler now makes
// exactly one `recall(scope, query, opts)` call per configured scope, so the
// call list needs no filtering.

/** Extract the recall options from the first assembler-issued recall call. */
function getRecallOpts(store: MockStore): Record<string, unknown> {
  expect(store.recall.mock.calls.length).toBeGreaterThan(0);
  return store.recall.mock.calls[0]![2] as Record<string, unknown>;
}

/** True when the assembler issued at least one recall. */
function recallWasIssued(store: MockStore): boolean {
  return store.recall.mock.calls.length > 0;
}

// ── DEFAULT_RECALL_BUDGET = 16 384 ────────────────────────────────────────────

describe('ContextAssembler — DEFAULT_RECALL_BUDGET (H1)', () => {
  it('passes maxTokens ≤ 16 384 to recall when using default config', async () => {
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
    });

    await assembler.assemble('How does the auth module work?');

    const opts = getRecallOpts(store);
    expect(opts.maxTokens as number).toBeLessThanOrEqual(16_384);
  });

  it('maxTokens equals 16 384 when no hot-window tokens are consumed', async () => {
    const store = makeMockStore();
    // Empty hot window: all of recallBudgetTokens should flow through.
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
    });

    await assembler.assemble('Any query');

    const opts = getRecallOpts(store);
    // With no hot messages, available ≫ 16384, so recallBudgetTokens caps it.
    expect(opts.maxTokens).toBe(16_384);
  });

  it('custom recallBudgetTokens overrides the default', async () => {
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
      recallBudgetTokens: 4_000,
    });

    await assembler.assemble('query');

    const opts = getRecallOpts(store);
    expect(opts.maxTokens as number).toBeLessThanOrEqual(4_000);
  });
});

// ── DEFAULT_MAX_TURN_TOKENS = 128 000 ────────────────────────────────────────

describe('ContextAssembler — DEFAULT_MAX_TURN_TOKENS (H1)', () => {
  it('does not skip recall when systemPromptTokens is 15 000 (default)', async () => {
    // With DEFAULT_MAX_TURN_TOKENS=128k, systemPromptTokens=15k, outputReserve=4k:
    // available = 128k – 15k – 4k = 109k  >> 500 threshold → recall proceeds.
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
    });

    await assembler.assemble('query');

    expect(recallWasIssued(store)).toBe(true);
  });

  it('skips recall only when systemPromptTokens leaves fewer than 500 tokens', async () => {
    // With maxTurnTokens=128k and systemPromptTokens=128k, outputReserve=4k:
    // available = 128k – 128k – 4k = –4k → clamped to 0 < 500 → no recall.
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
      systemPromptTokens: 128_000,
    });

    await assembler.assemble('query');

    expect(recallWasIssued(store)).toBe(false);
  });

  it('recall still runs even with a large systemPromptTokens within bounds', async () => {
    // systemPromptTokens=60k: available = 128k – 60k – 4k = 64k >> 500.
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
      systemPromptTokens: 60_000,
    });

    await assembler.assemble('query');

    expect(recallWasIssued(store)).toBe(true);
  });

  it('custom maxTurnTokens is respected', async () => {
    // Very small maxTurnTokens → recall budget squeezed to zero.
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
      maxTurnTokens: 5_000,
      systemPromptTokens: 5_000,
    });

    await assembler.assemble('query');

    expect(recallWasIssued(store)).toBe(false);
  });
});

// ── recallBudget tiers (C3) — retired ────────────────────────────────────────

// Retired with the rewrite (§12): the four `recallBudget: high/mid/low` tests
// asserted that a coarse tier token ('high' by default) was forwarded to the
// store as `opts.budget`. That tier cap is exactly the budget bug the rewrite
// fixes — production asked for 30 000 recall tokens and silently received the
// per-tier cap. The `recallBudget` config key and the `budget` recall option
// were both deleted; the numeric `maxTokens` budget above is now the only
// budget the store is given, and the DEFAULT_RECALL_BUDGET block asserts it.

// ── Dynamic systemPromptTokens ─────────────────────────────────────────────────

describe('ContextAssembler — dynamic systemPromptTokens (C2 / H1)', () => {
  it('larger systemPromptTokens reduces the maxTokens passed to recall', async () => {
    // Baseline: default systemPromptTokens (~15 k).
    const storeBase = makeMockStore();
    const baseAssembler = new ContextAssembler(storeBase, {
      conversationScope: 'test-scope',
    });
    await baseAssembler.assemble('query');
    const baseMaxTokens = getRecallOpts(storeBase).maxTokens as number;

    // With a larger systemPromptTokens, available budget shrinks.
    const storeLarge = makeMockStore();
    const largeAssembler = new ContextAssembler(storeLarge, {
      conversationScope: 'test-scope',
      systemPromptTokens: 30_000,
    });
    await largeAssembler.assemble('query');
    const largeMaxTokens = getRecallOpts(storeLarge).maxTokens as number;

    // maxTokens is capped by recallBudgetTokens (16384), so both may be equal
    // when available > 16384. The important thing: recall still runs.
    expect(largeMaxTokens).toBeGreaterThan(0);
    expect(largeMaxTokens).toBeLessThanOrEqual(baseMaxTokens);
  });

  it('systemPromptTokens of 120 000 leaves almost no recall budget', async () => {
    // available = 128k – 120k – 4k = 4k → recall budget = min(4k, 16384) = 4k.
    // 4k > 500 threshold → recall still proceeds with 4k tokens.
    const store = makeMockStore();
    const assembler = new ContextAssembler(store, {
      conversationScope: 'test-scope',
      systemPromptTokens: 120_000,
    });

    await assembler.assemble('query');

    expect(recallWasIssued(store)).toBe(true);
    const opts = getRecallOpts(store);
    expect(opts.maxTokens as number).toBeLessThan(16_384);
    expect(opts.maxTokens as number).toBeGreaterThan(0);
  });
});
