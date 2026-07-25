/**
 * Tests for the background GC scheduler.
 *
 * `collectGarbage()` existing is not the same as GC happening — before this
 * scheduler it was a method nobody called, so expired records accumulated
 * forever while the read-time TTL filter hid the growth.
 *
 * The failure modes here are the ones that do not show up in a happy-path test:
 * a timer that keeps the process alive, overlapping passes racing each other,
 * and an async throw inside a timer callback (an unhandled rejection, which
 * takes the process down).
 *
 * Uses fake timers and an injected in-memory client — the 60 s floor on the
 * interval makes real-time scheduling untestable, and these assertions are
 * about control flow, not Redis behaviour. `redis-store-*.test.ts` cover the
 * collection semantics against a real server.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import type { RedisLike, RedisPipeline } from '../redis-connection.js';

// ── minimal in-memory client ────────────────────────────────────────────────

interface FakeOpts {
  /** Make every collectGarbage pass reject, to test error containment. */
  failScan?: boolean;
  /** Resolve scan only when released, to hold a pass open. */
  blockScan?: boolean;
}

function makeFake(opts: FakeOpts = {}) {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  /** Scope membership is a ZSET now: member -> score (the record's seq). */
  const zsets = new Map<string, Map<string, number>>();
  let seq = 0;
  let scanCalls = 0;
  let getCalls = 0;
  let release: (() => void) | null = null;

  const sadd = (k: string, ...m: string[]) => {
    const s = sets.get(k) ?? new Set<string>();
    m.forEach((x) => s.add(x));
    sets.set(k, s);
    return 1;
  };

  const zadd = (k: string, score: number, member: string) => {
    const z = zsets.get(k) ?? new Map<string, number>();
    const isNew = !z.has(member);
    z.set(member, score);
    zsets.set(k, z);
    return isNew ? 1 : 0;
  };

  const zrem = (k: string, ...m: string[]) => {
    const z = zsets.get(k);
    if (!z) return 0;
    let n = 0;
    for (const x of m) if (z.delete(x)) n++;
    return n;
  };

  /** Members in score order, ties broken lexicographically — as Redis does. */
  const sorted = (k: string): string[] =>
    [...(zsets.get(k) ?? new Map<string, number>()).entries()]
      .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([member]) => member);

  const chain = (): RedisPipeline => {
    const ops: Array<() => void> = [];
    const api: RedisPipeline = {
      hset: (k, v) => (ops.push(() => hashes.set(k, { ...(hashes.get(k) ?? {}), ...v })), api),
      hgetall: (k) => (ops.push(() => void hashes.get(k)), api),
      set: (k, v) => (ops.push(() => hashes.set(k, { __v: v })), api),
      del: (...ks) => (ops.push(() => ks.forEach((k) => { hashes.delete(k); sets.delete(k); zsets.delete(k); })), api),
      sadd: (k, ...m) => (ops.push(() => sadd(k, ...m)), api),
      srem: (k, ...m) => (ops.push(() => m.forEach((x) => sets.get(k)?.delete(x))), api),
      zadd: (k, score, member) => (ops.push(() => zadd(k, score, member)), api),
      zrem: (k, ...m) => (ops.push(() => zrem(k, ...m)), api),
      hdel: (k, ...fields) => (
        ops.push(() => {
          const h = hashes.get(k);
          if (h) fields.forEach((f) => delete h[f]);
        }),
        api
      ),
      exec: async () => {
        const out: Array<[Error | null, unknown]> = [];
        for (const op of ops) {
          op();
          out.push([null, 1]);
        }
        return out;
      },
    };
    return api;
  };

  const client = {
    hset: async (k: string, v: Record<string, string>) => (hashes.set(k, v), 1),
    hgetall: async (k: string) => hashes.get(k) ?? {},
    get: async (k: string) => { getCalls++; return k.endsWith('seq') ? String(seq) : null; },
    set: async () => 'OK',
    del: async () => 1,
    incr: async () => ++seq,
    sadd: async (k: string, ...m: string[]) => sadd(k, ...m),
    srem: async () => 1,
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    scard: async (k: string) => sets.get(k)?.size ?? 0,
    zadd: async (k: string, score: number, member: string) => zadd(k, score, member),
    zrem: async (k: string, ...m: string[]) => zrem(k, ...m),
    zcard: async (k: string) => zsets.get(k)?.size ?? 0,
    zrange: async (k: string, start: number, stop: number) => {
      const all = sorted(k);
      const lo = start < 0 ? Math.max(all.length + start, 0) : start;
      const hi = stop < 0 ? all.length + stop : Math.min(stop, all.length - 1);
      return lo > hi ? [] : all.slice(lo, hi + 1);
    },
    // Inclusive at both ends, per Redis ZRANGEBYSCORE.
    zrangebyscore: async (k: string, min: number | string, max: number | string) => {
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      const z = zsets.get(k) ?? new Map<string, number>();
      return sorted(k).filter((m) => {
        const s = z.get(m)!;
        return s >= lo && s <= hi;
      });
    },
    ping: async () => 'PONG',
    quit: async () => 'OK',
    config: async () => ['maxmemory-policy', 'noeviction'],
    on: () => undefined,
    pipeline: chain,
    multi: chain,
    scan: async (): Promise<[string, string[]]> => {
      scanCalls++;
      if (opts.failScan) throw new Error('SCAN exploded');
      if (opts.blockScan) await new Promise<void>((r) => { release = r; });
      return ['0', []];
    },
  } as unknown as RedisLike;

  return {
    client,
    get scanCalls() { return scanCalls; },
    get getCalls() { return getCalls; },
    releaseScan() { release?.(); release = null; },
  };
}

