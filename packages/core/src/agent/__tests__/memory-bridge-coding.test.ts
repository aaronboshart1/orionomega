/**
 * Unit tests for the MemoryBridge methods used in the DAG coding path:
 * ensureProjectScope, recallForPlanning, recallForArchitect, retainCodingRun,
 * verifyConsistency.
 *
 * Everything runs against a fake {@link MemoryStore}; no Redis is required.
 */

import { describe, it, expect, vi } from 'vitest';
import { MemoryBridge } from '../memory-bridge.js';
import type { AnthropicClient } from '../../anthropic/client.js';
import type { EventBus } from '../../orchestration/event-bus.js';
import type { MemoryStore, RecallOutcome } from '../../memory/store.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRecallOutcome(contents: string[] = ['Memory content']): RecallOutcome {
  return {
    records: contents.map((content) => ({
      content,
      context: 'decision',
      timestamp: '2024-01-01T00:00:00.000Z',
      relevance: 0.8,
    })),
    lowConfidence: false,
    tokensUsed: 100,
  };
}

type FakeStore = MemoryStore & {
  recall: ReturnType<typeof vi.fn>;
  retain: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
};

function makeStore(): FakeStore {
  return {
    recall: vi.fn().mockResolvedValue(makeRecallOutcome()),
    retain: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    retainOne: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    isDuplicate: vi.fn().mockResolvedValue(false),
    listScopes: vi.fn().mockResolvedValue([]),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ healthy: true }),
  } as unknown as FakeStore;
}

/** Bridge with an injected store, bypassing init() (which needs a real config). */
function makeBridge(store: MemoryStore | null, projectScope: string | null = 'project-myrepo') {
  const bridge = new MemoryBridge(
    { model: 'claude-test' },
    {} as unknown as AnthropicClient,
    {} as unknown as EventBus,
  );
  // Inject via private field casts (same pattern as the orchestration-bridge tests).
  (bridge as unknown as { memoryStore: MemoryStore | null }).memoryStore = store;
  (bridge as unknown as { activeProjectScope: string | null }).activeProjectScope = projectScope;
  return bridge;
}

/** The options object a recall was issued with, for a given scope. */
function recallOptsFor(store: FakeStore, scope: string): Record<string, unknown> | undefined {
  const call = store.recall.mock.calls.find((c: unknown[]) => c[0] === scope);
  return call?.[2] as Record<string, unknown> | undefined;
}

// ── ensureProjectScope ───────────────────────────────────────────────────────

describe('MemoryBridge.ensureProjectScope()', () => {
  it('derives a deterministic project- scope from the task', () => {
    const bridge = makeBridge(makeStore(), null);

    const scope = bridge.ensureProjectScope('Build a Redis backed memory store');

    expect(scope).toBe('project-redis-backed-memory-store');
    expect(bridge.projectScope).toBe(scope);
    // Deterministic: the same task rejoins the same scope.
    expect(bridge.ensureProjectScope('Build a Redis backed memory store')).toBe(scope);
  });
});

// ── recallForPlanning ────────────────────────────────────────────────────────

describe('MemoryBridge.recallForPlanning()', () => {
  it('recalls from core and the active project scope', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, 'project-myrepo');

    await bridge.recallForPlanning('Implement auth module');

    const scopes = store.recall.mock.calls.map((c: unknown[]) => c[0]);
    expect(scopes).toEqual(['core', 'project-myrepo']);
  });

  it('recalls from core alone when no project scope is active', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, null);

    await bridge.recallForPlanning('task');

    const scopes = store.recall.mock.calls.map((c: unknown[]) => c[0]);
    expect(scopes).toEqual(['core']);
  });

  it('uses maxTokens 2048 for core and 3072 for the project scope', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, 'project-repo');

    await bridge.recallForPlanning('task');

    expect(recallOptsFor(store, 'core')?.maxTokens).toBe(2048);
    expect(recallOptsFor(store, 'project-repo')?.maxTokens).toBe(3072);
  });

  it('passes only RecallQuery fields — no budget/types/queryTimestamp', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, 'project-repo');

    await bridge.recallForPlanning('task');

    for (const call of store.recall.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect(Object.keys(opts).sort()).toEqual(['maxTokens']);
    }
  });

  it('returns the recalled contents', async () => {
    const store = makeStore();
    store.recall.mockResolvedValue(makeRecallOutcome(['Core memory A', 'Core memory B']));
    const bridge = makeBridge(store, null);

    const memories = await bridge.recallForPlanning('task');

    expect(memories.join('\n')).toContain('Core memory A');
    expect(memories.join('\n')).toContain('Core memory B');
  });

  it('returns an empty array when the store is not initialised', async () => {
    const bridge = makeBridge(null);

    await expect(bridge.recallForPlanning('task')).resolves.toEqual([]);
  });

  it('survives a per-scope recall failure', async () => {
    const store = makeStore();
    store.recall.mockImplementation((scope: string) =>
      scope === 'core'
        ? Promise.reject(new Error('store unavailable'))
        : Promise.resolve(makeRecallOutcome(['Project memory'])),
    );
    const bridge = makeBridge(store, 'project-myrepo');

    const memories = await bridge.recallForPlanning('task');

    expect(memories.join('\n')).toContain('Project memory');
  });
});

