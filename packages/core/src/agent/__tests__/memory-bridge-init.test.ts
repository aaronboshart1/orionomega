/**
 * Unit tests for MemoryBridge.init() (H4 mutex) and shutdown.
 *
 * Verifies:
 *  - Concurrent calls to init() share one in-flight Promise (no double init).
 *  - RedisMemoryStore is constructed exactly once, and with `gc: true` so the
 *    background collector actually runs.
 *  - RetentionEngine.start() runs exactly once.
 *  - A completed init() is idempotent.
 *  - Without a `memory` config block nothing is constructed at all.
 *  - shutdown() stops retention and closes the store.
 *
 * The store and its collaborators are mocked, so no Redis is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnthropicClient } from '../../anthropic/client.js';
import type { EventBus } from '../../orchestration/event-bus.js';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────
// These must appear before any import of the modules under test.

vi.mock('../../memory/redis-store.js', () => ({
  RedisMemoryStore: vi.fn(),
}));

vi.mock('../../memory/retention-engine.js', () => ({
  RetentionEngine: vi.fn(),
}));

vi.mock('../../memory/session-summary.js', () => ({
  SessionSummarizer: vi.fn(),
}));

vi.mock('../../memory/query-classifier.js', () => ({
  isExternalAction: vi.fn().mockReturnValue(false),
  classifyQuery: vi.fn().mockReturnValue({ type: 'task_continuation', confidence: 1 }),
  getRecallStrategy: vi.fn().mockReturnValue(undefined),
}));

// Import after mocks so the mocked versions are used.
import { RedisMemoryStore } from '../../memory/redis-store.js';
import { RetentionEngine } from '../../memory/retention-engine.js';
import { SessionSummarizer } from '../../memory/session-summary.js';

// Import MemoryBridge last so it picks up the mocked dependencies.
import { MemoryBridge, type MemoryConfig } from '../memory-bridge.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal `memory:` config block — enough for init() to proceed. */
function memoryConfig(): MemoryConfig['memory'] {
  return {
    redis: { url: 'redis://localhost:6379' },
    retainOnComplete: true,
    retainOnError: true,
  };
}

function makeBridge(memory: MemoryConfig['memory'] | null = memoryConfig()) {
  return new MemoryBridge(
    { model: 'test-model', ...(memory ? { memory } : {}) },
    {} as unknown as AnthropicClient,
    {} as unknown as EventBus,
  );
}

/** Wire the constructor mocks so init() can complete. */
function setupMocks() {
  const close = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn();

  vi.mocked(RedisMemoryStore).mockImplementation(function() {
    return { close } as unknown as InstanceType<typeof RedisMemoryStore>;
  });

  vi.mocked(RetentionEngine).mockImplementation(function() {
    return {
      start: vi.fn(),
      stop,
      onMemoryEvent: undefined,
    } as unknown as InstanceType<typeof RetentionEngine>;
  });

  vi.mocked(SessionSummarizer).mockImplementation(function() {
    return {
      getStatus: vi.fn().mockReturnValue(null),
    } as unknown as InstanceType<typeof SessionSummarizer>;
  });

  return { close, stop };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MemoryBridge.init() — H4: _initPromise mutex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a second init() while the first is unresolved returns the same Promise', async () => {
    setupMocks();
    // A bridge with no memory block never flips `initialised`, so the second
    // call takes the _initPromise branch — the one H4 added.
    const bridge = makeBridge(null);

    const p1 = bridge.init();
    const p2 = bridge.init();

    // H4 guarantee: the second call MUST return the in-flight promise, not a
    // new one. Using toBe (reference equality) verifies this.
    expect(p1).toBe(p2);

    await Promise.all([p1, p2]);
  });

  it('the store is constructed exactly once across concurrent calls', async () => {
    setupMocks();
    const bridge = makeBridge();

    await Promise.all([bridge.init(), bridge.init()]);

    expect(vi.mocked(RedisMemoryStore)).toHaveBeenCalledTimes(1);
  });

  it('starts the background GC loop with the store', async () => {
    setupMocks();
    const bridge = makeBridge();

    await bridge.init();

    // Without gc, nothing ever calls collectGarbage() and expired records
    // accumulate behind the read-time TTL filter forever.
    const opts = vi.mocked(RedisMemoryStore).mock.calls[0][0] as { gc?: unknown };
    expect(opts.gc).toBe(true);
  });

  it('RetentionEngine.start() is called exactly once', async () => {
    setupMocks();
    const bridge = makeBridge();

    await Promise.all([bridge.init(), bridge.init()]);

    const retentionInstance = vi.mocked(RetentionEngine).mock.results[0].value as {
      start: ReturnType<typeof vi.fn>;
    };
    expect(retentionInstance.start).toHaveBeenCalledTimes(1);
  });

  it('exposes the store and retention engine once initialised', async () => {
    setupMocks();
    const bridge = makeBridge();

    expect(bridge.isInitialised).toBe(false);
    expect(bridge.store).toBeNull();

    await bridge.init();

    expect(bridge.isInitialised).toBe(true);
    expect(bridge.store).not.toBeNull();
    expect(bridge.retention).not.toBeNull();
  });
});

describe('MemoryBridge.init() — idempotency after completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the store constructor runs only once even after repeated inits', async () => {
    setupMocks();
    const bridge = makeBridge();

    await bridge.init();
    await bridge.init(); // second call — should no-op
    await bridge.init(); // third call — should no-op

    expect(vi.mocked(RedisMemoryStore)).toHaveBeenCalledTimes(1);
  });
});

describe('MemoryBridge.init() — no memory config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs nothing when the memory block is absent', async () => {
    const bridge = makeBridge(null);

    await bridge.init();

    expect(vi.mocked(RedisMemoryStore)).not.toHaveBeenCalled();
    expect(bridge.isInitialised).toBe(false);
    expect(bridge.store).toBeNull();
    expect(bridge.retention).toBeNull();
    expect(bridge.getSummarizerStatus()).toBeNull();
  });

  it('concurrent calls without config are both safe no-ops', async () => {
    const bridge = makeBridge(null);

    await expect(Promise.all([bridge.init(), bridge.init()])).resolves.toBeDefined();
    expect(vi.mocked(RedisMemoryStore)).not.toHaveBeenCalled();
  });
});

describe('MemoryBridge.shutdown()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops retention and closes the store', async () => {
    const { close, stop } = setupMocks();
    const bridge = makeBridge();

    await bridge.init();
    await bridge.shutdown();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(bridge.store).toBeNull();
    expect(bridge.isInitialised).toBe(false);
  });

  it('is a no-op when memory was never initialised', async () => {
    setupMocks();
    const bridge = makeBridge(null);

    await expect(bridge.shutdown()).resolves.toBeUndefined();
  });
});
