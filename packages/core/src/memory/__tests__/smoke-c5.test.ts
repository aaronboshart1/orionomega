/**
 * C5 Supplementary Smoke Tests — Retain-buffer batching
 *
 * Edge cases:
 *  - RETAIN_FLUSH_SIZE=3, RETAIN_FLUSH_INTERVAL_MS=5000 constant checks
 *  - flushRetainBuffer() on fresh assembler (0 messages) is a no-op
 *  - push() to assembler with no scope configured does not call retain
 *  - 6 messages → exactly 2 retain calls, each with 3 items
 *  - retain() error during flush does not crash assembler
 *  - destroy() twice is idempotent
 *  - threshold flush cancels timer (no double-flush)
 *
 * Ported to the §12 rewrite's API: `conversationBank` → `conversationScope`,
 * and the `federateBanks` / `adaptiveRecall` / `dynamicSummaryFallback` config
 * keys are gone (federation and the dynamic-summary fallback were deleted).
 * Retain buffering itself is retained behaviour and is asserted unchanged.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { makeMockStore } from './helpers/mock-store.js';

/**
 * The flush constants are `private static` on the class, so they are reachable
 * at runtime but not through the public type. The values themselves are pinned
 * behaviour, so read them through a narrow cast rather than duplicating them.
 */
const flushConstants = ContextAssembler as unknown as {
  RETAIN_FLUSH_SIZE: number;
  RETAIN_FLUSH_INTERVAL_MS: number;
};

function makeMsg(content: string, role: 'user' | 'assistant' = 'user') {
  return { role, content, timestamp: new Date().toISOString() };
}

async function drain(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('C5 Supplement — retain-buffer edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('RETAIN_FLUSH_SIZE is 3', () => {
    expect(flushConstants.RETAIN_FLUSH_SIZE).toBe(3);
  });

  it('RETAIN_FLUSH_INTERVAL_MS is 5 000', () => {
    expect(flushConstants.RETAIN_FLUSH_INTERVAL_MS).toBe(5_000);
  });

  it('flushRetainBuffer() on empty buffer is a no-op', async () => {
    const retainMock = vi.fn();
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, { conversationScope: 'scope' });
    await assembler.flushRetainBuffer();
    expect(retainMock).not.toHaveBeenCalled();
  });

  it('push() with no scope configured does not call retain', async () => {
    vi.useFakeTimers();
    const retainMock = vi.fn();
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, {});
    await assembler.push(makeMsg('A'));
    await assembler.push(makeMsg('B'));
    await assembler.push(makeMsg('C'));
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    expect(retainMock).not.toHaveBeenCalled();
  });

  it('6 messages produce exactly 2 retain calls, each with 3 items', async () => {
    vi.useFakeTimers();
    const retainMock = vi.fn().mockResolvedValue({ ok: true, count: 3 });
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, { conversationScope: 'scope' });
    for (let i = 1; i <= 6; i++) {
      await assembler.push(makeMsg(`Message ${i}`));
    }
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    expect(retainMock).toHaveBeenCalledTimes(2);
    for (const call of retainMock.mock.calls) {
      expect((call[1] as unknown[]).length).toBe(3);
    }
  });

  it('retain() error during flush does not crash assembler', async () => {
    vi.useFakeTimers();
    const retainMock = vi.fn().mockRejectedValue(new Error('memory store down'));
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, { conversationScope: 'scope' });
    await assembler.push(makeMsg('A'));
    await assembler.push(makeMsg('B'));
    await assembler.push(makeMsg('C'));
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    expect(retainMock).toHaveBeenCalledTimes(1);
    // Should still be usable
    await expect(assembler.push(makeMsg('D'))).resolves.toBeUndefined();
  });

  it('destroy() called twice is idempotent (no crash)', async () => {
    vi.useFakeTimers();
    const retainMock = vi.fn().mockResolvedValue({ ok: true, count: 0 });
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, { conversationScope: 'scope' });
    await assembler.destroy();
    await expect(assembler.destroy()).resolves.toBeUndefined();
  });

  it('threshold flush cancels timer — no double-flush after 5 000 ms', async () => {
    vi.useFakeTimers();
    const retainMock = vi.fn().mockResolvedValue({ ok: true, count: 3 });
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, { conversationScope: 'scope' });
    await assembler.push(makeMsg('X'));
    await assembler.push(makeMsg('Y'));
    await assembler.push(makeMsg('Z')); // threshold flush
    await vi.advanceTimersByTimeAsync(0);
    await drain();
    const countAfter = retainMock.mock.calls.length;
    expect(countAfter).toBe(1);
    // Timer should be cancelled — no extra flush
    await vi.advanceTimersByTimeAsync(flushConstants.RETAIN_FLUSH_INTERVAL_MS + 100);
    await drain();
    expect(retainMock.mock.calls.length).toBe(countAfter);
  });
});
