/**
 * Divergence probes for {@link RedisMemoryStore}.
 *
 * The in-process {@link MemoryIndex} is DERIVED state; Redis is authoritative.
 * Every test here attacks a path where the two can disagree:
 *
 *   phantom hit  — the index claims a record Redis no longer has
 *   silent loss  — Redis has a record the index never learns about
 *
 * REDIS SAFETY: db 15 only, one pid-scoped key prefix, cleanup deletes only
 * keys matching that prefix (SCAN + DEL, never FLUSH/KEYS *).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import { createRedisConnection, type RedisLike } from '../redis-connection.js';

const URL = 'redis://localhost:6379';
const DB = 15;

/** Unique to this file AND this process — sibling suites share the server. */
const BASE = `omtest-divergence-${process.pid}-`;
let px_n = 0;
/** A fresh, fully isolated keyspace (and therefore its own om:seq) per test. */
const px = (label: string): string => `${BASE}${label}-${px_n++}:`;

const mk = (prefix: string): RedisMemoryStore =>
  new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

// ── raw client, for asserting against Redis behind the store's back ────────

interface RawClient extends RedisLike {
  scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  exists(key: string): Promise<number>;
}

let rawSingleton: RawClient | null = null;
async function raw(): Promise<RawClient> {
  if (!rawSingleton) {
    rawSingleton = (await createRedisConnection({ url: URL, db: DB })) as RawClient;
  }
  return rawSingleton;
}

const REDIS_UP = await (async () => {
  try {
    const s = mk(px('probe'));
    const h = await s.health();
    await s.close();
    return h.healthy;
  } catch {
    return false;
  }
})();

const d = REDIS_UP ? describe : describe.skip;

afterAll(async () => {
  if (!REDIS_UP) return;
  const c = await raw();
  // Delete ONLY keys we created. SCAN with our own pid-scoped MATCH.
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await c.scan(cursor, 'MATCH', `${BASE}*`, 'COUNT', '500');
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    if (slice.length > 0) await c.del(...slice);
  }
  await c.quit();
  rawSingleton = null;
});

const W = (content: string, context = 'decision') => ({ content, context });

// Long enough that the index's length penalty (< 20 normalised chars → x0.8)
// does not apply, so an exact match scores a clean 1.0.
const LONG_A = 'the deployment pipeline uses blue green rollouts for the api gateway';
const LONG_B = 'quarterly revenue reconciliation happens inside the billing ledger service';

