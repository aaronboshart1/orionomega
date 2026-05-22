/**
 * Unit tests for MemoryBridge.init() race-condition fix (H4).
 *
 * Verifies:
 *  - Concurrent calls to init() before initialization completes both
 *    receive the same in-flight Promise (no double-initialization).
 *  - The init logic (_doInit) runs exactly once even under concurrency.
 *  - HindsightClient is constructed only once even when init() is called
 *    multiple times before the first call resolves.
 *  - A completed init() is idempotent: subsequent calls return undefined.
 *  - _initPromise is used to deduplicate concurrent callers.
 *
 * All Hindsight dependencies are mocked so no running server is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnthropicClient } from '../../anthropic/client.js';
import type { EventBus } from '../../orchestration/event-bus.js';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────
// These must appear before any import of the modules under test.

vi.mock('@orionomega/hindsight', () => ({
  HindsightClient: vi.fn(),
  BankManager: vi.fn(),
  SessionBootstrap: vi.fn(),
  MentalModelManager: vi.fn(),
  SelfKnowledge: vi.fn(),
}));

vi.mock('../../memory/retention-engine.js', () => ({
  RetentionEngine: vi.fn(),
}));

vi.mock('../../memory/compaction-flush.js', () => ({
  CompactionFlush: vi.fn(),
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
import {
  HindsightClient,
  BankManager,
  SessionBootstrap,
  MentalModelManager,
  SelfKnowledge,
} from '@orionomega/hindsight';
import { RetentionEngine } from '../../memory/retention-engine.js';
import { CompactionFlush } from '../../memory/compaction-flush.js';
import { SessionSummarizer } from '../../memory/session-summary.js';

// Import MemoryBridge last so it picks up the mocked dependencies.
import { MemoryBridge } from '../memory-bridge.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal retention-engine mock: just a stub with { start, onMemoryEvent, onAfterRetain }. */
function makeRetentionEngineMock() {
  return { start: vi.fn(), onMemoryEvent: undefined, onAfterRetain: undefined };
}

/** Build a MemoryBridge instance with a real hindsight.url so init() proceeds. */
function makeBridge(hsUrl = 'http://hindsight-test') {
  return new MemoryBridge(
    { model: 'test-model', hindsight: { url: hsUrl, defaultBank: 'core' } } as unknown as ConstructorParameters<typeof MemoryBridge>[0],
    {} as unknown as AnthropicClient,
    {} as unknown as EventBus,
  );
}

/**
 * Wire up all module-level mocks so a call to init() can complete without errors.
 * Returns a mutable context object whose `resolveBankExists` property is set when
 * bankExists() is called inside _doInit, allowing callers to pause init at the
 * first `await` and test concurrency.
 *
 * IMPORTANT: Use `ctx.resolveBankExists!(true)` (not destructuring) so you see
 * the value assigned by the mock closure rather than the initial undefined.
 */
