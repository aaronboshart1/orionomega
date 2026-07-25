/**
 * Unit tests for batched conversation retention (C5 fix).
 *
 * Verifies:
 *  - Messages are buffered rather than immediately sent to the memory store.
 *  - When the buffer reaches RETAIN_FLUSH_SIZE (3), a single retain()
 *    call is made with all buffered items.
 *  - When fewer than 3 messages are buffered, a timer fires after
 *    RETAIN_FLUSH_INTERVAL_MS (5 000 ms) and flushes the remainder.
 *  - Each retained item carries a documentId.
 *  - retain() is called with { async: true }.
 *  - destroy() flushes any buffered messages before teardown.
 *  - flushRetainBuffer() is a public no-op when the buffer is empty.
 *
 * Mocks the MemoryStore and uses vi.useFakeTimers for timer tests.
 *
 * Ported to the §12 rewrite's API: the config key `conversationBank` is now
 * `conversationScope`, and `federateBanks` / `adaptiveRecall` /
 * `dynamicSummaryFallback` were deleted along with the features they gated.
 * No assertion in this file changed meaning — retain buffering is retained
 * behaviour (RETAIN_FLUSH_SIZE 3, RETAIN_FLUSH_INTERVAL_MS 5 000,
 * flushRetainBuffer(), destroy(), `documentId` on each write, `{ async: true }`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import type { ConversationMessage } from '../context-assembler.js';
import { makeMockStore } from './helpers/mock-store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(content: string, role: 'user' | 'assistant' = 'user'): ConversationMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

/** Drain the microtask queue (≈ n Promise.resolve cycles). */
async function drainMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ── 3-message threshold flush ─────────────────────────────────────────────────