// ──────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — index/Redis agreement after retain', () => {
  it('index size equals the number of records actually in Redis, across scopes', async () => {
    const prefix = px('agree');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('alpha', [W('alpha one about widgets'), W('alpha two about gadgets')]);
    await store.retain('beta', [W('beta one about sprockets')]);

    expect(store.indexSize).toBe(3);

    const scopes = await c.smembers(`${prefix}scopes`);
    expect(scopes.sort()).toEqual(['alpha', 'beta']);

    let redisRecords = 0;
    for (const s of scopes) {
      // om:scope:{scope} is a ZSET scored by seq; ZRANGE 0 -1 is the whole set.
      const ids = await c.zrange(`${prefix}scope:${s}`, 0, -1);
      for (const id of ids) {
        const rec = await c.hgetall(`${prefix}rec:${id}`);
        expect(rec.content).toBeTruthy();
        expect(rec.scope).toBe(s);
        redisRecords++;
      }
    }
    expect(redisRecords).toBe(store.indexSize);

    await store.close();
  });

  it('every recalled record corresponds to a live om:rec hash', async () => {
    const prefix = px('recalled');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('s', [W(LONG_A), W(LONG_B)]);
    const out = await store.recall('s', LONG_A);
    expect(out.records.length).toBeGreaterThan(0);

    const ids = await c.zrange(`${prefix}scope:s`, 0, -1);
    const contents = new Set<string>();
    for (const id of ids) contents.add((await c.hgetall(`${prefix}rec:${id}`)).content!);
    for (const r of out.records) expect(contents.has(r.content)).toBe(true);

    await store.close();
  });

  it('concurrent first-touch callers hydrate once, not twice', async () => {
    const prefix = px('concurrent');
    const seed = mk(prefix);
    await seed.retain('s', [W(LONG_A), W(LONG_B)]);
    await seed.close();

    const store = mk(prefix);
    await Promise.all([
      store.recall('s', LONG_A),
      store.recall('s', LONG_B),
      store.hydrate(),
      store.isDuplicate('s', LONG_A),
    ]);
    expect(store.indexSize).toBe(2);
    await store.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — phantom index entries (Redis loses a record)', () => {
  it('recall skips AND evicts a record whose om:rec hash was deleted underneath it', async () => {
    const prefix = px('phantom');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('s', [W(LONG_A)]);
    const [id] = await c.zrange(`${prefix}scope:s`, 0, -1);

    // Kill the hash but leave the scope membership and the live index alone.
    await c.del(`${prefix}rec:${id}`);

    const out = await store.recall('s', LONG_A);

    // No crash, no phantom content.
    expect(out.records).toEqual([]);
    expect(out.lowConfidence).toBe(true);

    // The index used to keep believing the record existed — a divergence that
    // survived until the next full hydration and made indexSize lie. Recall
    // already discovered the miss at fetch time; now the discovery repairs it.
    expect(store.indexSize).toBe(0);

    await store.close();
  });

  it('tokensUsed bills only records actually returned, not phantoms', async () => {
    const prefix = px('phantom-tokens');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('s', [W(LONG_A)]);
    const [id] = await c.zrange(`${prefix}scope:s`, 0, -1);
    await c.del(`${prefix}rec:${id}`);

    const out = await store.recall('s', LONG_A);
    expect(out.records).toEqual([]);
    // Nothing was delivered, so no budget may be reported as consumed. The
    // budget fill runs off in-process metadata; billing runs off the fetch.
    expect(out.tokensUsed).toBe(0);

    await store.close();
  });

  it('tokensUsed drops by exactly the dead record when one of two vanishes', async () => {
    const prefix = px('phantom-tokens-partial');
    const store = mk(prefix);
    const c = await raw();

    // Two records similar enough that one query pulls both into the budget.
    const KEEP = 'the deployment pipeline uses canary rollouts for the api gateway';
    await store.retain('s', [W(LONG_A), W(KEEP)]);

    const before = await store.recall('s', LONG_A);
    expect(before.records.map((r) => r.content).sort()).toEqual([LONG_A, KEEP].sort());
    const doomed = before.records.find((r) => r.content === LONG_A)!;
    expect(before.tokensUsed).toBe(
      before.records.reduce((n, r) => n + r.estimatedTokens, 0),
    );

    // Kill the LONG_A hash; the derived index still ranks it, so it is still
    // chosen and still consumes budget during the fill.
    const ids = await c.zrange(`${prefix}scope:s`, 0, -1);
    for (const id of ids) {
      const rec = await c.hgetall(`${prefix}rec:${id}`);
      if (rec.content === LONG_A) await c.del(`${prefix}rec:${id}`);
    }

    const after = await store.recall('s', LONG_A);
    expect(after.records.map((r) => r.content)).toEqual([KEEP]);
    // Billing follows delivery, not the fill: exactly the dead record's cost
    // is refunded rather than charged to the caller.
    expect(after.tokensUsed).toBe(before.tokensUsed - doomed.estimatedTokens);
    // Non-degenerate: a real charge remains, and it really did shrink.
    expect(doomed.estimatedTokens).toBeGreaterThan(0);
    expect(after.tokensUsed).toBeGreaterThan(0);
    expect(after.tokensUsed).toBeLessThan(before.tokensUsed);

    await store.close();
  });

  it('a deleted record stays a phantom until a fresh store re-hydrates', async () => {
    const prefix = px('phantom-rehydrate');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('s', [W(LONG_A), W(LONG_B)]);
    const ids = await c.zrange(`${prefix}scope:s`, 0, -1);
    await c.del(`${prefix}rec:${ids[0]}`);

    expect(store.indexSize).toBe(2); // live store: still 2
    await store.close();

    const fresh = mk(prefix);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(1); // rehydrated: the phantom is gone
    await fresh.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — silent loss (Redis gains a record the index lacks)', () => {
  it('a record written directly to Redis is invisible until re-hydration', async () => {
    const prefix = px('sideload');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('s', [W(LONG_B)]);
    expect(store.indexSize).toBe(1);

    // Write a record the store never saw.
    const id = await c.incr(`${prefix}seq`);
    await c.hset(`${prefix}rec:${id}`, {
      scope: 's',
      content: LONG_A,
      context: 'decision',
      timestamp: new Date().toISOString(),
      tokens: '20',
    });
    // Scope membership is a ZSET scored by the record's seq (== its id).
    await c.zadd(`${prefix}scope:s`, Number(id), String(id));
    await c.sadd(`${prefix}scopes`, 's');

    const live = await store.recall('s', LONG_A);
    expect(live.records.map((r) => r.content)).not.toContain(LONG_A);
    expect(store.indexSize).toBe(1);
    await store.close();

    const fresh = mk(prefix);
    const after = await fresh.recall('s', LONG_A);
    expect(after.records.map((r) => r.content)).toContain(LONG_A);
    expect(fresh.indexSize).toBe(2);
    await fresh.close();
  });

  it('an empty-content record is indexed by neither the live store nor re-hydration', async () => {
    const prefix = px('empty-content');
    const store = mk(prefix);
    const c = await raw();

    const out = await store.retain('s', [W(''), W(LONG_A)]);
    // Both writes reached Redis — the empty one is stored, just not indexed.
    expect(out).toEqual({ ok: true, count: 2 });
    expect(await c.zcard(`${prefix}scope:s`)).toBe(2);

    // retain() applies hydrate()'s `if (!rec.content) continue` rule, so the
    // hot index and a rebooted index agree.
    expect(store.indexSize).toBe(1);
    await store.close();

    const fresh = mk(prefix);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(store.indexSize);
    await fresh.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — deleteScope', () => {
  it('removes index and meta entries on the SAME instance', async () => {
    const prefix = px('delscope');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('gone', [W(LONG_A)]);
    await store.retain('kept', [W(LONG_B)]);
    expect(store.indexSize).toBe(2);

    await store.deleteScope('gone');

    expect(store.indexSize).toBe(1);
    const out = await store.recall('gone', LONG_A);
    expect(out.records).toEqual([]);

    // The surviving scope is untouched, in Redis and in the index.
    const kept = await store.recall('kept', LONG_B);
    expect(kept.records.map((r) => r.content)).toContain(LONG_B);
    expect(await c.exists(`${prefix}scope:gone`)).toBe(0);
    expect(await c.smembers(`${prefix}scopes`)).toEqual(['kept']);

    await store.close();
  });

  it('recall for a deleted scope stays empty after re-hydration too', async () => {
    const prefix = px('delscope-rehydrate');
    const store = mk(prefix);
    await store.retain('gone', [W(LONG_A)]);
    await store.deleteScope('gone');
    await store.close();

    const fresh = mk(prefix);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(0);
    expect((await fresh.recall('gone', LONG_A)).records).toEqual([]);
    await fresh.close();
  });

  it('deleteScope drops om:docid pointers so deleted ids cannot be resurrected', async () => {
    const prefix = px('delscope-docid');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('s', [{ ...W(LONG_A), documentId: 'doc-1' }]);
    const [firstId] = await c.zrange(`${prefix}scope:s`, 0, -1);

    await store.deleteScope('s');

    // deleteScope owns the documentId → id pointer as much as it owns
    // om:rec:* and om:scope:{scope}; leaving it behind would make the next
    // retain() reuse a dead id instead of allocating from om:seq.
    expect(await c.get(`${prefix}docid:s:doc-1`)).toBeNull();

    await store.retain('s', [{ ...W(LONG_B), documentId: 'doc-1' }]);
    const [secondId] = await c.zrange(`${prefix}scope:s`, 0, -1);
    expect(secondId).not.toBe(firstId);
    // The new pointer addresses the new id, and the new record is intact.
    expect(await c.get(`${prefix}docid:s:doc-1`)).toBe(secondId);
    expect((await c.hgetall(`${prefix}rec:${secondId}`)).content).toBe(LONG_B);

    await store.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — documentId upsert', () => {
  it('drops the old postings so the previous content is no longer findable', async () => {
    const prefix = px('upsert');
    const store = mk(prefix);
    const c = await raw();

    await store.retain('s', [{ ...W(LONG_A), documentId: 'doc-1' }]);
    expect((await store.recall('s', LONG_A)).records.map((r) => r.content)).toContain(LONG_A);

    await store.retain('s', [{ ...W(LONG_B), documentId: 'doc-1' }]);

    // One record, one id — an upsert, not an append.
    expect(store.indexSize).toBe(1);
    expect(await c.zcard(`${prefix}scope:s`)).toBe(1);

    // The stale posting must be gone from the derived index.
    const stale = await store.recall('s', LONG_A);
    expect(stale.records.map((r) => r.content)).not.toContain(LONG_A);

    const fresh2 = await store.recall('s', LONG_B);
    expect(fresh2.records.map((r) => r.content)).toContain(LONG_B);

    await store.close();
  });

  it('an upsert survives re-hydration with the new content only', async () => {
    const prefix = px('upsert-rehydrate');
    const store = mk(prefix);
    await store.retain('s', [{ ...W(LONG_A), documentId: 'doc-1' }]);
    await store.retain('s', [{ ...W(LONG_B), documentId: 'doc-1' }]);
    await store.close();

    const fresh = mk(prefix);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(1);
    expect((await fresh.recall('s', LONG_A)).records.map((r) => r.content)).not.toContain(LONG_A);
    expect((await fresh.recall('s', LONG_B)).records.map((r) => r.content)).toContain(LONG_B);
    await fresh.close();
  });

  it('two writes sharing a documentId in ONE retain() collapse to one record, last write wins', async () => {
    const prefix = px('upsert-batch');
    const store = mk(prefix);
    const c = await raw();

    const out = await store.retain('s', [
      { ...W(LONG_A), documentId: 'doc-1' },
      { ...W(LONG_B), documentId: 'doc-1' },
    ]);

    // documentId is an idempotency key, so the batch collapses to one record.
    // The count reported is the number of records STORED, not writes offered.
    expect(out).toEqual({ ok: true, count: 1 });
    expect(await c.zcard(`${prefix}scope:s`)).toBe(1);
    expect(store.indexSize).toBe(1);

    // Last write wins, and the pointer addresses that one record.
    const [id] = await c.zrange(`${prefix}scope:s`, 0, -1);
    expect((await c.hgetall(`${prefix}rec:${id}`)).content).toBe(LONG_B);
    expect(await c.get(`${prefix}docid:s:doc-1`)).toBe(id);

    // Neither the hot index nor a rebooted one can still find the shadowed
    // first write.
    expect((await store.recall('s', LONG_A)).records.map((r) => r.content)).not.toContain(LONG_A);
    await store.close();

    const fresh = mk(prefix);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(1);
    await fresh.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────

d('RedisMemoryStore — isDuplicate scope/limit interaction', () => {
  it('an in-scope duplicate is found even when many higher-ranked hits are cross-scope', async () => {
    const prefix = px('dup-limit');
    const store = mk(prefix);

    // Eight identical records in another scope get the LOW ids, so the index's
    // (relevance desc, id asc) tiebreak puts them all ahead of ours. The
    // candidate generator must not truncate before the scope filter runs.
    await store.retain('other', Array.from({ length: 8 }, () => W(LONG_A)));
    await store.retain('mine', [W(LONG_A)]);

    expect(await store.isDuplicate('mine', LONG_A)).toBe(true);
    // The crowd is still not a duplicate for a scope that holds nothing.
    expect(await store.isDuplicate('empty', LONG_A)).toBe(false);

    await store.close();
  });

  it('a byte-identical SHORT record is a duplicate despite the index length penalty', async () => {
    const prefix = px('dup-short');
    const store = mk(prefix);

    // Under 20 normalised chars, so the index applies its x0.8 length penalty
    // and an exact match ceilings at relevance 0.80 — below the 0.85 default.
    // The verdict must come from trigramSimilarity, not from the ranking score.
    const SHORT = 'prefers dark mode';
    await store.retain('core', [W(SHORT, 'preference')]);

    expect(await store.isDuplicate('core', SHORT)).toBe(true);
    expect(await store.isDuplicate('core', 'prefers light mode')).toBe(false);

    await store.close();
  });

  it('a same-scope duplicate with no competition is detected', async () => {
    const prefix = px('dup-basic');
    const store = mk(prefix);
    await store.retain('mine', [W(LONG_A)]);
    expect(await store.isDuplicate('mine', LONG_A)).toBe(true);
    expect(await store.isDuplicate('mine', LONG_B)).toBe(false);
    expect(await store.isDuplicate('elsewhere', LONG_A)).toBe(false);
    await store.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Injected-client tests: pipeline failure must not pollute the derived index.
// These need no Redis at all, but are kept alongside for cohesion.
// ──────────────────────────────────────────────────────────────────────────

type ExecMode = 'ok' | 'reject' | 'command-errors' | 'null';

class FakeRedis {
  seq = 0;
  execCalls = 0;
  /**
   * Scope membership is a ZSET now, so the fake models one per key as
   * member → score. Ordering is by SCORE (then member), never insertion,
   * because that is the property the production migration exists to provide.
   */
  private readonly zsets = new Map<string, Map<string, number>>();
  constructor(private readonly mode: ExecMode) {}

  private zset(key: string): Map<string, number> {
    let z = this.zsets.get(key);
    if (!z) { z = new Map(); this.zsets.set(key, z); }
    return z;
  }

  /** Members of `key` in (score asc, member asc) order. */
  private zsorted(key: string): string[] {
    return [...this.zset(key).entries()]
      .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([m]) => m);
  }

  async hset(): Promise<number> { return 1; }
  async hgetall(): Promise<Record<string, string>> { return {}; }
  async get(): Promise<string | null> { return null; }
  async set(): Promise<unknown> { return 'OK'; }
  async del(...keys: string[]): Promise<number> { for (const k of keys) this.zsets.delete(k); return 0; }
  async incr(): Promise<number> { return ++this.seq; }
  async sadd(): Promise<number> { return 1; }
  async srem(): Promise<number> { return 1; }
  async smembers(): Promise<string[]> { return []; }
  async scard(): Promise<number> { return 0; }
  async zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.zset(key);
    const added = z.has(member) ? 0 : 1;
    z.set(member, score);
    return added;
  }
  async zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.zset(key);
    let n = 0;
    for (const m of members) if (z.delete(m)) n++;
    return n;
  }
  async zcard(key: string): Promise<number> { return this.zset(key).size; }
  /** Inclusive at both ends, like Redis ZRANGEBYSCORE. */
  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    const z = this.zset(key);
    return this.zsorted(key).filter((m) => {
      const s = z.get(m)!;
      return s >= lo && s <= hi;
    });
  }
  /** Supports negative indices, like Redis ZRANGE. */
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const all = this.zsorted(key);
    const n = all.length;
    let s = start < 0 ? n + start : start;
    let e = stop < 0 ? n + stop : stop;
    if (s < 0) s = 0;
    if (e >= n) e = n - 1;
    if (n === 0 || s > e) return [];
    return all.slice(s, e + 1);
  }
  async ping(): Promise<string> { return 'PONG'; }
  async quit(): Promise<unknown> { return 'OK'; }
  async config(): Promise<string[]> { return []; }
  on(): unknown { return this; }

  /**
   * retain() and deleteScope() use MULTI (atomic) rather than a plain
   * pipeline, so the store's DEL-then-HSET record replacement cannot be left
   * half-applied. The fake exercises the same failure modes either way.
   */
  multi() { return this.pipeline(); }

  pipeline() {
    let commands = 0;
    const chain = {
      hset: () => { commands++; return chain; },
      hgetall: () => { commands++; return chain; },
      set: () => { commands++; return chain; },
      del: () => { commands++; return chain; },
      sadd: () => { commands++; return chain; },
      srem: () => { commands++; return chain; },
      // The scope key is a ZSET now, so retain()/deleteScope()/GC queue
      // zadd/zrem here; unpin() queues hdel.
      zadd: () => { commands++; return chain; },
      zrem: () => { commands++; return chain; },
      hdel: () => { commands++; return chain; },
      exec: async (): Promise<Array<[Error | null, unknown]> | null> => {
        this.execCalls++;
        switch (this.mode) {
          case 'reject':
            throw new Error('ECONNRESET during EXEC');
          case 'null':
            return null;
          case 'command-errors':
            return Array.from(
              { length: commands },
              () => [new Error('READONLY You cant write against a read only replica.'), null] as [Error, null],
            );
          default:
            return Array.from({ length: commands }, () => [null, 'OK'] as [null, string]);
        }
      },
    };
    return chain;
  }
}

const fakeStore = (mode: ExecMode): { store: RedisMemoryStore; fake: FakeRedis } => {
  const fake = new FakeRedis(mode);
  const store = new RedisMemoryStore({
    client: fake as unknown as RedisLike,
    redis: { keyPrefix: `${BASE}fake:` },
  });
  return { store, fake };
};

describe('RedisMemoryStore — pipeline failure vs derived index', () => {
  it('a rejecting pipeline.exec() propagates and leaves the index clean', async () => {
    const { store, fake } = fakeStore('reject');
    await expect(store.retain('s', [W(LONG_A)])).rejects.toThrow(/ECONNRESET/);
    expect(fake.execCalls).toBe(1);
    expect(store.indexSize).toBe(0);
  });

  it('per-command pipeline errors are detected: nothing indexed, ok:false', async () => {
    const { store } = fakeStore('command-errors');
    const out = await store.retain('s', [W(LONG_A)]);

    // ioredis RESOLVES a pipeline whose commands all failed and reports the
    // failures inside the per-command result tuples. Nothing reached Redis, so
    // the derived index must gain nothing and the caller must not be told the
    // write succeeded.
    expect(store.indexSize).toBe(0);
    expect(out).toEqual({ ok: false, count: 0 });
  });

  it('a null pipeline.exec() result is treated as a total write failure', async () => {
    const { store } = fakeStore('null');
    // ioredis returns null from exec() when a transaction is discarded.
    const out = await store.retain('s', [W(LONG_A)]);
    expect(out).toEqual({ ok: false, count: 0 });
    expect(store.indexSize).toBe(0);
  });

  it('a successful pipeline does update the index', async () => {
    const { store } = fakeStore('ok');
    const out = await store.retain('s', [W(LONG_A)]);
    expect(out).toEqual({ ok: true, count: 1 });
    expect(store.indexSize).toBe(1);
  });
});
