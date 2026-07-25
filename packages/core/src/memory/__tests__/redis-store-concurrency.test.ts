/**
 * RedisMemoryStore — CONCURRENT WRITES AND ID ALLOCATION
 *
 * Risk surface: `retain()` allocates ids with `await client.incr()` inside a
 * loop and then issues a single pipeline. This file probes whether interleaved
 * concurrent retains can corrupt state, and whether the derived in-process
 * index can diverge from authoritative Redis.
 *
 * REDIS SAFETY
 * ------------
 *  - db 15 only, redis://localhost:6379 only.
 *  - Every store gets a fresh, unique prefix `omtest-conc-<pid>-<n>:`.
 *  - Cleanup SCANs `MATCH <our prefix>*` and deletes only those keys.
 *    No FLUSHDB, no `KEYS *`, no assumption that db 15 is empty.
 *
 * Most of this file is now a REGRESSION GUARD: the batch documentId collapse,
 * the docid-pointer cleanup in deleteScope and the tokensUsed billing were
 * defects found here and have since been fixed, so these tests assert the
 * corrected contract.
 *
 * The remaining `it.fails(...)` are REAL DEFECTS, not flaky tests: the body
 * asserts the CORRECT behaviour and is expected to throw today. Each carries a
 * STILL BROKEN comment naming what is unfixed. A third known limitation — two
 * store instances sharing a prefix not seeing each other's writes until
 * re-hydration — is architectural and is documented by a passing test rather
 * than an it.fails, since there is no corrected behaviour to assert yet.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import type { RedisLike, RedisPipeline } from '../redis-connection.js';

// Honour REDIS_URL so CI can point at its service container, and so the
// skip-guard can be exercised against an unreachable server.
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DB = 15;

let prefixCounter = 0;
const createdPrefixes: string[] = [];
function newPrefix(): string {
  const p = `omtest-conc-${process.pid}-${prefixCounter++}:`;
  createdPrefixes.push(p);
  return p;
}

const openStores: RedisMemoryStore[] = [];
function makeStore(prefix: string, client?: RedisLike): RedisMemoryStore {
  const store = new RedisMemoryStore({
    redis: { url: URL, db: DB, keyPrefix: prefix },
    ...(client ? { client } : {}),
  });
  openStores.push(store);
  return store;
}

/** ioredis is an optional dependency — load it the way production code does. */
async function loadRedisCtor(): Promise<new (url: string, opts?: Record<string, unknown>) => RawClient> {
  const moduleName = 'ioredis';
  const mod = (await import(moduleName)) as unknown as { default?: unknown };
  return (mod.default ?? mod) as new (url: string, opts?: Record<string, unknown>) => RawClient;
}

interface RawClient extends RedisLike {
  scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  exists(key: string): Promise<number>;
}

async function rawClient(): Promise<RawClient> {
  const Ctor = await loadRedisCtor();
  return new Ctor(URL, { db: DB, maxRetriesPerRequest: 3, enableReadyCheck: true });
}

// ── availability guard ─────────────────────────────────────────────────────
const REDIS_UP = await (async () => {
  try {
    const probe = new RedisMemoryStore({
      redis: { url: URL, db: DB, keyPrefix: `omtest-conc-probe-${process.pid}:` },
    });
    const h = await probe.health();
    await probe.close();
    return h.healthy;
  } catch {
    return false;
  }
})();

const d = REDIS_UP ? describe : describe.skip;

afterAll(async () => {
  for (const s of openStores) {
    try {
      await s.close();
    } catch {
      /* already gone */
    }
  }
  if (!REDIS_UP || createdPrefixes.length === 0) return;
  const raw = await rawClient();
  try {
    for (const prefix of createdPrefixes) {
      let cursor = '0';
      do {
        const [next, keys] = await raw.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', '500');
        cursor = next;
        if (keys.length > 0) await raw.del(...keys);
      } while (cursor !== '0');
    }
  } finally {
    await raw.quit();
  }
});

const CTX = 'decision'; // never expires — keeps TTL out of these assertions

function body(marker: string): string {
  return `parallel retention record ${marker} concurrency payload alpha bravo charlie`;
}

// ═══════════════════════════════════════════════════════════════════════════

