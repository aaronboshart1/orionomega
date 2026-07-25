/**
 * Tests for WHEN the recall-health reporter fires, as opposed to what it says.
 *
 * Consumers (the gateway status bar, /api/status, /api/health) start from an
 * assumed `rebuilding / index_cold` and only correct it when the store reports.
 * The reporter used to be driven exclusively by retain/recall, and `hydrate()`
 * is lazy — it runs on the first operation. A gateway that booted and waited
 * for a user therefore sat on "rebuilding" indefinitely with a perfectly
 * healthy Redis behind it, which is exactly what was observed in production.
 *
 * Two independent gaps, pinned separately below:
 *   1. assigning `onActivity` did not report current state, so a store that
 *      hydrated before the callback was wired lost that transition entirely
 *      (the wiring happens after MemoryBridge.init() returns);
 *   2. completing a hydration reported nothing at all.
 *
 * An injected in-memory client keeps this about control flow — the
 * `redis-store-*.test.ts` suites cover real Redis semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import type { RedisLike, RedisPipeline } from '../redis-connection.js';

type Activity = {
  busy: boolean;
  health: 'ready' | 'rebuilding' | 'degraded';
  reason?: string;
  op?: string;
};

/** Smallest client that satisfies a hydration walk over an empty keyspace. */
function makeClient(opts: { failScan?: boolean } = {}): RedisLike {
  const pipeline = (): RedisPipeline => ({
    hgetall() { return this; },
    exec: async () => [],
  } as unknown as RedisPipeline);

  return {
    smembers: async () => {
      if (opts.failScan) throw new Error('ECONNREFUSED');
      return [];
    },
    zrange: async () => [],
    pipeline,
    get: async () => null,
    quit: async () => 'OK',
  } as unknown as RedisLike;
}

describe('RedisMemoryStore activity reporting', () => {
  it('reports immediately when a reporter is assigned', () => {
    // skipHydrate leaves the store cold: the point is that assignment reports
    // *something* rather than waiting for an operation that may never come.
    const store = new RedisMemoryStore({ client: makeClient(), skipHydrate: true });
    const seen: Activity[] = [];

    store.onActivity = (a) => seen.push(a as Activity);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.op).toBe('bootstrap');
    expect(seen[0]!.busy).toBe(false);
  });

  it('reports ready once the index is hydrated', async () => {
    const store = new RedisMemoryStore({ client: makeClient() });
    const seen: Activity[] = [];
    store.onActivity = (a) => seen.push(a as Activity);

    // Assignment reports the cold state first.
    expect(seen[0]).toMatchObject({ health: 'rebuilding', reason: 'index_cold' });

    await store.hydrate();

    const last = seen[seen.length - 1]!;
    expect(last.health).toBe('ready');
    expect(last.reason).toBeUndefined();
    expect(store.isHydrated).toBe(true);
  });

  it('reports ready on assignment when hydration already finished', async () => {
    // The production ordering: MemoryBridge warms the index during init(), and
    // MainAgent wires the callback afterwards. A store that finished first must
    // still correct the consumer's assumed `rebuilding`.
    const store = new RedisMemoryStore({ client: makeClient() });
    await store.hydrate();

    const seen: Activity[] = [];
    store.onActivity = (a) => seen.push(a as Activity);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.health).toBe('ready');
  });

  it('reports degraded — not a stale rebuilding — when the scan fails', async () => {
    const store = new RedisMemoryStore({ client: makeClient({ failScan: true }) });
    const seen: Activity[] = [];
    store.onActivity = (a) => seen.push(a as Activity);

    await expect(store.hydrate()).rejects.toThrow('ECONNREFUSED');

    const last = seen[seen.length - 1]!;
    expect(last.health).toBe('degraded');
    expect(last.reason).toBe('redis_unreachable');
    // Still cold, so the next operation retries rather than serving an empty index.
    expect(store.isHydrated).toBe(false);
  });

  it('does not throw when no reporter is assigned', async () => {
    const store = new RedisMemoryStore({ client: makeClient() });
    await expect(store.hydrate()).resolves.toBeUndefined();
  });

  it('exposes the assigned reporter through the getter', () => {
    const store = new RedisMemoryStore({ client: makeClient(), skipHydrate: true });
    const cb = vi.fn();

    store.onActivity = cb;

    expect(store.onActivity).toBe(cb);
  });
});
