/**
 * RedisMemoryStore — failure modes and malformed state (Phase 3 risk surface).
 *
 * Complements the happy-path smoke test. Everything here is about what happens
 * when the world is NOT well behaved:
 *
 *   - Redis unreachable (health / retain / recall)
 *   - createRedisConnection with a garbage URL
 *   - record hashes written directly with malformed / missing fields
 *   - TTL filtering, including the "0 means NEVER expires" inversion (§15)
 *   - very large content (>8 KB, the om:blob threshold that is not built yet)
 *
 * REDIS SAFETY: every key this file touches is prefixed `omtest-failmode-<pid>-`
 * and lives in db 15. Cleanup is an explicit SCAN over that prefix only — never
 * FLUSHDB, never `KEYS *`, never db 0.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import { createRedisConnection } from '../redis-connection.js';

// Honour REDIS_URL so CI can point at its service container, and so the
// skip-guard can be exercised against an unreachable server.
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DEAD_URL = 'redis://localhost:6399'; // closed port
const DB = 15;

let counter = 0;
const PREFIX_ROOT = `omtest-failmode-${process.pid}-`;
const px = (): string => `${PREFIX_ROOT}${counter++}:`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Raw ioredis client, for injecting malformed state and for cleanup. */
async function rawClient(): Promise<any> {
  const mod: any = await import('ioredis');
  const Ctor = mod.default ?? mod;
  return new Ctor(URL, { db: DB, maxRetriesPerRequest: 3 });
}

/**
 * Close a store, then forcibly kill the socket. A store pointed at a dead port
 * keeps an ioredis client reconnecting forever, which would hold the worker
 * open; `quit()` alone does not stop that.
 */
async function hardClose(store: RedisMemoryStore): Promise<void> {
  const inner = (store as unknown as { client: { disconnect?: () => void } | null }).client;
  try {
    await Promise.race([store.close(), sleep(2000)]);
  } catch {
    /* ignore */
  }
  try {
    inner?.disconnect?.();
  } catch {
    /* ignore */
  }
}

const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

const REDIS_UP = await (async () => {
  try {
    const s = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: px() } });
    const h = await s.health();
    await hardClose(s);
    return h.healthy;
  } catch {
    return false;
  }
})();

const d = REDIS_UP ? describe : describe.skip;

afterAll(async () => {
  if (!REDIS_UP) return;
  const raw = await rawClient();
  try {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [next, batch] = await raw.scan(cursor, 'MATCH', `${PREFIX_ROOT}*`, 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length > 0) await raw.del(...keys);
  } finally {
    await raw.quit().catch(() => {});
  }
}, 30_000);

// ────────────────────────────────────────────────────────────────────────────
// 1. Redis unreachable
// ────────────────────────────────────────────────────────────────────────────