d('retain() — concurrent id allocation, same scope', () => {
  it('20 parallel retains x 5 writes: no id reused, no record lost', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'same-scope';
    const CALLS = 20;
    const PER = 5;

    const results = await Promise.all(
      Array.from({ length: CALLS }, (_, c) =>
        store.retain(
          scope,
          Array.from({ length: PER }, (_, j) => ({
            content: body(`zqmarker${c}u${j}`),
            context: CTX,
          })),
        ),
      ),
    );
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.count).toBe(PER);
    }

    const total = CALLS * PER;

    // Authoritative Redis: the scope ZSET holds `total` DISTINCT ids. A reused
    // id would collapse two records into one member and this would be < total.
    const scopes = await store.listScopes();
    expect(scopes.find((s) => s.id === scope)?.recordCount).toBe(total);

    // Derived in-process index agrees with Redis.
    expect(store.indexSize).toBe(total);

    // And a cold process rebuilding purely from Redis sees the same set.
    const fresh = makeStore(prefix);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(total);

    // Every individual record is retrievable, from the cold store.
    for (let c = 0; c < CALLS; c++) {
      for (let j = 0; j < PER; j++) {
        const marker = `zqmarker${c}u${j}`;
        const out = await fresh.recall(scope, marker);
        expect(out.records.length, `missing ${marker}`).toBe(1);
        expect(out.records[0]!.content).toContain(marker);
      }
    }
  }, 30_000);

  it('every allocated id maps to a hash that actually exists in Redis', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'id-integrity';

    await Promise.all(
      Array.from({ length: 12 }, (_, c) =>
        store.retain(scope, [{ content: body(`zqintegrity${c}`), context: CTX }]),
      ),
    );

    const raw = await rawClient();
    try {
      // om:scope:{scope} is a ZSET scored by seq; read every member in score
      // order. A reused id would collapse two records into one member.
      const ids = await raw.zrange(`${prefix}scope:${scope}`, 0, -1);
      expect(ids.length).toBe(12);
      expect(new Set(ids).size).toBe(12);
      for (const id of ids) {
        expect(await raw.exists(`${prefix}rec:${id}`), `rec:${id} missing`).toBe(1);
      }
      // The global counter advanced exactly once per record.
      const seq = await raw.get(`${prefix}seq`);
      expect(Number(seq)).toBe(12);
    } finally {
      await raw.quit();
    }
  });
});

d('retain() — concurrent writes to different scopes', () => {
  it('8 scopes written in parallel stay isolated in Redis and after re-hydration', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const SCOPES = 8;
    const PER = 4;

    await Promise.all(
      Array.from({ length: SCOPES }, (_, s) =>
        store.retain(
          `scope-${s}`,
          Array.from({ length: PER }, (_, j) => ({
            content: body(`zqiso${s}v${j}`),
            context: CTX,
          })),
        ),
      ),
    );

    const listed = await store.listScopes();
    for (let s = 0; s < SCOPES; s++) {
      expect(listed.find((x) => x.id === `scope-${s}`)?.recordCount).toBe(PER);
    }

    const fresh = makeStore(prefix);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(SCOPES * PER);

    // A marker written to scope N is visible in scope N and in NO other scope,
    // even though a single global index serves them all.
    for (let s = 0; s < SCOPES; s++) {
      const marker = `zqiso${s}v0`;
      const hit = await fresh.recall(`scope-${s}`, marker);
      expect(hit.records.length).toBe(1);
      for (let other = 0; other < SCOPES; other++) {
        if (other === s) continue;
        const miss = await fresh.recall(`scope-${other}`, marker);
        expect(miss.records.length, `${marker} leaked into scope-${other}`).toBe(0);
      }
    }
  });
});

