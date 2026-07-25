/**
 * Tests for what SessionSummarizer.summarize() REPORTS, as opposed to what it
 * writes.
 *
 * `summarize()` is contractually non-throwing: a failed summary must not take
 * down the turn that triggered it. That makes its return value the only signal
 * a caller has. Before this contract existed it returned `void`, and
 * MemoryBridge.summarize() logged "Session summarised" and emitted a
 * "Session summary retained" memory event on every path that did not throw —
 * which is all five of them, including "too few messages", "debounced",
 * "empty summary", and "the retain failed after retries".
 *
 * The visible consequence: with Redis down, the memory panel kept reporting
 * retained summaries, so a dead memory backend looked healthy.
 *
 * These tests pin each path to its reason, and pin that a skip is not counted
 * as a success in the /api/health snapshot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionSummarizer } from '../session-summary.js';
import type { MemoryStore } from '../store.js';
import type { AnthropicClient } from '../../anthropic/client.js';

// MIN_MESSAGES is 5 in session-summary.ts.
const ENOUGH_MESSAGES = Array.from({ length: 6 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `message ${i}`,
}));

/** A store whose retain() resolves — the happy path. */
function makeStore(retain = vi.fn().mockResolvedValue(undefined)) {
  return { retain } as unknown as MemoryStore & { retain: ReturnType<typeof vi.fn> };
}

/** A client returning a usable one-block text response. */
function makeClient(text = 'a concise summary') {
  return {
    createMessage: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text }],
    }),
  } as unknown as AnthropicClient & { createMessage: ReturnType<typeof vi.fn> };
}

describe('SessionSummarizer.summarize() reporting contract', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it('reports retained:true and writes when a summary is generated', async () => {
    const s = new SessionSummarizer(store, makeClient(), 'claude-haiku-4-5-20251001');

    const result = await s.summarize(ENOUGH_MESSAGES);

    expect(result).toEqual({ retained: true });
    expect(store.retain).toHaveBeenCalledTimes(1);
    expect(s.getStatus().successCount).toBe(1);
  });

  it('reports too_few_messages without writing', async () => {
    const s = new SessionSummarizer(store, makeClient(), 'claude-haiku-4-5-20251001');

    const result = await s.summarize(ENOUGH_MESSAGES.slice(0, 4));

    expect(result).toEqual({ retained: false, reason: 'too_few_messages' });
    expect(store.retain).not.toHaveBeenCalled();
    // A skip is not a success — /api/health must not imply a summary landed.
    expect(s.getStatus().successCount).toBe(0);
    expect(s.getStatus().lastSuccessAt).toBeNull();
  });

  it('reports debounced on a second call inside the window', async () => {
    const s = new SessionSummarizer(store, makeClient(), 'claude-haiku-4-5-20251001');

    await s.summarize(ENOUGH_MESSAGES);
    const second = await s.summarize(ENOUGH_MESSAGES);

    expect(second).toEqual({ retained: false, reason: 'debounced' });
    // Still just the one write from the first call.
    expect(store.retain).toHaveBeenCalledTimes(1);
    expect(s.getStatus().successCount).toBe(1);
  });

  it('reports empty_summary when the model returns no text', async () => {
    const client = makeClient();
    client.createMessage.mockResolvedValue({ content: [{ type: 'text', text: '   ' }] });
    const s = new SessionSummarizer(store, client, 'claude-haiku-4-5-20251001');

    const result = await s.summarize(ENOUGH_MESSAGES);

    expect(result).toEqual({ retained: false, reason: 'empty_summary' });
    expect(store.retain).not.toHaveBeenCalled();
    expect(s.getStatus().successCount).toBe(0);
  });

  it('reports failed — and does not throw — when the retain never lands', async () => {
    // The Redis-down case that started this: retain rejects on every retry.
    const failing = makeStore(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const s = new SessionSummarizer(failing, makeClient(), 'claude-haiku-4-5-20251001');

    const result = await s.summarize(ENOUGH_MESSAGES);

    expect(result).toEqual({ retained: false, reason: 'failed' });
    expect(s.getStatus().successCount).toBe(0);
    expect(s.getStatus().failureCount).toBe(1);
    expect(s.getStatus().lastError).toContain('ECONNREFUSED');
  });
});