function setupMocks(): { resolveBankExists: ((v: boolean) => void) | undefined } {
  const ctx: { resolveBankExists: ((v: boolean) => void) | undefined } = {
    resolveBankExists: undefined,
  };

  vi.mocked(HindsightClient).mockImplementation(function() {
    return {
      bankExists: vi.fn().mockImplementation(
        () => new Promise<boolean>((r) => { ctx.resolveBankExists = r; }),
      ),
      onIO: undefined,
      mentalModelsAvailable: null,
      listMentalModels: vi.fn().mockRejectedValue(new Error('not supported')),
      setMentalModelsAvailable: vi.fn(),
    } as unknown as InstanceType<typeof HindsightClient>;
  });

  vi.mocked(BankManager).mockImplementation(function() {
    return {} as InstanceType<typeof BankManager>;
  });

  vi.mocked(SessionBootstrap).mockImplementation(function() {
    return {
      bootstrap: vi.fn().mockResolvedValue({}),
      buildContextBlock: vi.fn().mockReturnValue(''),
    } as unknown as InstanceType<typeof SessionBootstrap>;
  });

  vi.mocked(MentalModelManager).mockImplementation(function() {
    return {
      onRetain: vi.fn().mockResolvedValue(undefined),
      seedSystemModels: vi.fn().mockResolvedValue(undefined),
    } as unknown as InstanceType<typeof MentalModelManager>;
  });

  vi.mocked(SelfKnowledge).mockImplementation(function() {
    return {
      bootstrap: vi.fn().mockResolvedValue(undefined),
    } as unknown as InstanceType<typeof SelfKnowledge>;
  });

  vi.mocked(RetentionEngine).mockImplementation(function() {
    return makeRetentionEngineMock() as unknown as InstanceType<typeof RetentionEngine>;
  });

  vi.mocked(CompactionFlush).mockImplementation(function() {
    return {} as InstanceType<typeof CompactionFlush>;
  });

  vi.mocked(SessionSummarizer).mockImplementation(function() {
    return {
      getStatus: vi.fn().mockReturnValue(null),
    } as unknown as InstanceType<typeof SessionSummarizer>;
  });

  return ctx;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MemoryBridge.init() — H4: _initPromise mutex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concurrent init() calls return the same Promise object', () => {
    const ctx = setupMocks();
    const bridge = makeBridge();

    const p1 = bridge.init();
    const p2 = bridge.init(); // called before p1 resolves

    // H4 guarantee: the second call MUST return the in-flight promise, not a
    // new one.  Using toBe (reference equality) verifies this.
    expect(p1).toBe(p2);

    // Resolve so we don't leave dangling promises.
    ctx.resolveBankExists!(true);
    return Promise.all([p1, p2]);
  });

  it('HindsightClient is constructed exactly once across concurrent calls', async () => {
    const ctx = setupMocks();
    const bridge = makeBridge();

    const p1 = bridge.init();
    const p2 = bridge.init();

    ctx.resolveBankExists!(true);
    await Promise.all([p1, p2]);

    expect(vi.mocked(HindsightClient)).toHaveBeenCalledTimes(1);
  });

  it('SessionBootstrap.bootstrap() is called exactly once', async () => {
    const ctx = setupMocks();
    const bridge = makeBridge();

    const p1 = bridge.init();
    const p2 = bridge.init();

    ctx.resolveBankExists!(true);
    await Promise.all([p1, p2]);

    // Find the SessionBootstrap instance and verify bootstrap() ran once.
    const mockInstance = vi.mocked(SessionBootstrap).mock.results[0].value as {
      bootstrap: ReturnType<typeof vi.fn>;
    };
    expect(mockInstance.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('RetentionEngine.start() is called exactly once', async () => {
    const ctx = setupMocks();
    const bridge = makeBridge();

    const p1 = bridge.init();
    const p2 = bridge.init();

    ctx.resolveBankExists!(true);
    await Promise.all([p1, p2]);

    const retentionInstance = vi.mocked(RetentionEngine).mock.results[0].value as {
      start: ReturnType<typeof vi.fn>;
    };
    expect(retentionInstance.start).toHaveBeenCalledTimes(1);
  });
});

describe('MemoryBridge.init() — idempotency after completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('second call after successful init returns undefined immediately', async () => {
    const ctx = setupMocks();
    const bridge = makeBridge();

    // First init.
    const p1 = bridge.init();
    ctx.resolveBankExists!(true);
    await p1;

    // Second init should be a no-op (already initialised).
    const p2 = bridge.init();
    await expect(p2).resolves.toBeUndefined();
  });

  it('HindsightClient constructor is called only once even after multiple inits', async () => {
    const ctx = setupMocks();
    const bridge = makeBridge();

    const p1 = bridge.init();
    ctx.resolveBankExists!(true);
    await p1;

    await bridge.init(); // second call — should no-op
    await bridge.init(); // third call — should no-op

    expect(vi.mocked(HindsightClient)).toHaveBeenCalledTimes(1);
  });
});

describe('MemoryBridge.init() — no hindsight URL configured', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined without initialising when hindsight.url is absent', async () => {
    // Bridge with no hindsight config — init() must short-circuit gracefully.
    const bridge = new MemoryBridge(
      { model: 'test-model' } as ConstructorParameters<typeof MemoryBridge>[0],
      {} as unknown as AnthropicClient,
      {} as unknown as EventBus,
    );

    await expect(bridge.init()).resolves.toBeUndefined();
    expect(vi.mocked(HindsightClient)).not.toHaveBeenCalled();
  });

  it('concurrent calls without a URL are both safe no-ops', async () => {
    const bridge = new MemoryBridge(
      { model: 'test-model' } as ConstructorParameters<typeof MemoryBridge>[0],
      {} as unknown as AnthropicClient,
      {} as unknown as EventBus,
    );

    const [r1, r2] = await Promise.all([bridge.init(), bridge.init()]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });
});
