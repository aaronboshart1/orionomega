/**
 * Regression test for MainAgent.init() ordering.
 *
 * `this.orchestration` is assigned `null!` in the constructor and only becomes
 * a real OrchestrationBridge in step 3 of `_init()`. A previous revision called
 * `this.orchestration.bindMemoryStore()` from step 1b — immediately after
 * memory initialised, i.e. *before* the bridge existed — which threw
 * "Cannot read properties of null (reading 'bindMemoryStore')".
 *
 * The gateway catches that throw and leaves `mainAgent` null, so every chat
 * message fell through to the "Orchestration engine not yet connected"
 * fallback while the gateway itself looked healthy.
 *
 * The failure only reproduces when memory init SUCCEEDS: `bindMemoryStore()`
 * sat inside `if (initialisedStore)`. Every existing suite either ran without a
 * `memory:` block or with a store that failed to construct, so the branch was
 * never taken. This test pins the successful-memory path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (hoisted) ───────────────────────────────────────────────────

/** Stand-in store — enough surface for MemoryBridge.init() to accept it. */
const setMemoryStoreSpy = vi.fn();

// NOTE: every one of these must be a real class. `vi.fn(() => ({...}))` is not
// constructible, so `new RedisMemoryStore()` throws, MemoryBridge.init()
// swallows it ("continuing without memory"), and `memory.store` stays null —
// which skips the very branch this file exists to cover.
vi.mock('../../memory/redis-store.js', () => ({
  RedisMemoryStore: class {
    init = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    recall = vi.fn().mockResolvedValue([]);
    retain = vi.fn().mockResolvedValue(undefined);
    health = vi.fn().mockResolvedValue({ healthy: true, issues: [] });
  },
}));

vi.mock('../../memory/retention-engine.js', () => ({
  RetentionEngine: class {
    start = vi.fn();
    stop = vi.fn();
    unregisterWorkflowSession = vi.fn();
  },
}));

vi.mock('../../memory/session-summary.js', () => ({
  SessionSummarizer: class {
    getStatus = vi.fn().mockReturnValue(null);
  },
}));

// The planner is what bindMemoryStore() ultimately feeds. Spying on it proves
// the bind actually happened rather than merely not throwing.
vi.mock('../../orchestration/planner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../orchestration/planner.js')>();
  // A real class, not `vi.fn(() => …)` — arrow-function implementations are
  // not constructible, and OrchestrationBridge calls `new Planner(...)`.
  class MockPlanner {
    setMemoryStore = setMemoryStoreSpy;
  }
  return { ...actual, Planner: MockPlanner };
});

import { MainAgent } from '../main-agent.js';
import type { MainAgentConfig, MainAgentCallbacks } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): MainAgentConfig {
  return {
    model: 'claude-opus-4-8',
    cheapModel: 'claude-haiku-4-5-20251001',
    apiKey: 'sk-ant-test',
    systemPrompt: '',
    workspaceDir: '/tmp/orionomega-test-workspace',
    checkpointDir: '/tmp/orionomega-test-checkpoints',
    workerTimeout: 600,
    codingAgentTimeout: 1800,
    maxRetries: 0,
    autoResume: false,
    // The block that makes memory init succeed — and so takes the branch that
    // used to dereference the null orchestration bridge.
    memory: {
      redis: { url: 'redis://localhost:6379' },
      retainOnComplete: true,
      retainOnError: true,
    },
  } as MainAgentConfig;
}

function makeCallbacks(): MainAgentCallbacks {
  return {
    onText: vi.fn(),
    onThinking: vi.fn(),
    // Present so the memory-event wiring inside the `if (initialisedStore)`
    // branch is exercised too.
    onMemoryEvent: vi.fn(),
    onMemoryActivity: vi.fn(),
  } as unknown as MainAgentCallbacks;
}

describe('MainAgent.init() ordering', () => {
  let agent: MainAgent | null = null;

  beforeEach(() => {
    setMemoryStoreSpy.mockClear();
  });

  afterEach(async () => {
    // startBackgroundWatchdog() leaves an interval behind.
    await agent?.shutdown?.();
    agent = null;
    vi.clearAllTimers();
  });

  it('resolves when memory initialises successfully', async () => {
    agent = new MainAgent(makeConfig(), makeCallbacks());

    // The regression threw here with:
    //   TypeError: Cannot read properties of null (reading 'bindMemoryStore')
    await expect(agent.init()).resolves.toBeUndefined();
  });

  it('binds the initialised memory store into the planner', async () => {
    agent = new MainAgent(makeConfig(), makeCallbacks());
    await agent.init();

    // Not merely "did not throw": the late-bind must actually reach the
    // planner, or pre-planning recall is silently dead for the process.
    expect(setMemoryStoreSpy).toHaveBeenCalledTimes(1);
    expect(setMemoryStoreSpy.mock.calls[0]![0]).toBeTruthy();
  });
});