describe('ContextAssembler — batch retain: 3-message threshold (C5)', () => {
  let retainMock: ReturnType<typeof vi.fn>;
  let assembler: ContextAssembler;

  beforeEach(() => {
    vi.useFakeTimers();
    retainMock = vi.fn().mockResolvedValue({ ok: true, count: 3 });
    const hs = makeMockStore({ retain: retainMock });
    assembler = new ContextAssembler(hs, {
      conversationScope: 'test-scope',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does NOT call retain after the first message', async () => {
    await assembler.push(makeMsg('Message 1'));
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    expect(retainMock).not.toHaveBeenCalled();
  });

  it('does NOT call retain after the second message', async () => {
    await assembler.push(makeMsg('Message 1'));
    await assembler.push(makeMsg('Message 2'));
    await vi.advanceTimersByTimeAsync(0);

    expect(retainMock).not.toHaveBeenCalled();
  });

  it('calls retain exactly once after the third message', async () => {
    await assembler.push(makeMsg('Message 1'));
    await assembler.push(makeMsg('Message 2'));
    await assembler.push(makeMsg('Message 3'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    expect(retainMock).toHaveBeenCalledTimes(1);
  });

  it('retain is called with all 3 buffered items in a single request', async () => {
    await assembler.push(makeMsg('Alpha'));
    await assembler.push(makeMsg('Beta'));
    await assembler.push(makeMsg('Gamma'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    expect(retainMock).toHaveBeenCalledTimes(1);
    const [, items] = retainMock.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(items).toHaveLength(3);
  });

  it('retain is called on the correct scope', async () => {
    await assembler.push(makeMsg('A'));
    await assembler.push(makeMsg('B'));
    await assembler.push(makeMsg('C'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    const [scope] = retainMock.mock.calls[0] as [string, unknown];
    expect(scope).toBe('test-scope');
  });

  it('each retained item has a documentId', async () => {
    await assembler.push(makeMsg('Item A'));
    await assembler.push(makeMsg('Item B'));
    await assembler.push(makeMsg('Item C'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    const [, items] = retainMock.mock.calls[0] as [string, Array<Record<string, unknown>>];
    for (const item of items) {
      expect(typeof item.documentId).toBe('string');
      expect((item.documentId as string).length).toBeGreaterThan(0);
    }
  });

  it('retain is called with { async: true } in opts', async () => {
    await assembler.push(makeMsg('A'));
    await assembler.push(makeMsg('B'));
    await assembler.push(makeMsg('C'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    const [, , opts] = retainMock.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(opts?.async).toBe(true);
  });

  it('after a flush, the buffer is empty and next push starts a new batch', async () => {
    // Fill and flush the first batch.
    await assembler.push(makeMsg('A'));
    await assembler.push(makeMsg('B'));
    await assembler.push(makeMsg('C'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();
    expect(retainMock).toHaveBeenCalledTimes(1);

    // One more message — buffer has 1 item, no flush yet.
    await assembler.push(makeMsg('D'));
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    expect(retainMock).toHaveBeenCalledTimes(1); // still only one flush
  });
});

// ── Timer-based flush ─────────────────────────────────────────────────────────

describe('ContextAssembler — batch retain: timer flush after 5 s inactivity (C5)', () => {
  let retainMock: ReturnType<typeof vi.fn>;
  let assembler: ContextAssembler;

  beforeEach(() => {
    vi.useFakeTimers();
    retainMock = vi.fn().mockResolvedValue({ ok: true, count: 1 });
    const hs = makeMockStore({ retain: retainMock });
    assembler = new ContextAssembler(hs, {
      conversationScope: 'test-scope',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('flushes a single buffered message after 5 000 ms', async () => {
    await assembler.push(makeMsg('Lonely message'));

    // Before the timer fires — no flush.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(retainMock).not.toHaveBeenCalled();

    // After 5 000 ms — timer fires, flush occurs.
    await vi.advanceTimersByTimeAsync(2);
    await drainMicrotasks();

    expect(retainMock).toHaveBeenCalledTimes(1);
  });

  it('flushed item via timer still has a documentId', async () => {
    await assembler.push(makeMsg('Timer message'));
    await vi.advanceTimersByTimeAsync(5_001);
    await drainMicrotasks();

    const [, items] = retainMock.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(items[0].documentId).toBeDefined();
  });

  it('two buffered messages flushed together by timer', async () => {
    await assembler.push(makeMsg('Msg X'));
    await assembler.push(makeMsg('Msg Y'));

    await vi.advanceTimersByTimeAsync(5_001);
    await drainMicrotasks();

    expect(retainMock).toHaveBeenCalledTimes(1);
    const [, items] = retainMock.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(items).toHaveLength(2);
  });

  it('does not double-flush: threshold flush cancels the pending timer', async () => {
    await assembler.push(makeMsg('A'));
    await assembler.push(makeMsg('B'));
    await assembler.push(makeMsg('C')); // triggers threshold flush
    await vi.advanceTimersByTimeAsync(0);
    await drainMicrotasks();

    const flushCount = retainMock.mock.calls.length;

    // Advance 5 s — the timer that was set for messages 1 & 2 should
    // have been cancelled by the threshold flush. No extra call expected.
    await vi.advanceTimersByTimeAsync(5_001);
    await drainMicrotasks();

    expect(retainMock.mock.calls.length).toBe(flushCount); // no extra flush
  });
});

// ── flushRetainBuffer() public API ────────────────────────────────────────────

describe('ContextAssembler.flushRetainBuffer()', () => {
  it('is a no-op when the buffer is empty', async () => {
    const retainMock = vi.fn();
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, {
      conversationScope: 'test-scope',
    });

    await assembler.flushRetainBuffer();
    expect(retainMock).not.toHaveBeenCalled();
  });

  it('manually flushes buffered messages and empties the buffer', async () => {
    const retainMock = vi.fn().mockResolvedValue({ ok: true, count: 2 });
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, {
      conversationScope: 'test-scope',
    });

    await assembler.push(makeMsg('First'));
    await assembler.push(makeMsg('Second'));
    await assembler.flushRetainBuffer();

    expect(retainMock).toHaveBeenCalledTimes(1);
    const [, items] = retainMock.mock.calls[0] as [string, Array<unknown>];
    expect(items).toHaveLength(2);

    // Second manual flush — buffer is now empty, no extra call.
    await assembler.flushRetainBuffer();
    expect(retainMock).toHaveBeenCalledTimes(1);
  });
});

// ── destroy() flushes on teardown ─────────────────────────────────────────────

describe('ContextAssembler.destroy()', () => {
  it('flushes buffered messages when called', async () => {
    const retainMock = vi.fn().mockResolvedValue({ ok: true, count: 1 });
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, {
      conversationScope: 'test-scope',
    });

    await assembler.push(makeMsg('Unsent message'));
    await assembler.destroy();

    expect(retainMock).toHaveBeenCalledTimes(1);
  });

  it('is safe to call when buffer is already empty', async () => {
    const retainMock = vi.fn();
    const hs = makeMockStore({ retain: retainMock });
    const assembler = new ContextAssembler(hs, {
      conversationScope: 'test-scope',
    });

    await expect(assembler.destroy()).resolves.toBeUndefined();
    expect(retainMock).not.toHaveBeenCalled();
  });
});