d('retain() interleaved with recall()', () => {
  it('recall never observes a half-written record while retains are in flight', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'interleave';
    await store.hydrate();

    let stop = false;
    let reads = 0;
    const seen: Array<{ content: string; context: string; timestamp: string; relevance: number }> = [];

    const reader = (async () => {
      while (!stop) {
        const out = await store.recall(scope, 'zqinterleave concurrency payload', { minRelevance: 0.05 });
        reads++;
        for (const r of out.records) seen.push(r);
        expect(out.tokensUsed).toBeGreaterThanOrEqual(0);
        // NOTE: while the index is empty, recall() resolves with NO Redis I/O
        // at all, so a tight await-loop would never leave the microtask queue
        // and would starve the retains' socket callbacks. Yield a macrotask in
        // exactly that case; once records exist, recall's own pipeline yields.
        if (out.records.length === 0) await new Promise((r) => setTimeout(r, 0));
      }
    })();

    // Ten sequential rounds, each a burst of parallel retains — a long enough
    // window that the reader is guaranteed to sample mid-write states.
    for (let round = 0; round < 10; round++) {
      await Promise.all(
        Array.from({ length: 5 }, (_, c) =>
          store.retain(scope, [
            { content: body(`zqinterleave${round}n${c}a`), context: CTX },
            { content: body(`zqinterleave${round}n${c}b`), context: CTX },
          ]),
        ),
      );
    }
    stop = true;
    await reader;
    expect(reads).toBeGreaterThan(1);

    // Every record recall handed back mid-flight was fully formed: content and
    // metadata both present. A record visible with content but no meta (or the
    // reverse) would show up here as an empty field.
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.content).toContain('parallel retention record');
      expect(r.context).toBe(CTX);
      expect(r.timestamp).not.toBe('');
      expect(Number.isFinite(Date.parse(r.timestamp))).toBe(true);
      expect(r.relevance).toBeGreaterThan(0);
    }

    // Final state is complete.
    const listed = await store.listScopes();
    expect(listed.find((s) => s.id === scope)?.recordCount).toBe(100);
  }, 30_000);

  it('hydrate() called concurrently 10x scans once and yields a consistent index', async () => {
    const prefix = newPrefix();
    const seed = makeStore(prefix);
    await seed.retain('hydra', [
      { content: body('zqhydraone'), context: CTX },
      { content: body('zqhydratwo'), context: CTX },
    ]);

    const cold = makeStore(prefix);
    await Promise.all(Array.from({ length: 10 }, () => cold.hydrate()));
    expect(cold.isHydrated).toBe(true);
    // Ten overlapping hydrations must not double-ingest.
    expect(cold.indexSize).toBe(2);
    expect((await cold.recall('hydra', 'zqhydraone')).records.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TWO STORE INSTANCES, ONE PREFIX  (simulates two worker processes)
// ═══════════════════════════════════════════════════════════════════════════

d('two RedisMemoryStore instances sharing a prefix', () => {
  it('syncFromRedis lets one instance see another instance writes', async () => {
    // Redis is shared; the derived index is not. Without an explicit sync, a
    // second instance's writes stayed invisible until full re-hydration —
    // the divergence that made "workers can share a store" false.
    const prefix = newPrefix();
    const a = makeStore(prefix);
    const b = makeStore(prefix);
    const scope = 'shared-sync';

    await a.retain(scope, [{ content: body('zqsyncfirst'), context: CTX }]);
    await b.recall(scope, body('zqsyncfirst'));   // b hydrates, sees one record

    await a.retain(scope, [{ content: body('zqsyncsecond'), context: CTX }]);

    // Assert on CONTENT, not result count: body() wraps every marker in the
    // same boilerplate, so both records match either query on relevance alone.
    const sees = async (marker: string): Promise<boolean> => {
      const out = await b.recall(scope, body(marker), { minRelevance: 0.1 });
      return out.records.some((r) => r.content.includes(marker));
    };

    // Before syncing, b has no idea the second record exists.
    expect(await sees('zqsyncsecond')).toBe(false);

    const ingested = await b.syncFromRedis();
    expect(ingested).toBe(1);
    expect(await sees('zqsyncsecond')).toBe(true);

    await a.deleteScope(scope);
  });

  it('syncFromRedis is a no-op on an idle keyspace', async () => {
    // Ids come from ONE global counter, so a single GET reveals whether
    // anything new exists — an idle keyspace must not re-scan.
    const prefix = newPrefix();
    const a = makeStore(prefix);
    const scope = 'idle-sync';

    await a.retain(scope, [{ content: body('zqidle'), context: CTX }]);
    await a.syncFromRedis();
    expect(await a.syncFromRedis()).toBe(0);
    expect(await a.syncFromRedis()).toBe(0);

    await a.deleteScope(scope);
  });

  it('recall evicts a record another instance deleted, rather than serving a phantom', async () => {
    // The other direction of divergence: sync teaches an instance about new
    // records, but nothing taught it to FORGET ones deleted elsewhere. Recall
    // already discovered the miss at fetch time; now the discovery repairs the
    // index instead of leaving indexSize lying until re-hydration.
    const prefix = newPrefix();
    const a = makeStore(prefix);
    const raw = await rawClient();
    const scope = 'evict-stale';

    await a.retain(scope, [
      { content: body('zqevictgone'), context: CTX },
      { content: body('zqevictkept'), context: CTX },
    ]);
    const sizeBefore = a.indexSize;
    expect(sizeBefore).toBe(2);

    // Delete one record's hash behind the store's back, as another process would.
    const ids = await raw.zrange(`${prefix}scope:${scope}`, 0, -1);
    await raw.del(`${prefix}rec:${ids[0]}`);

    const out = await a.recall(scope, body('zqevictgone'), { minRelevance: 0.1 });
    expect(out.records.some((r) => r.content.includes('zqevictgone'))).toBe(false);
    // The index no longer counts the record Redis lost — that is the repair.
    expect(a.indexSize).toBe(1);

    // The surviving record is untouched.
    const kept = await a.recall(scope, body('zqevictkept'), { minRelevance: 0.1 });
    expect(kept.records.some((r) => r.content.includes('zqevictkept'))).toBe(true);

    await a.deleteScope(scope);
    await raw.quit();
  });

  it('CONFIRMS: the global om:seq counter prevents cross-instance id collision', async () => {
    const prefix = newPrefix();
    const a = makeStore(prefix);
    const b = makeStore(prefix);
    await Promise.all([a.hydrate(), b.hydrate()]);

    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        a.retain('shared', [{ content: body(`zqinsta${i}`), context: CTX }]),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        b.retain('shared', [{ content: body(`zqinstb${i}`), context: CTX }]),
      ),
    ]);

    // If the two processes had collided on an id, the scope ZSET would hold
    // fewer than 20 members and one record's content would have been clobbered.
    const listed = await a.listScopes();
    expect(listed.find((s) => s.id === 'shared')?.recordCount).toBe(20);

    const cold = makeStore(prefix);
    await cold.hydrate();
    expect(cold.indexSize).toBe(20);
    for (let i = 0; i < 10; i++) {
      expect((await cold.recall('shared', `zqinsta${i}`)).records.length).toBe(1);
      expect((await cold.recall('shared', `zqinstb${i}`)).records.length).toBe(1);
    }
  });

  it('DOCUMENTS THE LIMITATION: instance A never sees B writes until A re-hydrates', async () => {
    const prefix = newPrefix();
    const a = makeStore(prefix);
    const b = makeStore(prefix);
    await Promise.all([a.hydrate(), b.hydrate()]);

    await b.retain('shared2', [{ content: body('zqonlyseenbyb'), context: CTX }]);

    // Redis (authoritative) has it...
    const listed = await a.listScopes();
    expect(listed.find((s) => s.id === 'shared2')?.recordCount).toBe(1);
    // ...and B recalls it.
    expect((await b.recall('shared2', 'zqonlyseenbyb')).records.length).toBe(1);

    // But A's DERIVED index was never told, and `hydrate()` short-circuits on
    // `this.hydrated`, so there is no path back to consistency for a long-lived
    // process. This assertion encodes CURRENT behaviour, and is the reason
    // §13's "workers can share a store" claim does not hold as written.
    expect(a.indexSize).toBe(0);
    const stale = await a.recall('shared2', 'zqonlyseenbyb');
    expect(stale.records.length).toBe(0);
    expect(stale.lowConfidence).toBe(true);

    // Same blind spot in the dedup path: A will happily re-write B's record.
    expect(await a.isDuplicate('shared2', body('zqonlyseenbyb'))).toBe(false);
    expect(await b.isDuplicate('shared2', body('zqonlyseenbyb'))).toBe(true);

    // A fresh instance (i.e. a restart) is correct — hydration is the only cure.
    const c = makeStore(prefix);
    await c.hydrate();
    expect((await c.recall('shared2', 'zqonlyseenbyb')).records.length).toBe(1);
  });

  // recall() sizes the token budget from in-process metadata BEFORE fetching
  // from Redis, but bills only for content it actually hands back. A record
  // whose hash vanished mid-flight (another process deleted it, eviction, a
  // partially-applied write) must not be charged, or a caller sizing a
  // downstream prompt from `tokensUsed` under-fills against a budget it never
  // actually spent.
  it('bills tokensUsed only for records actually delivered', async () => {
    const prefix = newPrefix();
    const a = makeStore(prefix);
    const b = makeStore(prefix);
    await a.hydrate();

    await a.retain('ghost', [{ content: body('zqghostrecord'), context: CTX }]);
    const live = await a.recall('ghost', 'zqghostrecord');
    expect(live.records.length).toBe(1);
    expect(live.tokensUsed).toBeGreaterThan(0);
    expect(live.tokensUsed).toBe(live.records[0]!.estimatedTokens);

    // Another process removes the scope. A's index still points at the id.
    await b.hydrate();
    await b.deleteScope('ghost');

    const out = await a.recall('ghost', 'zqghostrecord');
    expect(out.records.length).toBe(0); // the content is gone
    expect(out.tokensUsed).toBe(0); // and nothing is billed for it
    expect(out.lowConfidence).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// documentId UPSERT — read-then-write with no atomicity
// ═══════════════════════════════════════════════════════════════════════════

d('documentId upsert', () => {
  it('CONTROL: sequential upserts of one documentId keep exactly one record', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'upsert-seq';

    await store.retain(scope, [{ content: body('zqupsertv1'), context: CTX, documentId: 'doc-1' }]);
    await store.retain(scope, [{ content: body('zqupsertv2'), context: CTX, documentId: 'doc-1' }]);
    await store.retain(scope, [{ content: body('zqupsertv3'), context: CTX, documentId: 'doc-1' }]);

    const listed = await store.listScopes();
    expect(listed.find((s) => s.id === scope)?.recordCount).toBe(1);

    const cold = makeStore(prefix);
    await cold.hydrate();
    expect(cold.indexSize).toBe(1);
    expect((await cold.recall(scope, 'zqupsertv3')).records.length).toBe(1);
    expect((await cold.recall(scope, 'zqupsertv1')).records.length).toBe(0);
  });

  // retain() collapses duplicate documentIds WITHIN one batch before writing,
  // so the batch behaves like the sequential upsert above: one record, last
  // write wins. Without the collapse both writes miss the `existing` snapshot,
  // each mint an id, and the first is orphaned — reachable by neither
  // documentId nor a later upsert.
  it('duplicate documentId inside one retain() batch collapses to one record', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'upsert-batch';

    const res = await store.retain(scope, [
      { content: body('zqbatchv1'), context: CTX, documentId: 'doc-b' },
      { content: body('zqbatchv2'), context: CTX, documentId: 'doc-b' },
    ]);
    // The collapsed batch reports the number of records it actually stored.
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);

    const listed = await store.listScopes();
    // Upsert semantics: "re-writing the same id updates in place" (store.ts:45).
    expect(listed.find((s) => s.id === scope)?.recordCount).toBe(1);
    expect(store.indexSize).toBe(1);

    // Last write wins, and the superseded revision is gone from Redis too.
    const cold = makeStore(prefix);
    await cold.hydrate();
    expect(cold.indexSize).toBe(1);
    expect((await cold.recall(scope, 'zqbatchv2')).records.length).toBe(1);
    expect((await cold.recall(scope, 'zqbatchv1')).records.length).toBe(0);
  });

  // ── STILL BROKEN ─────────────────────────────────────────────────────────
  // The intra-batch case above is fixed, but the read-then-write gap ACROSS
  // concurrent calls is not: retain() reads om:docid:{scope}:{documentId} with
  // a plain GET and writes it in a later pipeline, with no atomicity between
  // the two. Five parallel retains all observe the key missing, and each mints
  // its own id. Fixing this needs a Lua script (or WATCH/MULTI) that resolves
  // the pointer and allocates in one round trip.
  it('concurrent retains of one documentId converge on a single record', async () => {
    // Previously each parallel caller observed a missing om:docid pointer and
    // minted its own id, producing N records with all but one orphaned. The
    // pointer is now established with SET NX, so exactly one caller allocates
    // and the losers read back the winner's id — last-write-wins upsert.
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'upsert-par';

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.retain(scope, [{ content: body(`zqparv${i}`), context: CTX, documentId: 'doc-p' }]),
      ),
    );

    const listed = await store.listScopes();
    expect(listed.find((s) => s.id === scope)?.recordCount).toBe(1);

    // And the surviving record must be one of the revisions actually written —
    // not a blank left behind by a half-applied replace.
    const out = await store.recall(scope, body('zqparv'), { minRelevance: 0.1 });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.content).toMatch(/zqparv[0-4]/);
  });

  it('leaves no orphan behind: a later upsert still reclaims the batch-collapsed record', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'upsert-orphan';

    await store.retain(scope, [
      { content: body('zqorphanv1'), context: CTX, documentId: 'doc-o' },
      { content: body('zqorphanv2'), context: CTX, documentId: 'doc-o' },
    ]);
    let listed = await store.listScopes();
    expect(listed.find((s) => s.id === scope)?.recordCount).toBe(1);

    // The docid pointer addresses the one surviving id, so the next upsert
    // updates in place rather than leaving an unreachable revision behind
    // answering recalls with stale content.
    await store.retain(scope, [{ content: body('zqorphanv3'), context: CTX, documentId: 'doc-o' }]);
    listed = await store.listScopes();
    expect(listed.find((s) => s.id === scope)?.recordCount).toBe(1);

    const cold = makeStore(prefix);
    await cold.hydrate();
    expect(cold.indexSize).toBe(1);
    expect((await cold.recall(scope, 'zqorphanv1')).records.length).toBe(0); // never landed
    expect((await cold.recall(scope, 'zqorphanv2')).records.length).toBe(0); // replaced
    expect((await cold.recall(scope, 'zqorphanv3')).records.length).toBe(1); // current
  });

  it('deleteScope also removes the om:docid:* pointers, so no deleted id is resurrected', async () => {
    const prefix = newPrefix();
    const store = makeStore(prefix);
    const scope = 'docid-leak';

    await store.retain(scope, [{ content: body('zqleak'), context: CTX, documentId: 'doc-l' }]);

    const raw = await rawClient();
    try {
      const idBefore = await raw.get(`${prefix}docid:${scope}:doc-l`);
      expect(idBefore).not.toBeNull();

      await store.deleteScope(scope);

      // deleteScope reads om:scopedocs:{scope} to recover the documentIds and
      // deletes those pointers alongside om:rec:*, the scope ZSET and the
      // scopes membership. A dangling pointer would make the NEXT write for
      // that documentId write into the DELETED id instead of allocating one.
      expect(await raw.exists(`${prefix}docid:${scope}:doc-l`)).toBe(0);

      // Prove the consequence, not just the key: re-retaining the same
      // documentId mints a fresh id rather than reviving the tombstoned one.
      await store.retain(scope, [{ content: body('zqleakagain'), context: CTX, documentId: 'doc-l' }]);
      const idAfter = await raw.get(`${prefix}docid:${scope}:doc-l`);
      expect(idAfter).not.toBeNull();
      expect(idAfter).not.toBe(idBefore);

      const members = await raw.zrange(`${prefix}scope:${scope}`, 0, -1);
      expect(members).toEqual([idAfter]);
    } finally {
      await raw.quit();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LOST UPDATE: deleteScope racing a retain
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Delegating client that lets a test run code between two Redis calls.
 *
 * The hook fires on the scope-membership READ (a ZRANGE — om:scope:{scope} is
 * a ZSET scored by seq), landing between deleteScope reading the ids it will
 * prune from the in-process index and the deletion itself.
 *
 * That window used to be the bug: the delete was a second round trip, so a
 * record retained here was dropped from the scope set while its hash survived.
 * The deletion is now one Lua script that re-enumerates atomically, so the
 * window is inert — this class exists to prove that, not to exploit it.
 */
class HookedClient implements RedisLike {
  onScopeRead: ((key: string) => Promise<void>) | null = null;
  constructor(private readonly real: RedisLike) {}
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const res = await this.real.zrange(key, start, stop);
    if (this.onScopeRead) {
      const hook = this.onScopeRead;
      this.onScopeRead = null; // fire once
      await hook(key);
    }
    return res;
  }
  hset(key: string, values: Record<string, string>) { return this.real.hset(key, values); }
  hgetall(key: string) { return this.real.hgetall(key); }
  get(key: string) { return this.real.get(key); }
  set(key: string, value: string, mode?: 'NX') {
    // Forward the NX flag — dropping it would turn allocateId's atomic
    // check-and-set back into an unconditional SET.
    return mode ? this.real.set(key, value, mode) : this.real.set(key, value);
  }
  scan(cursor: string, m: 'MATCH', pattern: string, c: 'COUNT', count: number) {
    return this.real.scan(cursor, m, pattern, c, count);
  }
  del(...keys: string[]) { return this.real.del(...keys); }
  zscore(key: string, member: string) { return this.real.zscore(key, member); }
  // deleteScope now performs the deletion itself in a single Lua script, so
  // the hook window this class opens can no longer orphan anything — which is
  // exactly what the test asserts.
  eval(script: string, numKeys: number, ...args: Array<string | number>) {
    return this.real.eval(script, numKeys, ...args);
  }
  incr(key: string) { return this.real.incr(key); }
  sadd(key: string, ...m: string[]) { return this.real.sadd(key, ...m); }
  srem(key: string, ...m: string[]) { return this.real.srem(key, ...m); }
  smembers(key: string) { return this.real.smembers(key); }
  scard(key: string) { return this.real.scard(key); }
  zadd(key: string, score: number, member: string) { return this.real.zadd(key, score, member); }
  zrem(key: string, ...m: string[]) { return this.real.zrem(key, ...m); }
  zcard(key: string) { return this.real.zcard(key); }
  zrangebyscore(key: string, min: number | string, max: number | string) {
    return this.real.zrangebyscore(key, min, max);
  }
  ping() { return this.real.ping(); }
  quit() { return this.real.quit(); }
  pipeline(): RedisPipeline { return this.real.pipeline(); }
  multi(): RedisPipeline { return this.real.multi(); }
  config(op: 'GET', param: string) { return this.real.config(op, param); }
  on(event: string, handler: (...args: unknown[]) => void) { return this.real.on(event, handler); }
}

d('deleteScope racing retain', () => {
  // ── FIXED: deleteScope is now atomic ────────────────────────────────────
  // It previously ZRANGEd the scope ZSET and then DELed it in a second round
  // trip; anything retained in that window was dropped from the set without
  // its om:rec: hash being deleted — a lost update that left a record the
  // writing process still recalled for a scope Redis said was gone.
  //
  // Deletion now runs as a single Lua script, which Redis executes with no
  // interleaving, so the window does not exist. Either outcome below is
  // correct and both are consistent; what must NOT happen is a hash surviving
  // with no scope entry.
  it('a retain interleaved with deleteScope leaves no orphan', async () => {
    const prefix = newPrefix();
    const raw = await rawClient();
    const hooked = new HookedClient(raw);
    const store = makeStore(prefix, hooked);
    const scope = 'race-delete';

    await store.retain(scope, [{ content: body('zqracepre'), context: CTX }]);

    // Run a full retain between deleteScope's membership read and its delete.
    hooked.onScopeRead = async () => {
      await store.retain(scope, [{ content: body('zqraceduring'), context: CTX }]);
    };
    await store.deleteScope(scope);
    hooked.onScopeRead = undefined;

    try {
      const listed = await store.listScopes();
      const count = listed.find((s) => s.id === scope)?.recordCount ?? 0;
      const stillRecalled = (await store.recall(scope, 'zqraceduring')).records.length;

      // Consistent either way: the record landed after the delete and the
      // scope lists it, or it was collected with everything else.
      expect(count > 0 || stillRecalled === 0).toBe(true);

      // The load-bearing assertion: no om:rec hash may outlive its scope entry.
      let cursor = '0';
      const orphans: string[] = [];
      do {
        const [next, keys] = await raw.scan(cursor, 'MATCH', `${prefix}rec:*`, 'COUNT', '500');
        cursor = next;
        for (const k of keys) {
          const id = k.slice(`${prefix}rec:`.length);
          const score = await raw.zscore(`${prefix}scope:${scope}`, id);
          if (score === null || score === undefined) orphans.push(k);
        }
      } while (cursor !== '0');
      expect(orphans, `orphaned hashes: ${orphans.join(', ')}`).toHaveLength(0);

      await store.deleteScope(scope);
    } finally {
      await raw.quit();
    }
  });
});
