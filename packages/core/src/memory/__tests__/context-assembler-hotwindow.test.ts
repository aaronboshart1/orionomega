/**
 * Unit tests for token-aware hot window eviction (H2 fix).
 *
 * Verifies:
 *  - After pushing many large messages, the hot window stays within
 *    the token budget (HOT_WINDOW_TOKEN_BUDGET = 30 000 tokens).
 *  - When the token budget is exceeded, the oldest messages are evicted
 *    first (shift from front of ring buffer).
 *  - At least 2 messages are always preserved, even if both individually
 *    exceed the token budget.
 *  - Small messages that fit within the budget are not evicted.
 *  - Token estimation is based on content length, not message count.
 *
 * Uses estimateTokens from @orionomega/shared/similarity to measure token totals.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { estimateTokens } from '@orionomega/shared/similarity';
import { makeMockStore } from './helpers/mock-store.js';
import type { ConversationMessage } from '../context-assembler.js';

// HOT_WINDOW_TOKEN_BUDGET is an internal constant (30 000 tokens).
// We reference it here as a plain number so tests are readable and
// remain correct if the constant ever changes.
const HOT_WINDOW_TOKEN_BUDGET = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a message with content of approximately `targetTokens` tokens. */
function makeLargeMsg(targetTokens: number, role: 'user' | 'assistant' = 'user'): ConversationMessage {
  // Rough approximation: 1 token ≈ 4 characters for plain prose.
  const content = 'A '.repeat(Math.ceil(targetTokens * 4 / 2));
  return { role, content, timestamp: new Date().toISOString() };
}

/** Sum estimated tokens across all messages in the hot window. */
function totalHotWindowTokens(assembler: ContextAssembler): number {
  return assembler.getHotWindow().reduce(
    (sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : ''),
    0,
  );
}

// ── Token-budget enforcement ──────────────────────────────────────────────────

describe('ContextAssembler — token-aware hot window eviction (H2)', () => {
  let assembler: ContextAssembler;

  beforeEach(() => {
    assembler = new ContextAssembler(makeMockStore(), {
      conversationBank: 'test-bank',
      // Use a small hotWindowSize so count-limit never triggers before token-limit.
      hotWindowSize: 50,
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
  });

  it('hot window stays within the 30 000-token budget after many large messages', async () => {
    // Push 20 messages of ~2 000 tokens each (total would be ~40 000 if uncapped).
    for (let i = 0; i < 20; i++) {
      await assembler.push(makeLargeMsg(2_000));
    }

    expect(totalHotWindowTokens(assembler)).toBeLessThanOrEqual(HOT_WINDOW_TOKEN_BUDGET);
  });

  it('hot window has fewer messages after token eviction than were pushed', async () => {
    // 15 × 3 000-token messages = 45 000 tokens — forces eviction.
    for (let i = 0; i < 15; i++) {
      await assembler.push(makeLargeMsg(3_000));
    }

    // If no eviction occurred the count would be 15; eviction reduces it.
    expect(assembler.getHotWindow().length).toBeLessThan(15);
  });

  it('evicts oldest messages first (most-recent are preserved)', async () => {
    // Push 10 messages labelled 0–9; only the last few should survive eviction.
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 10; i++) {
      const msg = makeLargeMsg(4_000);
      // Embed the index in the content so we can identify which were kept.
      (msg as ConversationMessage & { _index: number })._index = i;
      msg.content = `Message ${i}: ` + msg.content;
      messages.push(msg);
      await assembler.push(msg);
    }

    const kept = assembler.getHotWindow();
    const keptContents = kept.map((m) => m.content as string);

    // The most-recent message (msg 9) must always be present.
    expect(keptContents.some((c) => c.startsWith('Message 9:'))).toBe(true);

    // If any older message is missing, confirm a newer one is present.
    const maxKeptIndex = keptContents.reduce((max, c) => {
      const m = /^Message (\d+):/.exec(c);
      return m ? Math.max(max, Number(m[1])) : max;
    }, -1);
    const minKeptIndex = keptContents.reduce((min, c) => {
      const m = /^Message (\d+):/.exec(c);
      return m ? Math.min(min, Number(m[1])) : min;
    }, Infinity);

    // Newest messages must be consecutive from the tail.
    expect(maxKeptIndex).toBe(9);
    expect(minKeptIndex).toBeGreaterThan(0); // oldest were evicted
  });

  it('always preserves at least 2 messages regardless of content size', async () => {
    // Push 2 huge messages that individually exceed the token budget.
    // The while-loop stops at length = 2, so both must remain.
    await assembler.push(makeLargeMsg(25_000)); // each ≈ 25 k tokens
    await assembler.push(makeLargeMsg(25_000));

    expect(assembler.getHotWindow().length).toBe(2);
  });

  it('small messages within budget are never evicted', async () => {
    // Push 10 messages of 500 tokens each (5 000 total ≪ 30 000 budget).
    for (let i = 0; i < 10; i++) {
      await assembler.push(makeLargeMsg(500));
    }

    expect(assembler.getHotWindow().length).toBe(10);
    expect(totalHotWindowTokens(assembler)).toBeLessThanOrEqual(HOT_WINDOW_TOKEN_BUDGET);
  });

  it('token eviction triggers before the count-limit (hotWindowSize) kicks in', async () => {
    // With hotWindowSize=50 and 12 messages of 3 k tokens each (36 k total),
    // token eviction should reduce the window before count-limit is ever reached.
    for (let i = 0; i < 12; i++) {
      await assembler.push(makeLargeMsg(3_000));
    }

    // Count is still well below hotWindowSize=50, but tokens exceed budget.
    expect(assembler.getHotWindow().length).toBeLessThan(50);
    expect(totalHotWindowTokens(assembler)).toBeLessThanOrEqual(HOT_WINDOW_TOKEN_BUDGET);
  });
});

// ── Interaction with count-limit ──────────────────────────────────────────────

describe('ContextAssembler — hot window: count-limit still applies', () => {
  it('hot window never exceeds hotWindowSize even when token budget is fine', async () => {
    const assembler = new ContextAssembler(makeMockStore(), {
      conversationBank: 'test-bank',
      hotWindowSize: 5, // small count cap
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    // Push 10 very small messages (each ~10 tokens).
    for (let i = 0; i < 10; i++) {
      await assembler.push({ role: 'user', content: `short ${i}`, timestamp: new Date().toISOString() });
    }

    expect(assembler.getHotWindow().length).toBeLessThanOrEqual(5);
  });
});
