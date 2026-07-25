/**
 * MemoryBridge.summarize() must only emit the "Session summary retained"
 * memory event when a summary was actually retained.
 *
 * The regression this pins: SessionSummarizer.summarize() never throws — it
 * reports skips and failures through its return value. The bridge used to
 * ignore that value and emit on "did not throw", so the memory panel showed a
 * retained summary for every no-op path. With Redis refusing connections, the
 * UI kept streaming "Session summary retained" while nothing was written,
 * which is what made a dead memory backend look healthy.
 *
 * The summarizer is stubbed directly onto the private field: constructing a
 * real one requires init(), a live store, and an Anthropic client, none of
 * which this behaviour depends on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryBridge, type MemoryConfig } from '../memory-bridge.js';
import type { SummarizeResult } from '../../memory/session-summary.js';
import type { AnthropicClient } from '../../anthropic/client.js';
import type { EventBus } from '../../orchestration/event-bus.js';

const HISTORY = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
];

/**
 * Build a bridge with a stubbed summarizer and a spy on the memory-event sink.
 */
function makeBridge(result: SummarizeResult | (() => Promise<never>)) {
  const bridge = new MemoryBridge(
    { memory: null, model: 'claude-opus-4-8', cheapModel: 'claude-haiku-4-5-20251001' } as unknown as MemoryConfig,
    {} as AnthropicClient,
    {} as EventBus,
  );

  const summarize = typeof result === 'function'
    ? vi.fn().mockImplementation(result)
    : vi.fn().mockResolvedValue(result);

  (bridge as unknown as { sessionSummarizer: unknown }).sessionSummarizer = { summarize };

  const onMemoryEvent = vi.fn();
  bridge.onMemoryEvent = onMemoryEvent;

  return { bridge, summarize, onMemoryEvent };
}

describe('MemoryBridge.summarize() event emission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits the memory event when the summary was retained', async () => {
    const { bridge, onMemoryEvent } = makeBridge({ retained: true });

    await bridge.summarize(HISTORY, 'session-1');

    expect(onMemoryEvent).toHaveBeenCalledTimes(1);
    expect(onMemoryEvent).toHaveBeenCalledWith(
      'summary',
      'Session summary retained',
      undefined,
      { sessionId: 'session-1' },
    );
  });

  // Each of these returned `void` before, and every one of them emitted.
  it.each([
    ['too_few_messages'],
    ['debounced'],
    ['empty_summary'],
    ['failed'],
  ] as const)('stays silent when the summary was skipped (%s)', async (reason) => {
    const { bridge, onMemoryEvent } = makeBridge({ retained: false, reason });

    await bridge.summarize(HISTORY, 'session-1');

    expect(onMemoryEvent).not.toHaveBeenCalled();
  });

  it('stays silent, and does not throw, if the summarizer throws unexpectedly', async () => {
    const { bridge, onMemoryEvent } = makeBridge(() => Promise.reject(new Error('boom')));

    await expect(bridge.summarize(HISTORY, 'session-1')).resolves.toBeUndefined();
    expect(onMemoryEvent).not.toHaveBeenCalled();
  });

  it('is a no-op when no summarizer exists (memory not configured)', async () => {
    const { bridge, summarize, onMemoryEvent } = makeBridge({ retained: true });
    (bridge as unknown as { sessionSummarizer: unknown }).sessionSummarizer = null;

    await bridge.summarize(HISTORY, 'session-1');

    expect(summarize).not.toHaveBeenCalled();
    expect(onMemoryEvent).not.toHaveBeenCalled();
  });
});