function makeStore(fake: ReturnType<typeof makeFake>): RedisMemoryStore {
  return new RedisMemoryStore({ client: fake.client, skipHydrate: true });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RedisMemoryStore — GC scheduling', () => {
  it('does not scan until the initial delay elapses', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    await store.retain('s', [{ content: 'something worth keeping', context: 'lesson' }]);
    store.startGc({ initialDelayMs: 1000, intervalMs: 60_000 });

    expect(fake.scanCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.scanCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.scanCalls).toBe(1);

    store.stopGc();
  });

  it('repeats on the interval after the first pass', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
    await vi.advanceTimersByTimeAsync(11);
    expect(fake.scanCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.scanCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.scanCalls).toBe(3);

    store.stopGc();
  });

  it('skips a pass when nothing was written since the last one', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    // minWritesBetweenRuns defaults to 1, and nothing has been retained.
    store.startGc({ initialDelayMs: 10, intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(11);
    expect(fake.scanCalls).toBe(0);

    // A write makes the next pass eligible.
    await store.retain('s', [{ content: 'now there is something to collect', context: 'lesson' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.scanCalls).toBe(1);

    // And the pass having consumed it, the keyspace is idle again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.scanCalls).toBe(1);

    store.stopGc();
  });

  it('does not start a second pass while one is still running', async () => {
    vi.useFakeTimers();
    const fake = makeFake({ blockScan: true });
    const store = makeStore(fake);

    store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
    await vi.advanceTimersByTimeAsync(11);
    expect(fake.scanCalls).toBe(1); // in flight, blocked

    // Several intervals elapse while the first pass is still going.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fake.scanCalls).toBe(1);

    fake.releaseScan();
    await vi.advanceTimersByTimeAsync(0);

    // Once it finishes, the loop resumes normally.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.scanCalls).toBe(2);

    store.stopGc();
  });

  it('contains a failing pass instead of raising an unhandled rejection', async () => {
    vi.useFakeTimers();
    const fake = makeFake({ failScan: true });
    const store = makeStore(fake);

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
      await vi.advanceTimersByTimeAsync(11);
      await vi.advanceTimersByTimeAsync(60_000);

      // Failures must not stop the loop, and must not escape it.
      expect(fake.scanCalls).toBe(2);
      expect(unhandled).not.toHaveBeenCalled();
      expect(store.lastGcReport).toBeNull();
    } finally {
      process.off('unhandledRejection', unhandled);
      store.stopGc();
    }
  });

  it('records the last successful pass for diagnostics', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    expect(store.lastGcReport).toBeNull();
    store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
    await vi.advanceTimersByTimeAsync(11);

    expect(store.lastGcReport).not.toBeNull();
    expect(store.lastGcReport!.report.dryRun).toBe(false);
    expect(typeof store.lastGcReport!.at).toBe('string');

    store.stopGc();
  });

  it('startGc is idempotent and stopGc halts the loop', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
    store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
    await vi.advanceTimersByTimeAsync(11);
    expect(fake.scanCalls).toBe(1); // not 2 — the second start was a no-op

    store.stopGc();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.scanCalls).toBe(1);
  });

  it('close() releases the sync loop as well as GC', async () => {
    // The bridge owns a Redis connection plus TWO background timers. A
    // shutdown that stops only one leaves the other polling a closed client.
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
    store.startSync(1_000);

    // Let BOTH loops run at least once, so each has an observable counter to
    // freeze. Asserting only on the GC counter would pass even if stopSync()
    // were removed, since close() stops GC either way.
    await vi.advanceTimersByTimeAsync(2_100);
    const gcBefore = fake.scanCalls;
    const syncBefore = fake.getCalls;
    expect(gcBefore).toBeGreaterThan(0);
    expect(syncBefore).toBeGreaterThan(0);

    await store.close();
    await vi.advanceTimersByTimeAsync(600_000);

    // NEITHER loop may fire again.
    expect(fake.scanCalls, 'GC loop kept running after close()').toBe(gcBefore);
    expect(fake.getCalls, 'sync loop kept running after close()').toBe(syncBefore);
  });

  it('close() is idempotent', async () => {
    vi.useRealTimers();
    const fake = makeFake();
    const store = makeStore(fake);
    store.startGc({ initialDelayMs: 60_000 });
    store.startSync(5_000);
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('startSync is idempotent and stopSync halts it', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    // A second startSync must not create a second interval, or every tick
    // would run two overlapping syncs against one connection.
    store.startSync(1_000);
    store.startSync(1_000);

    // The FIRST tick only hydrates — an unhydrated store has nothing to delta
    // against, so hydration supersedes sync. The GET high-water probe starts
    // on the second tick.
    await vi.advanceTimersByTimeAsync(2_100);
    const calls = fake.getCalls;
    expect(calls).toBeGreaterThan(0);

    store.stopSync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.getCalls).toBe(calls);
  });

  it('close() stops the loop', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    store.startGc({ initialDelayMs: 10, intervalMs: 60_000, minWritesBetweenRuns: 0 });
    await vi.advanceTimersByTimeAsync(11);
    expect(fake.scanCalls).toBe(1);

    await store.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.scanCalls).toBe(1);
  });

  it('unrefs its timers so a background chore cannot keep the process alive', () => {
    vi.useRealTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    const unrefs: string[] = [];
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    // Capture whether unref() is called on each timer the scheduler creates.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const t = realTimeout(fn, ms);
      const orig = t.unref?.bind(t);
      (t as { unref?: () => unknown }).unref = () => { unrefs.push('timeout'); return orig?.(); };
      return t;
    }) as typeof globalThis.setTimeout;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const t = realInterval(fn, ms);
      const orig = t.unref?.bind(t);
      (t as { unref?: () => unknown }).unref = () => { unrefs.push('interval'); return orig?.(); };
      return t;
    }) as typeof globalThis.setInterval;

    try {
      store.startGc({ initialDelayMs: 60_000, intervalMs: 60_000 });
      expect(unrefs).toContain('timeout');
    } finally {
      globalThis.setTimeout = realTimeout;
      globalThis.setInterval = realInterval;
      store.stopGc();
    }
  });

  it('floors the interval at 60s so a misconfiguration cannot spin', async () => {
    vi.useFakeTimers();
    const fake = makeFake();
    const store = makeStore(fake);

    store.startGc({ initialDelayMs: 1, intervalMs: 1, minWritesBetweenRuns: 0 });
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.scanCalls).toBe(1);

    // If the 1 ms interval were honoured this would be thousands of passes.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fake.scanCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.scanCalls).toBe(2);

    store.stopGc();
  });
});