// ── recallForArchitect ───────────────────────────────────────────────────────

describe('MemoryBridge.recallForArchitect()', () => {
  it('queries the project scope first, then core', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, 'project-myrepo');

    await bridge.recallForArchitect('Add a caching layer');

    const scopes = store.recall.mock.calls.map((c: unknown[]) => c[0]);
    expect(scopes).toEqual(['project-myrepo', 'core']);
    expect(recallOptsFor(store, 'project-myrepo')?.maxTokens).toBe(3072);
    expect(recallOptsFor(store, 'core')?.maxTokens).toBe(1024);
  });

  it('biases the query toward architecture context', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, null);

    await bridge.recallForArchitect('Add a caching layer');

    const query = store.recall.mock.calls[0][1] as string;
    expect(query).toContain('architecture decisions');
    expect(query).toContain('Add a caching layer');
  });

  it('returns one entry per recalled record', async () => {
    const store = makeStore();
    store.recall.mockResolvedValue(makeRecallOutcome(['Decision A', 'Decision B']));
    const bridge = makeBridge(store, null);

    await expect(bridge.recallForArchitect('task')).resolves.toEqual(['Decision A', 'Decision B']);
  });

  it('returns an empty array when the store is not initialised', async () => {
    const bridge = makeBridge(null);

    await expect(bridge.recallForArchitect('task')).resolves.toEqual([]);
  });
});

// ── retainCodingRun ──────────────────────────────────────────────────────────

describe('MemoryBridge.retainCodingRun()', () => {
  const payload = {
    task: 'Implement auth',
    requirements: [{ id: 'R1', description: 'Login works' }],
    verdicts: [{ requirementId: 'R1', status: 'pass', evidence: 'tests green', confidence: 0.9 }],
    decision: 'ship',
  };

  it('writes one coding-run record to the active project scope', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, 'project-myrepo');

    await bridge.retainCodingRun(payload);

    expect(store.retain).toHaveBeenCalledTimes(1);
    const [scope, writes] = store.retain.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(scope).toBe('project-myrepo');
    expect(writes).toHaveLength(1);
    expect(writes[0].context).toBe('coding-run');
    expect(writes[0].documentId).toMatch(/^coding-run-/);
    expect(writes[0].content).toContain('Implement auth');
    expect(writes[0].content).toContain('[R1] status=pass');
  });

  it('falls back to core when no project scope is active', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, null);

    await bridge.retainCodingRun(payload);

    expect(store.retain.mock.calls[0][0]).toBe('core');
  });

  it('tags the record with the originating session id', async () => {
    const store = makeStore();
    const bridge = makeBridge(store, 'project-myrepo');

    await bridge.retainCodingRun({ ...payload, sessionId: 'sess-7' });

    const writes = store.retain.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(writes[0].tags).toEqual(['session:sess-7']);
  });

  it('is a no-op when the store is not initialised', async () => {
    const bridge = makeBridge(null);

    await expect(bridge.retainCodingRun(payload)).resolves.toBeUndefined();
  });

  it('does not throw when the retain fails', async () => {
    const store = makeStore();
    store.retain.mockRejectedValue(new Error('store unavailable'));
    const bridge = makeBridge(store, 'project-myrepo');

    await expect(bridge.retainCodingRun(payload)).resolves.toBeUndefined();
  });
});

// ── verifyConsistency ────────────────────────────────────────────────────────

describe('MemoryBridge.verifyConsistency()', () => {
  it('reports healthy when the store is healthy', async () => {
    const store = makeStore();
    const bridge = makeBridge(store);

    await expect(bridge.verifyConsistency()).resolves.toEqual({ healthy: true, issues: [] });
  });

  it('reports the issue when the store is unhealthy', async () => {
    const store = makeStore();
    store.health.mockResolvedValue({ healthy: false });
    const bridge = makeBridge(store);

    const result = await bridge.verifyConsistency();

    expect(result.healthy).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  it('reports unhealthy when no store is initialised', async () => {
    const bridge = makeBridge(null);

    const result = await bridge.verifyConsistency();

    expect(result.healthy).toBe(false);
    expect(result.issues[0]).toContain('not initialised');
  });
});