describe('RedisMemoryStore — unreachable Redis', () => {
  it('health() resolves { healthy: false } promptly instead of throwing or hanging', async () => {
    const store = new RedisMemoryStore({ redis: { url: DEAD_URL, db: DB, keyPrefix: px() } });
    const started = Date.now();
    const res = await store.health();
    const elapsed = Date.now() - started;
    await hardClose(store);

    expect(res).toEqual({ healthy: false });
    expect(elapsed).toBeLessThan(8_000);
  }, 30_000);

  it('retain() against a dead Redis rejects — the outage is NOT swallowed', async () => {
    const store = new RedisMemoryStore({ redis: { url: DEAD_URL, db: DB, keyPrefix: px() } });
    let outcome: unknown;
    let error: unknown;
    try {
      outcome = await store.retain('dead-scope', [{ content: 'hello world', context: 'decision' }]);
    } catch (err) {
      error = err;
    }
    const size = store.indexSize;
    await hardClose(store);

    // Design §13: a Redis outage must surface, not silently no-op.
    expect(error, `retain resolved instead of throwing: ${JSON.stringify(outcome)}`).toBeDefined();
    expect(String(error)).not.toBe('undefined');
    // Nothing may enter the derived index when the write never landed.
    expect(size).toBe(0);
  }, 30_000);

  it('recall() against a dead Redis rejects rather than reporting an empty (but confident) result', async () => {
    const store = new RedisMemoryStore({ redis: { url: DEAD_URL, db: DB, keyPrefix: px() } });
    let outcome: unknown;
    let error: unknown;
    try {
      outcome = await store.recall('dead-scope', 'hello world');
    } catch (err) {
      error = err;
    }
    const hydrated = store.isHydrated;
    await hardClose(store);

    expect(error, `recall resolved instead of throwing: ${JSON.stringify(outcome)}`).toBeDefined();
    // A failed hydration must not latch `hydrated`, or the store would serve an
    // empty index forever once Redis came back.
    expect(hydrated).toBe(false);
  }, 30_000);

  it('health() stays false on repeated probes and close() is safe afterwards', async () => {
    const store = new RedisMemoryStore({ redis: { url: DEAD_URL, db: DB, keyPrefix: px() } });
    const a = await store.health();
    const b = await store.health();
    expect(a.healthy).toBe(false);
    expect(b.healthy).toBe(false);
    await hardClose(store);
    await expect(store.close()).resolves.toBeUndefined();
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. createRedisConnection with a bogus URL
// ────────────────────────────────────────────────────────────────────────────

describe('createRedisConnection — bogus URL', () => {
  it('does not throw synchronously; the failure surfaces on the first command', async () => {
    let client: any;
    let ctorError: unknown;
    try {
      client = await createRedisConnection({ url: '!!!not-a-redis-url!!!', db: DB });
    } catch (err) {
      ctorError = err;
    }

    if (ctorError) {
      // Acceptable too: fail fast at construction.
      expect(String(ctorError)).toBeTruthy();
      return;
    }

    expect(client).toBeDefined();
    const pinged = await Promise.race([
      client.ping().then(
        (v: unknown) => ({ ok: true, v }),
        (e: unknown) => ({ ok: false, e: String(e) }),
      ),
      sleep(8000).then(() => ({ ok: false, e: 'TIMEOUT' })),
    ]);
    try {
      client.disconnect?.();
    } catch {
      /* ignore */
    }
    expect((pinged as { ok: boolean }).ok).toBe(false);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────────
// 2b. Partial outage: single commands succeed, the write pipeline fails
//
// This is the outage shape a real Redis produces when the socket dies *after*
// the store has already allocated ids (INCR) but before/while the pipeline is
// flushed. ioredis reports per-command failures inside the exec() result array
// instead of rejecting, so it needs an injected client to reproduce
// deterministically. No Redis required — these run everywhere.
// ────────────────────────────────────────────────────────────────────────────

function makeFakeClient(pipelineFails: boolean): any {
  let seq = 0;
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  // `om:scope:{scope}` is a ZSET scored by seq, so the fake models it as
  // member → score and sorts on read. Faking it as an unordered Set would let
  // an ordering regression in the store pass unnoticed.
  const zsets = new Map<string, Map<string, number>>();

  const zsorted = (key: string): string[] =>
    [...(zsets.get(key)?.entries() ?? [])]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([member]) => member);

  /** Redis ZRANGE index semantics: inclusive stop, negative counts from the end. */
  const byIndex = (arr: string[], start: number, stop: number): string[] => {
    const n = arr.length;
    let s = start < 0 ? n + start : start;
    let e = stop < 0 ? n + stop : stop;
    if (s < 0) s = 0;
    if (e >= n) e = n - 1;
    if (n === 0 || s > e) return [];
    return arr.slice(s, e + 1);
  };

  const toScore = (v: number | string): number => {
    if (typeof v === 'number') return v;
    if (v === '-inf') return Number.NEGATIVE_INFINITY;
    if (v === '+inf' || v === 'inf') return Number.POSITIVE_INFINITY;
    return Number(v);
  };

  const zaddLocal = (key: string, score: number, member: string): number => {
    let z = zsets.get(key);
    if (!z) zsets.set(key, (z = new Map()));
    const isNew = !z.has(member);
    z.set(member, Number(score));
    return isNew ? 1 : 0;
  };
  const zremLocal = (key: string, members: string[]): number => {
    const z = zsets.get(key);
    let n = 0;
    for (const m of members) if (z?.delete(m)) n++;
    return n;
  };
  const saddLocal = (key: string, members: string[]): number => {
    let s = sets.get(key);
    if (!s) sets.set(key, (s = new Set()));
    let n = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        n++;
      }
    }
    return n;
  };
  const sremLocal = (key: string, members: string[]): number => {
    const s = sets.get(key);
    let n = 0;
    for (const m of members) if (s?.delete(m)) n++;
    return n;
  };
  const delLocal = (keys: string[]): number => {
    let n = 0;
    for (const k of keys) {
      if (hashes.delete(k) || sets.delete(k) || zsets.delete(k)) n++;
    }
    return n;
  };

  const pipeline = () => {
    const queued: Array<() => [Error | null, unknown]> = [];
    const lost = (): [Error | null, unknown] => [new Error('connection lost'), null];
    const api: any = {
      hset: (key: string, values: Record<string, string>) => {
        queued.push(() =>
          pipelineFails
            ? [new Error('Stream isn\'t writeable and enableOfflineQueue options is false'), null]
            : (hashes.set(key, values), [null, 'OK']),
        );
        return api;
      },
      hgetall: (key: string) => {
        queued.push(() =>
          pipelineFails ? [new Error('connection lost'), null] : [null, hashes.get(key) ?? {}],
        );
        return api;
      },
      set: () => (queued.push(() => (pipelineFails ? lost() : [null, 'OK'])), api),
      del: (...keys: string[]) => (queued.push(() => (pipelineFails ? lost() : [null, delLocal(keys)])), api),
      sadd: (key: string, ...members: string[]) =>
        (queued.push(() => (pipelineFails ? lost() : [null, saddLocal(key, members)])), api),
      srem: (key: string, ...members: string[]) =>
        (queued.push(() => (pipelineFails ? lost() : [null, sremLocal(key, members)])), api),
      zadd: (key: string, score: number, member: string) =>
        (queued.push(() => (pipelineFails ? lost() : [null, zaddLocal(key, score, member)])), api),
      zrem: (key: string, ...members: string[]) =>
        (queued.push(() => (pipelineFails ? lost() : [null, zremLocal(key, members)])), api),
      hdel: (key: string, ...fields: string[]) => {
        queued.push(() => {
          if (pipelineFails) return lost();
          const h = hashes.get(key);
          let n = 0;
          for (const f of fields) {
            if (h && f in h) {
              delete h[f];
              n++;
            }
          }
          return [null, n];
        });
        return api;
      },
      exec: async () => queued.map((f) => f()),
    };
    return api;
  };
  return {
    hset: async () => 1,
    hgetall: async (key: string) => hashes.get(key) ?? {},
    get: async () => null,
    set: async () => 'OK',
    del: async (...keys: string[]) => delLocal(keys),
    incr: async () => ++seq,
    sadd: async (key: string, ...members: string[]) => saddLocal(key, members),
    srem: async (key: string, ...members: string[]) => sremLocal(key, members),
    smembers: async (key: string) => [...(sets.get(key) ?? [])],
    scard: async (key: string) => sets.get(key)?.size ?? 0,
    // Scope membership is a ZSET now; range()/bounds()/GC reach for these.
    zadd: async (key: string, score: number, member: string) => zaddLocal(key, score, member),
    zrem: async (key: string, ...members: string[]) => zremLocal(key, members),
    zcard: async (key: string) => zsets.get(key)?.size ?? 0,
    zrange: async (key: string, start: number, stop: number) => byIndex(zsorted(key), start, stop),
    // Inclusive at both ends, matching ZRANGEBYSCORE.
    zrangebyscore: async (key: string, min: number | string, max: number | string) => {
      const lo = toScore(min);
      const hi = toScore(max);
      const z = zsets.get(key);
      if (!z) return [];
      return zsorted(key).filter((m) => {
        const s = z.get(m)!;
        return s >= lo && s <= hi;
      });
    },
    ping: async () => 'PONG',
    quit: async () => 'OK',
    pipeline,
    // retain()/deleteScope() use MULTI so record replacement is atomic; the
    // fake exercises the same failure modes through either entry point.
    multi: pipeline,
    config: async () => ['maxmemory-policy', 'noeviction'],
    on: () => undefined,
  };
}

describe('RedisMemoryStore — write pipeline fails mid-outage', () => {
  it('retain() reports { ok:false, count:0 } when every pipelined command errored', async () => {
    const store = new RedisMemoryStore({ client: makeFakeClient(true), skipHydrate: true });
    const res = await store.retain('outage', [
      { content: 'sturgeon migration plan', context: 'decision' },
    ]);

    // Design §13: an outage must surface as degraded, not as a successful
    // write. `pipe.exec()` resolves with [Error, null] tuples rather than
    // rejecting, so the per-command results have to be inspected.
    expect(res).toEqual({ ok: false, count: 0 });
  });

  it('retain() does not throw for a pipeline outage — the failure is in the outcome', async () => {
    const store = new RedisMemoryStore({ client: makeFakeClient(true), skipHydrate: true });
    const res = await store.retain('outage', [
      { content: 'sturgeon migration plan', context: 'decision' },
    ]);
    expect(res.ok).toBe(false);
    expect(res.count).toBe(0);

    // A record that never landed must not be recallable from the hot store
    // either — the failed write leaves no trace anywhere.
    const out = await store.recall('outage', 'sturgeon migration plan', { minRelevance: 0.1 });
    expect(out.records).toHaveLength(0);
  });

  it('the index does not claim a record the store does not have', async () => {
    const store = new RedisMemoryStore({ client: makeFakeClient(true), skipHydrate: true });
    await store.retain('outage', [{ content: 'sturgeon migration plan', context: 'decision' }]).catch(() => {});
    // A record whose commands errored is neither counted nor indexed, so the
    // derived index cannot serve phantom recalls for content Redis lacks.
    expect(store.indexSize).toBe(0);
  });

  it('a failed read pipeline yields 0 records and bills 0 tokens', async () => {
    // Writes land, reads fail: the derived index is right, Redis reads are not.
    const client = makeFakeClient(false);
    const store = new RedisMemoryStore({ client, skipHydrate: true });
    await store.retain('outage', [{ content: 'sturgeon migration plan', context: 'decision' }]);
    expect(store.indexSize).toBe(1);

    // Now break reads.
    const broken = makeFakeClient(true);
    (store as unknown as { client: unknown }).client = broken;

    const out = await store.recall('outage', 'sturgeon migration plan', { minRelevance: 0.1 });
    expect(out.records).toHaveLength(0);
    // tokensUsed bills only for content actually delivered, so a total read
    // failure cannot report "spent budget, found nothing".
    expect(out.tokensUsed).toBe(0);
    expect(out.lowConfidence).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Malformed record hashes written directly
// ────────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — malformed records in Redis', () => {
  it('hydrate() and recall() survive garbage hashes, orphan ids and unknown scopes', async () => {
    const prefix = px();
    const scope = 'malformed';
    const raw = await rawClient();

    // One well-formed record, written through the store.
    const seed = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });
    await seed.retain(scope, [
      { content: 'quantum flux capacitor calibration notes', context: 'decision' },
    ]);
    await hardClose(seed);

    const kRec = (id: number | string) => `${prefix}rec:${id}`;
    const kScope = (s: string) => `${prefix}scope:${s}`;

    // (a) tokens/timestamp garbage, no scope field.
    const idA = await raw.incr(`${prefix}seq`);
    await raw.hset(kRec(idA), {
      content: 'quantum flux capacitor spare parts',
      context: 'decision',
      tokens: 'not-a-number',
      timestamp: 'garbage',
    });
    await raw.zadd(kScope(scope), Number(idA), String(idA));

    // (b) content only — every other field missing.
    const idB = await raw.incr(`${prefix}seq`);
    await raw.hset(kRec(idB), { content: 'quantum flux bare record' });
    await raw.zadd(kScope(scope), Number(idB), String(idB));

    // (c) hash with an EMPTY content field.
    const idC = await raw.incr(`${prefix}seq`);
    await raw.hset(kRec(idC), { content: '', scope, context: 'decision', timestamp: daysAgo(1) });
    await raw.zadd(kScope(scope), Number(idC), String(idC));

    // (d) an id in the scope zset with no hash behind it at all.
    await raw.zadd(kScope(scope), 999999999, '999999999');

    // (e) a non-numeric MEMBER in the scope zset. The score must be a number —
    // Redis rejects a NaN score — so the garbage lives in the member, which is
    // what hydrate() has to survive coercing.
    await raw.zadd(kScope(scope), 0, 'not-an-id');

    // (f) a scope listed in om:scopes with no member set.
    await raw.sadd(`${prefix}scopes`, 'phantom-scope');

    await raw.quit().catch(() => {});

    // Fresh store: full hydration over the mess.
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(store.isHydrated).toBe(true);

    const out = await store.recall(scope, 'quantum flux capacitor', { minRelevance: 0.1 });
    expect(Array.isArray(out.records)).toBe(true);
    // The well-formed record is still reachable.
    expect(out.records.some((r) => r.content.includes('calibration notes'))).toBe(true);
    // Nothing crashed and no undefined leaked into the payload.
    for (const r of out.records) {
      expect(typeof r.content).toBe('string');
      expect(typeof r.context).toBe('string');
      expect(typeof r.timestamp).toBe('string');
      expect(Number.isFinite(r.relevance)).toBe(true);
      expect(Number.isFinite(r.estimatedTokens ?? 0)).toBe(true);
    }

    // listScopes tolerates the phantom scope.
    const scopes = await store.listScopes();
    expect(scopes.find((s) => s.id === 'phantom-scope')?.recordCount).toBe(0);

    await hardClose(store);
  }, 30_000);

  it('a record whose hash has no `scope` field becomes unrecallable even though Redis knows its scope', async () => {
    const prefix = px();
    const scope = 'scopeless';
    const raw = await rawClient();

    const id = await raw.incr(`${prefix}seq`);
    await raw.hset(`${prefix}rec:${id}`, {
      content: 'orphaned zeppelin telemetry payload',
      context: 'decision',
      timestamp: daysAgo(1),
      tokens: '10',
      // `scope` deliberately absent
    });
    await raw.zadd(`${prefix}scope:${scope}`, Number(id), String(id));
    await raw.sadd(`${prefix}scopes`, scope);
    await raw.quit().catch(() => {});

    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });
    await store.hydrate();

    // It IS indexed …
    expect(store.indexSize).toBe(1);
    // … but recall for its real scope drops it, because ingestIntoIndex takes
    // the scope from the hash rather than from the set it was found in.
    const out = await store.recall(scope, 'orphaned zeppelin telemetry', { minRelevance: 0.1 });
    expect(out.records).toHaveLength(0);
    expect(out.lowConfidence).toBe(true);

    await hardClose(store);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. TTL / expiry — including the "0 means NEVER" inversion
// ────────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — expiry filtering in recall()', () => {
  it('drops records past their category TTL and keeps TTL-0 categories forever', async () => {
    const prefix = px();
    const scope = 'ttl';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    await store.retain(scope, [
      // node_output: 14 day TTL → 60 days old is expired.
      { content: 'aardvark telemetry marker alpha', context: 'node_output', timestamp: daysAgo(60) },
      // session_anchor: 30 day TTL → 400 days old is expired.
      { content: 'aardvark telemetry marker bravo', context: 'session_anchor', timestamp: daysAgo(400) },
      // session_summary: 180 day TTL → 200 days old is expired.
      { content: 'aardvark telemetry marker charlie', context: 'session_summary', timestamp: daysAgo(200) },
      // decision: TTL 0 = NEVER expires, even at 5 years.
      { content: 'aardvark telemetry marker delta', context: 'decision', timestamp: daysAgo(1825) },
      // lesson: also pinned / TTL 0.
      { content: 'aardvark telemetry marker echo', context: 'lesson', timestamp: daysAgo(4000) },
      // unknown category → falls through to defaultTTLDays 0 = never expires.
      { content: 'aardvark telemetry marker foxtrot', context: 'no_such_category', timestamp: daysAgo(4000) },
      // node_output well inside its TTL.
      { content: 'aardvark telemetry marker golf', context: 'node_output', timestamp: daysAgo(1) },
    ]);

    const out = await store.recall(scope, 'aardvark telemetry marker', {
      minRelevance: 0.1,
      maxTokens: 100_000,
    });
    const seen = out.records.map((r) => r.content.split(' ').pop());

    expect(seen).not.toContain('alpha');
    expect(seen).not.toContain('bravo');
    expect(seen).not.toContain('charlie');
    // The 0-means-never inversion (§15) must NOT be read as "expires immediately".
    expect(seen).toContain('delta');
    expect(seen).toContain('echo');
    expect(seen).toContain('foxtrot');
    expect(seen).toContain('golf');

    await store.deleteScope(scope);
    await hardClose(store);
  }, 30_000);

  it('an unparseable timestamp is treated as never-expired rather than crashing', async () => {
    const prefix = px();
    const scope = 'ttl-garbage';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    await store.retain(scope, [
      { content: 'badger sundial inscription', context: 'node_output', timestamp: 'totally-not-a-date' },
    ]);

    const out = await store.recall(scope, 'badger sundial inscription', { minRelevance: 0.1 });
    expect(out.records).toHaveLength(1);

    await store.deleteScope(scope);
    await hardClose(store);
  }, 30_000);

  it('isDuplicate() honours expiry, so an unrecallable record does not block re-learning', async () => {
    const prefix = px();
    const scope = 'ttl-dup';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    const content = 'cormorant migration checkpoint delta seven';
    await store.retain(scope, [{ content, context: 'node_output', timestamp: daysAgo(90) }]);

    // Expired: recall cannot see it.
    const out = await store.recall(scope, content, { minRelevance: 0.1 });
    expect(out.records).toHaveLength(0);

    // …and isDuplicate agrees: a record nobody can recall must not veto
    // re-learning the same content.
    expect(await store.isDuplicate(scope, content)).toBe(false);

    // Positive control: a LIVE byte-identical record IS detected. This is short
    // content, which the old score-based check could never flag — a byte-
    // identical short record ceilinged at 0.80, below the 0.85 default.
    await store.retain(scope, [{ content, context: 'node_output', timestamp: new Date().toISOString() }]);
    expect(await store.isDuplicate(scope, content)).toBe(true);

    await store.deleteScope(scope);
    await hardClose(store);
  }, 30_000);
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Very large content (om:blob offload is not implemented yet)
// ────────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — oversized content', () => {
  it('round-trips ~200 KB of content intact when the token budget allows it', async () => {
    const prefix = px();
    const scope = 'big';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    const filler = 'pelican '.repeat(25_000); // ~200 KB
    const content = `narwhal ledger opening ${filler} narwhal ledger closing`;
    expect(content.length).toBeGreaterThan(200_000);

    await store.retain(scope, [
      { content, context: 'decision', timestamp: new Date().toISOString() },
    ]);

    const out = await store.recall(scope, 'narwhal ledger', {
      minRelevance: 0.1,
      maxTokens: 1_000_000,
    });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.content).toBe(content);
    expect(out.records[0]!.content.length).toBe(content.length);

    // Survives a full rebuild from Redis too.
    await hardClose(store);
    const fresh = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });
    await fresh.hydrate();
    const out2 = await fresh.recall(scope, 'narwhal ledger', {
      minRelevance: 0.1,
      maxTokens: 1_000_000,
    });
    expect(out2.records[0]?.content).toBe(content);

    await fresh.deleteScope(scope);
    await hardClose(fresh);
  }, 60_000);

  it('a record larger than the default token budget is silently unrecallable', async () => {
    const prefix = px();
    const scope = 'big-default';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    const big = `walrus dossier ${'walrus '.repeat(5_000)}`; // ~9 000 tokens > 4 096
    const small = 'walrus dossier summary line';
    await store.retain(scope, [
      { content: big, context: 'decision' },
      { content: small, context: 'decision' },
    ]);

    // Default maxTokens (4096) cannot fit the big record; the small one still
    // gets through, so this is a partial rather than total blackout.
    const out = await store.recall(scope, 'walrus dossier', { minRelevance: 0.1 });
    const contents = out.records.map((r) => r.content);
    expect(contents).toContain(small);
    expect(contents).not.toContain(big);

    await store.deleteScope(scope);
    await hardClose(store);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// 6. documentId upsert edge cases
// ────────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — documentId upsert edge cases', () => {
  it('two writes sharing a documentId in ONE batch collapse to one record, last write wins', async () => {
    const prefix = px();
    const scope = 'docid-batch';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    await store.retain(scope, [
      { content: 'ibex roster version one', context: 'decision', documentId: 'roster' },
      { content: 'ibex roster version two', context: 'decision', documentId: 'roster' },
    ]);

    const out = await store.recall(scope, 'ibex roster version', {
      minRelevance: 0.1,
      maxTokens: 100_000,
    });
    // The idempotency key dedupes within a single batch too, so the earlier
    // revision never allocates an id that nothing can reach.
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.content).toBe('ibex roster version two');

    // Nothing is orphaned: a later upsert replaces the one record the docid
    // pointer references, and no earlier revision survives alongside it.
    await store.retain(scope, [
      { content: 'ibex roster version three', context: 'decision', documentId: 'roster' },
    ]);
    const out2 = await store.recall(scope, 'ibex roster version', {
      minRelevance: 0.1,
      maxTokens: 100_000,
    });
    const texts = out2.records.map((r) => r.content).sort();
    expect(texts).toEqual(['ibex roster version three']);

    await store.deleteScope(scope);
    await hardClose(store);
  }, 30_000);

  it('a documentId upsert replaces the hash, dropping fields the new revision omits', async () => {
    const prefix = px();
    const scope = 'docid-stale';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    await store.retain(scope, [
      {
        content: 'okapi inventory v1',
        context: 'decision',
        documentId: 'inv',
        tags: ['draft', 'private'],
        importance: 0.9,
      },
    ]);
    await store.retain(scope, [
      { content: 'okapi inventory v2', context: 'decision', documentId: 'inv' },
    ]);

    const raw = await rawClient();
    const id = await raw.get(`${prefix}docid:${scope}:inv`);
    const rec = await raw.hgetall(`${prefix}rec:${id}`);
    await raw.quit().catch(() => {});

    expect(rec.content).toBe('okapi inventory v2');
    // HSET merges, so the upsert path DELs first: v1's tags/importance must not
    // survive a revision that omits them, or the stored record becomes a union
    // of every version ever written.
    expect(rec.tags).toBeUndefined();
    expect(rec.importance).toBeUndefined();
    // The fields the new revision does carry are intact.
    expect(rec.documentId).toBe('inv');
    expect(rec.scope).toBe(scope);

    await store.deleteScope(scope);
    await hardClose(store);
  }, 30_000);

  it('deleteScope() removes the om:docid pointers, so a later retain cannot resurrect an id', async () => {
    const prefix = px();
    const scope = 'docid-delete';
    const store = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

    await store.retain(scope, [
      { content: 'quokka ledger entry', context: 'decision', documentId: 'ledger' },
    ]);
    await store.deleteScope(scope);

    const raw = await rawClient();
    const leftover = await raw.get(`${prefix}docid:${scope}:ledger`);

    // The pointer does not outlive the scope it belonged to.
    expect(leftover).toBeNull();

    // …which is what stops a re-write from resolving a stale pointer and
    // writing into a record the scope set no longer references.
    const res = await store.retain(scope, [
      { content: 'quokka ledger entry two', context: 'decision', documentId: 'ledger' },
    ]);
    expect(res.ok).toBe(true);

    const reborn = await raw.get(`${prefix}docid:${scope}:ledger`);
    expect(reborn).not.toBeNull();
    const rec = await raw.hgetall(`${prefix}rec:${reborn}`);
    expect(rec.content).toBe('quokka ledger entry two');
    // The revived documentId points at a record the scope zset actually holds,
    // scored by its own seq.
    expect(await raw.zrange(`${prefix}scope:${scope}`, 0, -1)).toContain(String(reborn));
    expect(await raw.zscore(`${prefix}scope:${scope}`, String(reborn))).toBe(String(reborn));

    const out = await store.recall(scope, 'quokka ledger entry', {
      minRelevance: 0.1,
      maxTokens: 100_000,
    });
    expect(out.records.map((r) => r.content)).toEqual(['quokka ledger entry two']);

    await raw.quit().catch(() => {});
    await store.deleteScope(scope);
    await hardClose(store);
  }, 30_000);
});
