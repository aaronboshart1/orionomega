/**
 * RedisMemoryStore — PERSISTENCE AND HYDRATION FIDELITY
 *
 * The in-process MemoryIndex is DERIVED state. Redis is authoritative. If
 * `hydrate()` is lossy, wrong, or non-deterministic, memories silently vanish
 * on the next boot — the precise failure the v2 design exists to prevent.
 *
 * This file probes the boot path rather than the happy path:
 *
 *   A. Field-level round trip: what retain() writes vs. what Redis holds vs.
 *      what a fresh store restores.
 *   B. Bit-exact recall equivalence between a hot store and a cold one.
 *   C. Hydration across the BATCH=500 boundary (1 200 records).
 *   D. Corrupt keyspace: scope member with no `om:rec:{id}` hash.
 *   E. Records with empty / absent `content`.
 *   F. Scope isolation survives hydration.
 *   G. hydrate() runs exactly once under concurrency; connection accounting.
 *
 * REDIS SAFETY: db 15 only, one unique key prefix per suite, cleanup by
 * explicit key name. Nothing is flushed and no key this file did not create is
 * ever read or written.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import type { MemoryWrite, RecallOutcome } from '../store.js';
import { computeClientRelevance } from '@orionomega/shared/similarity';

const REDIS_URL = 'redis://localhost:6379';
const DB = 15;

// ── connection instrumentation ───────────────────────────────────────────────
// Wraps the real factory so we can (a) count how many connections the store
// opens and (b) guarantee every socket we caused is closed, including ones the
// store itself loses track of. Delegates entirely — no behaviour is stubbed.
let connCount = 0;
const createdClients: Array<{ quit(): Promise<unknown> }> = [];

vi.mock('../redis-connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../redis-connection.js')>();
  return {
    ...actual,
    createRedisConnection: async (cfg?: unknown) => {
      connCount++;
      const client = await actual.createRedisConnection(
        cfg as Parameters<typeof actual.createRedisConnection>[0],
      );
      createdClients.push(client as unknown as { quit(): Promise<unknown> });
      return client;
    },
  };
});

// ── unique keyspace ──────────────────────────────────────────────────────────
const RUN = `${process.pid}`;
let prefixCounter = 0;
const nextPrefix = (): string => `omtest-durability-${RUN}-${prefixCounter++}:`;

// ── raw client, for deliberate keyspace corruption ───────────────────────────
type RawRedis = {
  hset(key: string, values: Record<string, string>): Promise<number>;
  /** Still a SET: om:scopes and om:scopedocs:{scope}. NOT om:scope:{scope}. */
  smembers(key: string): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  get(key: string): Promise<string | null>;
  /** Still a SET: om:scopes and om:scopedocs:{scope}. NOT om:scope:{scope}. */
  sadd(key: string, ...m: string[]): Promise<number>;
  /**
   * om:scope:{scope} is a ZSET scored by the record's seq, so membership is read
   * with ZRANGE (which yields SCORE order, i.e. seq order) and written with
   * ZADD. Using the SET commands here is what threw WRONGTYPE and leaked keys.
   */
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
};

let raw: RawRedis | null = null;

const REDIS_UP: boolean = await (async () => {
  try {
    const mod = (await import('ioredis')) as unknown as { default?: new (u: string, o?: object) => RawRedis };
    const Ctor = (mod.default ?? mod) as new (u: string, o?: object) => RawRedis;
    const client = new Ctor(REDIS_URL, { db: DB, maxRetriesPerRequest: 1, lazyConnect: false });
    client.ping().catch(() => {});
    const pong = await client.ping();
    if (pong !== 'PONG') {
      await client.quit().catch(() => {});
      return false;
    }
    raw = client;

    const probe = new RedisMemoryStore({
      redis: { url: REDIS_URL, db: DB, keyPrefix: `omtest-durability-${RUN}-probe:` },
    });
    const h = await probe.health();
    await probe.close();
    return h.healthy;
  } catch {
    return false;
  }
})();

const d = REDIS_UP ? describe : describe.skip;

// ── helpers ──────────────────────────────────────────────────────────────────

function makeStore(prefix: string): RedisMemoryStore {
  return new RedisMemoryStore({ redis: { url: REDIS_URL, db: DB, keyPrefix: prefix } });
}

/**
 * Delete ONLY keys this file created, by explicit name. Never a wildcard.
 *
 * NOTHING in here may throw before the DELs run. A previous revision read the
 * scope key with SMEMBERS after it became a ZSET; the WRONGTYPE reply aborted
 * cleanup and leaked every key the suite had written, on every run. The
 * membership reads are therefore individually fault-isolated: a read that fails
 * costs us the `om:rec:{id}` names it would have enumerated, but the scope key
 * itself, `om:scopes`, `om:seq` and the explicit extras are still removed.
 */
async function cleanup(prefix: string, scopes: string[], extraKeys: string[] = []): Promise<void> {
  if (!raw) return;
  const doomed: string[] = [];
  for (const scope of scopes) {
    // om:scope:{scope} is a ZSET now — ZRANGE 0 -1 is the SMEMBERS equivalent.
    try {
      const ids = await raw.zrange(`${prefix}scope:${scope}`, 0, -1);
      for (const id of ids) doomed.push(`${prefix}rec:${id}`);
    } catch {
      /* read failed — still delete the keys named below */
    }
    doomed.push(`${prefix}scope:${scope}`);
    // The per-scope documentId set and the pointers it names. Added when
    // deleteScope stopped recovering documentIds by reading record bodies;
    // without these the suite leaves scopedocs keys behind on every run.
    // Still a SET — deliberately NOT migrated.
    try {
      const docIds = await raw.smembers(`${prefix}scopedocs:${scope}`);
      for (const d of docIds) doomed.push(`${prefix}docid:${scope}:${d}`);
    } catch {
      /* as above */
    }
    doomed.push(`${prefix}scopedocs:${scope}`);
    // om:pin:{scope} is new in the ZSET migration. Nothing here writes pins,
    // but naming it costs one DEL and keeps cleanup exhaustive if that changes.
    doomed.push(`${prefix}pin:${scope}`);
    // Memory Map segment metadata, written automatically by every retain().
    // The ordinal counter names how many segment hashes exist; without these
    // the suite leaks two keys per scope on every run.
    try {
      const segN = Number(await raw.get(`${prefix}segn:${scope}`)) || 0;
      for (let i = 1; i <= segN; i++) doomed.push(`${prefix}seg:${scope}:${i}`);
    } catch {
      /* as above */
    }
    doomed.push(`${prefix}segn:${scope}`);
  }
  doomed.push(`${prefix}scopes`, `${prefix}seq`, ...extraKeys);
  for (let i = 0; i < doomed.length; i += 400) {
    const chunk = doomed.slice(i, i + 400);
    if (chunk.length > 0) await raw.del(...chunk);
  }
}

/** Strip the fields that make two RecallOutcomes comparable as plain data. */
function shape(out: RecallOutcome) {
  return {
    lowConfidence: out.lowConfidence,
    tokensUsed: out.tokensUsed,
    records: out.records.map((r) => ({
      content: r.content,
      context: r.context,
      timestamp: r.timestamp,
      relevance: r.relevance,
      estimatedTokens: r.estimatedTokens,
    })),
  };
}

/** Deterministic, lexically varied corpus with unique rare markers. */
const TOPICS = [
  'caching strategy and invalidation policy for the gateway layer',
  'retry backoff schedule for flaky downstream dependencies',
  'schema migration ordering constraints across shards',
  'observability pipeline sampling rate and cardinality budget',
  'authentication token rotation window and revocation list',
  'queue partition rebalancing under sustained producer pressure',
  'index compaction thresholds and write amplification tradeoffs',
];

function corpusWrite(i: number, context = 'lesson'): MemoryWrite {
  return {
    content: `Record marker zqxa${String(i).padStart(4, '0')} covering ${TOPICS[i % TOPICS.length]} number ${i}`,
    context,
    timestamp: new Date(Date.UTC(2025, 0, 1 + (i % 27), 12, 0, 0)).toISOString(),
  };
}

afterAll(async () => {
  for (const c of createdClients) {
    try {
      await c.quit();
    } catch {
      /* already closed */
    }
  }
  if (raw) {
    try {
      await raw.quit();
    } catch {
      /* already closed */
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// A. FIELD-LEVEL ROUND TRIP
// ─────────────────────────────────────────────────────────────────────────────

d('A. retain() → Redis → hydrate() field fidelity', () => {
  const prefix = nextPrefix();
  const scope = 'fidelity';
  const docId = 'doc-alpha';

  const write: MemoryWrite = {
    content:
      'The deployment pipeline uses blue-green rollout with automatic rollback when the health probe fails twice',
    context: 'architecture', // pinned category — never expires, so TTL cannot flake this
    timestamp: '2025-01-02T03:04:05.000Z',
    documentId: docId,
    tags: ['infra', 'deploy'],
    importance: 0.77,
    metadata: { workflowId: 'wf-1', workerCount: '3' },
  };

  let hot: RedisMemoryStore;

  beforeAll(async () => {
    hot = makeStore(prefix);
    const out = await hot.retain(scope, [write]);
    expect(out).toEqual({ ok: true, count: 1 });
  });

  afterAll(async () => {
    await hot?.close();
    await cleanup(prefix, [scope], [`${prefix}docid:${scope}:${docId}`]);
  });

  it('writes scope/content/context/timestamp/tokens/documentId/tags/importance to the hash', async () => {
    const ids = await raw!.zrange(`${prefix}scope:${scope}`, 0, -1);
    expect(ids).toHaveLength(1);
    const rec = await raw!.hgetall(`${prefix}rec:${ids[0]}`);

    expect(rec.scope).toBe(scope);
    expect(rec.content).toBe(write.content);
    expect(rec.context).toBe('architecture');
    expect(rec.timestamp).toBe('2025-01-02T03:04:05.000Z');
    expect(rec.documentId).toBe(docId);
    expect(JSON.parse(rec.tags)).toEqual(['infra', 'deploy']);
    expect(rec.importance).toBe('0.77');
    expect(Number(rec.tokens)).toBeGreaterThan(0);
  });

  it('the documentId → id pointer is written under the scope-qualified key', async () => {
    const ids = await raw!.zrange(`${prefix}scope:${scope}`, 0, -1);
    const pointer = await raw!.get(`${prefix}docid:${scope}:${docId}`);
    expect(pointer).toBe(ids[0]);
  });

  it('a fresh store restores content, context, timestamp, tokens and relevance identically', async () => {
    const hotOut = await hot.recall(scope, 'blue-green rollout automatic rollback');
    expect(hotOut.records).toHaveLength(1);

    const cold = makeStore(prefix);
    try {
      await cold.hydrate();
      expect(cold.indexSize).toBe(1);
      const coldOut = await cold.recall(scope, 'blue-green rollout automatic rollback');
      expect(shape(coldOut)).toEqual(shape(hotOut));
      expect(coldOut.records[0]!.content).toBe(write.content);
      expect(coldOut.records[0]!.context).toBe('architecture');
      expect(coldOut.records[0]!.timestamp).toBe('2025-01-02T03:04:05.000Z');
    } finally {
      await cold.close();
    }
  });

  it('clamps importance into [0,1] before persisting', async () => {
    const p2 = nextPrefix();
    const s = makeStore(p2);
    try {
      await s.retain('clampy', [
        { content: 'importance above the ceiling should be clamped down to one', context: 'lesson', importance: 1.5 },
        { content: 'importance below the floor should be clamped up to zero exactly', context: 'lesson', importance: -0.5 },
      ]);
      const ids = (await raw!.zrange(`${p2}scope:clampy`, 0, -1)).sort((a, b) => Number(a) - Number(b));
      const a = await raw!.hgetall(`${p2}rec:${ids[0]}`);
      const b = await raw!.hgetall(`${p2}rec:${ids[1]}`);
      expect(a.importance).toBe('1');
      expect(b.importance).toBe('0');
    } finally {
      await s.close();
      await cleanup(p2, ['clampy']);
    }
  });

  /**
   * REGRESSION GUARD: `MemoryWrite.metadata` is part of the public store
   * interface, so retain() must persist it. It is stored as a JSON string in
   * the `metadata` hash field, which means it round-trips through Redis and is
   * therefore recoverable after a reboot.
   */
  it('persists MemoryWrite.metadata as a JSON hash field that round-trips', async () => {
    const ids = await raw!.zrange(`${prefix}scope:${scope}`, 0, -1);
    const rec = await raw!.hgetall(`${prefix}rec:${ids[0]}`);

    expect(rec.metadata).toBeDefined();
    expect(JSON.parse(rec.metadata)).toEqual({ workflowId: 'wf-1', workerCount: '3' });

    // Reading the hash back is the whole point: whatever a future hydrate()
    // wants from metadata is present in Redis, not only in the writer's heap.
    const reread = await raw!.hgetall(`${prefix}rec:${ids[0]}`);
    expect(reread.metadata).toBe(rec.metadata);
  });

  it('omits the metadata field entirely when the write carries none', async () => {
    const p = nextPrefix();
    const s = makeStore(p);
    try {
      await s.retain('nometa', [
        { content: 'a record written with no metadata attached to it whatsoever', context: 'lesson' },
      ]);
      const ids = await raw!.zrange(`${p}scope:nometa`, 0, -1);
      const rec = await raw!.hgetall(`${p}rec:${ids[0]}`);
      expect(rec.metadata).toBeUndefined();
    } finally {
      await s.close();
      await cleanup(p, ['nometa']);
    }
  });

  /**
   * REGRESSION GUARD: HSET MERGES, so the upsert path must DEL the old hash
   * first. Otherwise optional fields from an earlier revision (`tags`,
   * `importance`, `metadata`) survive a revision that omits them and the
   * stored record becomes a union of every version ever written — a record no
   * single retain() call ever described, which is then what a fresh store
   * hydrates.
   */
  it('a documentId upsert replaces the record — optional fields from the old revision do not survive', async () => {
    const p3 = nextPrefix();
    const s = makeStore(p3);
    try {
      await s.retain('upsert', [
        { content: 'first version of the upserted document with tags attached', context: 'lesson', documentId: 'u1', tags: ['v1'], importance: 0.9, metadata: { rev: '1' } },
      ]);
      await s.retain('upsert', [
        { content: 'second version of the upserted document with no tags at all', context: 'lesson', documentId: 'u1' },
      ]);
      const ids = await raw!.zrange(`${p3}scope:upsert`, 0, -1);
      expect(ids).toHaveLength(1);
      const rec = await raw!.hgetall(`${p3}rec:${ids[0]}`);
      expect(rec.content).toContain('second version');
      // The second write described no tags/importance/metadata, so the stored
      // record must describe none either.
      expect(rec.tags).toBeUndefined();
      expect(rec.importance).toBeUndefined();
      expect(rec.metadata).toBeUndefined();
      // The fields the second revision DID describe are intact — the del is a
      // replace, not a truncate.
      expect(rec.scope).toBe('upsert');
      expect(rec.context).toBe('lesson');
      expect(rec.documentId).toBe('u1');
      expect(Number(rec.tokens)).toBeGreaterThan(0);
      expect(rec.timestamp).toBeTruthy();

      // And a cold store rebuilds exactly that record, not the union.
      const cold = makeStore(p3);
      try {
        await cold.hydrate();
        expect(cold.indexSize).toBe(1);
        const out = await cold.recall('upsert', 'second version upserted document', { maxTokens: 100_000, minRelevance: 0.05 });
        expect(out.records.map((r) => r.content)).toEqual([
          'second version of the upserted document with no tags at all',
        ]);
      } finally {
        await cold.close();
      }
    } finally {
      await s.close();
      await cleanup(p3, ['upsert'], [`${p3}docid:upsert:u1`]);
    }
  });

  /**
   * The batch-local sibling of the upsert path: two writes sharing one
   * documentId inside a SINGLE retain() must collapse to one record (last
   * write wins). Without the collapse both allocate ids — the om:docid pointer
   * is read once, before the loop — and the first record is orphaned forever,
   * reachable by neither documentId nor a later upsert.
   */
  it('collapses duplicate documentIds within one batch to a single record, last write wins', async () => {
    const p4 = nextPrefix();
    const s = makeStore(p4);
    try {
      const out = await s.retain('batchdup', [
        { content: 'earlier write in the batch that must not survive as its own record', context: 'lesson', documentId: 'b1' },
        { content: 'later write in the batch that wins the documentId collision', context: 'lesson', documentId: 'b1' },
      ]);
      expect(out.ok).toBe(true);

      const ids = await raw!.zrange(`${p4}scope:batchdup`, 0, -1);
      expect(ids).toHaveLength(1);
      const rec = await raw!.hgetall(`${p4}rec:${ids[0]}`);
      expect(rec.content).toContain('later write in the batch');
      expect(await raw!.get(`${p4}docid:batchdup:b1`)).toBe(ids[0]);
      expect(out.count).toBe(1);
    } finally {
      await s.close();
      await cleanup(p4, ['batchdup'], [`${p4}docid:batchdup:b1`]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. BIT-EXACT RECALL EQUIVALENCE
// ─────────────────────────────────────────────────────────────────────────────

d('B. a cold store recalls bit-identically to a hot one', () => {
  const prefix = nextPrefix();
  const scopeA = 'projA';
  const scopeB = 'projB';
  const N = 60;

  // Lexically distant from the templated corpus, so it has no near-duplicates.
  const UNIQUE_A =
    'quokka lighthouse semaphore drifting through amber telemetry corridors nightly';

  let hot: RedisMemoryStore;
  let cold: RedisMemoryStore;
  let aCount = 0;
  let bCount = 0;

  beforeAll(async () => {
    hot = makeStore(prefix);
    const a: MemoryWrite[] = [];
    const b: MemoryWrite[] = [];
    for (let i = 0; i < N; i++) (i % 3 === 0 ? b : a).push(corpusWrite(i));
    a.push({ content: UNIQUE_A, context: 'lesson' });
    aCount = a.length;
    bCount = b.length;
    await hot.retain(scopeA, a);
    await hot.retain(scopeB, b);

    cold = makeStore(prefix);
    await cold.hydrate();
  }, 30_000);

  afterAll(async () => {
    await hot?.close();
    await cold?.close();
    await cleanup(prefix, [scopeA, scopeB]);
  });

  it('hydrates every record that was retained', () => {
    expect(hot.indexSize).toBe(N + 1);
    expect(cold.indexSize).toBe(N + 1);
  });

  const queries = [
    'caching strategy invalidation policy',
    'retry backoff flaky downstream',
    'schema migration ordering shards',
    'zqxa0007',
    'observability sampling cardinality budget gateway',
    'compaction write amplification',
    'partition rebalancing producer pressure token rotation',
    'record marker',
  ];

  for (const q of queries) {
    it(`query "${q}" — identical records, ordering and relevance floats`, async () => {
      let total = 0;
      for (const scope of [scopeA, scopeB]) {
        const h = await hot.recall(scope, q, { maxTokens: 100_000, minRelevance: 0.05 });
        const c = await cold.recall(scope, q, { maxTokens: 100_000, minRelevance: 0.05 });
        expect(shape(c), `scope ${scope}`).toEqual(shape(h));
        total += c.records.length;
      }
      // Guard against the comparison passing vacuously on two empty results.
      expect(total).toBeGreaterThan(0);
    });
  }

  it('relevance survives hydration as the exact scorer output, not an approximation', async () => {
    const out = await cold.recall(scopeA, 'caching strategy invalidation policy', {
      maxTokens: 100_000,
      minRelevance: 0.05,
    });
    expect(out.records.length).toBeGreaterThan(1);
    for (const r of out.records) {
      expect(r.relevance).toBe(
        computeClientRelevance('caching strategy invalidation policy', r.content),
      );
    }
  });

  it('token-budget truncation is identical across the boot boundary', async () => {
    for (const maxTokens of [1, 30, 64, 128, 512]) {
      const h = await hot.recall(scopeA, 'record marker caching retry schema', { maxTokens, minRelevance: 0.05 });
      const c = await cold.recall(scopeA, 'record marker caching retry schema', { maxTokens, minRelevance: 0.05 });
      expect(shape(c)).toEqual(shape(h));
    }
  });

  it('isDuplicate agrees before and after hydration', async () => {
    for (const probe of [corpusWrite(11).content, UNIQUE_A, 'wholly unrelated text about botany and tidal charts']) {
      expect(await cold.isDuplicate(scopeA, probe), probe.slice(0, 30))
        .toBe(await hot.isDuplicate(scopeA, probe));
      expect(await cold.isDuplicate(scopeB, probe), probe.slice(0, 30))
        .toBe(await hot.isDuplicate(scopeB, probe));
    }
    expect(await cold.isDuplicate(scopeA, UNIQUE_A)).toBe(true);
    // Same content, wrong scope — scope metadata must have survived hydration.
    expect(await cold.isDuplicate(scopeB, UNIQUE_A)).toBe(false);
    expect(await cold.isDuplicate(scopeA, 'wholly unrelated text about botany and tidal charts')).toBe(false);
  });

  it('listScopes() counts match the retained split', async () => {
    const scopes = await cold.listScopes();
    const byId = new Map(scopes.map((s) => [s.id, s.recordCount]));
    expect(byId.get(scopeA)).toBe(aCount);
    expect(byId.get(scopeB)).toBe(bCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. BATCH BOUNDARY (BATCH = 500)
// ─────────────────────────────────────────────────────────────────────────────

d('C. hydration across the BATCH=500 boundary', () => {
  const prefix = nextPrefix();
  const scope = 'bulk';
  const N = 1200; // 2 full batches + a 200-record remainder

  let hot: RedisMemoryStore;
  let cold: RedisMemoryStore;

  beforeAll(async () => {
    hot = makeStore(prefix);
    for (let i = 0; i < N; i += 300) {
      const batch: MemoryWrite[] = [];
      for (let j = i; j < Math.min(i + 300, N); j++) batch.push(corpusWrite(j));
      await hot.retain(scope, batch);
    }
    cold = makeStore(prefix);
    await cold.hydrate();
  }, 120_000);

  afterAll(async () => {
    await hot?.close();
    await cold?.close();
    await cleanup(prefix, [scope]);
  });

  it('Redis holds all 1200 ids', async () => {
    expect(await raw!.zrange(`${prefix}scope:${scope}`, 0, -1)).toHaveLength(N);
  });

  it('the rebuilt index holds all 1200 records — no batch-edge loss', () => {
    expect(hot.indexSize).toBe(N);
    expect(cold.indexSize).toBe(N);
  });

  it('every record is individually recallable from the cold store', async () => {
    // Probe the batch seams explicitly plus a spread of the interior.
    const probes = [0, 1, 249, 250, 498, 499, 500, 501, 749, 998, 999, 1000, 1001, 1198, 1199];
    for (const i of probes) {
      const marker = `zqxa${String(i).padStart(4, '0')}`;
      const out = await cold.recall(scope, marker, { maxTokens: 100_000 });
      expect(out.records.map((r) => r.content), `marker ${marker}`).toContain(corpusWrite(i).content);
    }
  }, 30_000);

  it('exhaustive: every one of the 1200 markers resolves after hydration', async () => {
    const missing: number[] = [];
    for (let i = 0; i < N; i++) {
      const marker = `zqxa${String(i).padStart(4, '0')}`;
      const out = await cold.recall(scope, marker, { maxTokens: 100_000 });
      if (!out.records.some((r) => r.content === corpusWrite(i).content)) missing.push(i);
    }
    expect(missing).toEqual([]);
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// D. CORRUPT KEYSPACE — SCOPE MEMBER WITH NO HASH
// ─────────────────────────────────────────────────────────────────────────────

d('D. a scope member whose om:rec hash is missing', () => {
  const prefix = nextPrefix();
  const scope = 'torn';
  let hot: RedisMemoryStore;
  let ids: string[] = [];
  let victim = '';

  beforeAll(async () => {
    hot = makeStore(prefix);
    await hot.retain(scope, [corpusWrite(0), corpusWrite(1), corpusWrite(2)]);
    ids = (await raw!.zrange(`${prefix}scope:${scope}`, 0, -1)).sort((a, b) => Number(a) - Number(b));
    victim = ids[1]!; // corpusWrite(1)
    await raw!.del(`${prefix}rec:${victim}`);
  });

  afterAll(async () => {
    await hot?.close();
    await cleanup(prefix, [scope]);
  });

  it('hydration does not throw', async () => {
    const cold = makeStore(prefix);
    try {
      await expect(cold.hydrate()).resolves.toBeUndefined();
      expect(cold.isHydrated).toBe(true);
    } finally {
      await cold.close();
    }
  });

  it('no phantom index entry is created for the missing record', async () => {
    const cold = makeStore(prefix);
    try {
      await cold.hydrate();
      expect(cold.indexSize).toBe(2);
      const out = await cold.recall(scope, 'zqxa0001', { maxTokens: 100_000 });
      expect(out.records).toHaveLength(0);
      expect(out.lowConfidence).toBe(true);
    } finally {
      await cold.close();
    }
  });

  it('the surviving records are unaffected', async () => {
    const cold = makeStore(prefix);
    try {
      await cold.hydrate();
      for (const i of [0, 2]) {
        const out = await cold.recall(scope, `zqxa${String(i).padStart(4, '0')}`, { maxTokens: 100_000 });
        expect(out.records.map((r) => r.content)).toContain(corpusWrite(i).content);
      }
    } finally {
      await cold.close();
    }
  });

  /**
   * REGRESSION GUARD: the HOT store still has the deleted record in its index
   * and metadata, so the budget pass charges its tokens before the pipeline
   * runs; the hash is only discovered missing afterwards. `tokensUsed` must be
   * billed from what was actually DELIVERED, never from the pre-fetch budget —
   * otherwise the caller is told it spent budget on content it never received
   * and anything sizing a downstream prompt from tokensUsed under-fills. This
   * is the same path a Redis eviction takes.
   */
  it('tokensUsed bills only for delivered records when a hash vanished mid-flight', async () => {
    const out = await hot.recall(scope, 'zqxa0001', { maxTokens: 100_000 });
    expect(out.records).toHaveLength(0);
    expect(out.tokensUsed).toBe(0);
  });

  it('a mixed result set bills exactly the sum of the surviving records', async () => {
    // Query matches all three originals; one hash is gone. tokensUsed must be
    // the sum over the two that came back, not over all three candidates.
    const out = await hot.recall(scope, 'record marker covering number', { maxTokens: 100_000, minRelevance: 0.05 });
    expect(out.records.map((r) => r.content)).not.toContain(corpusWrite(1).content);
    // Exactly the two survivors — so the vanished record really was a
    // candidate that got budgeted and then dropped, not one the query missed.
    expect(out.records).toHaveLength(2);
    expect(out.tokensUsed).toBe(out.records.reduce((n, r) => n + r.estimatedTokens, 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. EMPTY / ABSENT CONTENT
// ─────────────────────────────────────────────────────────────────────────────

d('E. records with empty or absent content', () => {
  const prefix = nextPrefix();
  const scope = 'hollow';
  const orphanId = '999000001';

  let hot: RedisMemoryStore;

  beforeAll(async () => {
    hot = makeStore(prefix);
    await hot.retain(scope, [
      corpusWrite(4),
      { content: '', context: 'lesson' },
      corpusWrite(5),
    ]);
    // A hash that exists but has no `content` field at all, and is a member of
    // the scope set — exactly what a partially-applied write would leave.
    await raw!.hset(`${prefix}rec:${orphanId}`, {
      scope,
      context: 'lesson',
      timestamp: new Date().toISOString(),
      tokens: '12',
    });
    // Scope membership is a ZSET scored by seq, and the id IS the seq, so the
    // SADD equivalent is ZADD with the id as its own score.
    await raw!.zadd(`${prefix}scope:${scope}`, Number(orphanId), orphanId);
  });

  afterAll(async () => {
    await hot?.close();
    await cleanup(prefix, [scope], [`${prefix}rec:${orphanId}`]);
  });

  it('an empty-content record is persisted to Redis and stays in the scope set', async () => {
    const ids = await raw!.zrange(`${prefix}scope:${scope}`, 0, -1);
    expect(ids).toHaveLength(4); // 3 retained + the orphan
    const hashes = await Promise.all(ids.map((id) => raw!.hgetall(`${prefix}rec:${id}`)));
    expect(hashes.filter((h) => h.content === '')).toHaveLength(1);
  });

  it('hydration skips content-less records without crashing or creating phantoms', async () => {
    const cold = makeStore(prefix);
    try {
      await cold.hydrate();
      expect(cold.isHydrated).toBe(true);
      // Only the two real records are indexable.
      expect(cold.indexSize).toBe(2);
    } finally {
      await cold.close();
    }
  });

  it('recall is unaffected — the same two records come back hot and cold', async () => {
    const cold = makeStore(prefix);
    try {
      await cold.hydrate();
      const q = 'record marker caching retry';
      expect(shape(await cold.recall(scope, q, { maxTokens: 100_000, minRelevance: 0.05 })))
        .toEqual(shape(await hot.recall(scope, q, { maxTokens: 100_000, minRelevance: 0.05 })));
    } finally {
      await cold.close();
    }
  });

  it('listScopes() counts the unindexable records — Redis count and index size diverge', async () => {
    const cold = makeStore(prefix);
    try {
      await cold.hydrate();
      const scopes = await cold.listScopes();
      const count = scopes.find((s) => s.id === scope)?.recordCount;
      // Documented, not asserted-as-desirable: zcard is the Redis truth (4)
      // while the index holds 2. Any health check comparing the two will
      // report drift that is not drift.
      expect(count).toBe(4);
      expect(cold.indexSize).toBe(2);
    } finally {
      await cold.close();
    }
  });

  /**
   * REGRESSION GUARD (derived-state drift): retain() must apply the same
   * `if (!rec.content) continue` guard that hydrate() applies, or a store that
   * has just written an empty-content record reports indexSize N while the very
   * same store rebooted reports N-1. The record is unreachable either way, so
   * recall is unharmed — but `indexSize` is the documented diagnostic /
   * recall-health surface, and it must not move across a restart that changed
   * no data.
   */
  it('indexSize is identical hot and rebooted — retain and hydrate agree on what is indexable', async () => {
    const cold = makeStore(prefix);
    try {
      await cold.hydrate();
      expect(hot.indexSize).toBe(2); // the empty-content write is not indexed
      expect(cold.indexSize).toBe(hot.indexSize);
    } finally {
      await cold.close();
    }
  });

  /**
   * The empty-content write is still STORED and still counted by Redis; only
   * the derived index skips it. Suppressing it from the index must not have
   * turned into suppressing the write.
   */
  it('the skipped-from-index record is still retained, counted and reported ok', async () => {
    const p = nextPrefix();
    const s = makeStore(p);
    try {
      const out = await s.retain('hollow2', [
        corpusWrite(6),
        { content: '', context: 'lesson' },
      ]);
      // Both writes landed in Redis; only one of them is indexable.
      expect(out).toEqual({ ok: true, count: 2 });
      expect(await raw!.zrange(`${p}scope:hollow2`, 0, -1)).toHaveLength(2);
      expect(s.indexSize).toBe(1);
    } finally {
      await s.close();
      await cleanup(p, ['hollow2']);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. SCOPE ISOLATION AND EXPIRY SURVIVE HYDRATION
// ─────────────────────────────────────────────────────────────────────────────

d('F. scope membership and expiry survive hydration', () => {
  const prefix = nextPrefix();
  const shared = 'identical content stored under three separate memory scopes for isolation testing';

  const scopes = ['iso-one', 'iso-two', 'iso-three'];

  const stale = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  const fresh = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();

  let cold: RedisMemoryStore;

  beforeAll(async () => {
    const hot = makeStore(prefix);
    for (const s of scopes) await hot.retain(s, [{ content: shared, context: 'lesson' }]);
    // node_output has a 14-day TTL; one stale, one fresh, same scope.
    await hot.retain('iso-one', [
      { content: 'ephemeral node output alpha that is well past its retention window', context: 'node_output', timestamp: stale },
      { content: 'ephemeral node output beta that is still inside its retention window', context: 'node_output', timestamp: fresh },
    ]);
    await hot.close();

    cold = makeStore(prefix);
    await cold.hydrate();
  });

  afterAll(async () => {
    await cold?.close();
    await cleanup(prefix, scopes);
  });

  it('identical content in three scopes yields three distinct ids', async () => {
    for (const s of scopes) {
      expect(await raw!.zrange(`${prefix}scope:${s}`, 0, -1)).not.toHaveLength(0);
    }
    expect(cold.indexSize).toBe(5);
  });

  it('a hydrated cross-scope index still returns exactly one record per scope', async () => {
    for (const s of scopes) {
      const out = await cold.recall(s, 'identical content three separate memory scopes', { maxTokens: 100_000 });
      expect(out.records.map((r) => r.content)).toEqual([shared]);
    }
  });

  it('a scope that was never written recalls empty rather than throwing', async () => {
    const out = await cold.recall('iso-nonexistent', 'identical content three separate scopes');
    expect(out.records).toEqual([]);
    expect(out.lowConfidence).toBe(true);
  });

  it('context+timestamp survive hydration well enough to drive TTL filtering', async () => {
    const out = await cold.recall('iso-one', 'ephemeral node output retention window', { maxTokens: 100_000, minRelevance: 0.05 });
    const contents = out.records.map((r) => r.content);
    expect(contents.some((c) => c.includes('beta'))).toBe(true);
    expect(contents.some((c) => c.includes('alpha'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. HYDRATION RUNS ONCE; CONNECTION ACCOUNTING
// ─────────────────────────────────────────────────────────────────────────────

d('G. hydrate() runs exactly once under concurrency', () => {
  const prefix = nextPrefix();
  const scope = 'conc';

  beforeAll(async () => {
    const seeder = makeStore(prefix);
    const writes: MemoryWrite[] = [];
    for (let i = 0; i < 12; i++) writes.push(corpusWrite(i));
    await seeder.retain(scope, writes);
    await seeder.close();
  });

  afterAll(async () => {
    await cleanup(prefix, [scope], [`${prefix}docid:${scope}:conc-doc`]);
  });

  it('concurrent recall/retain/isDuplicate on a fresh store hydrate once — index does not double', async () => {
    const s = makeStore(prefix);
    try {
      expect(s.isHydrated).toBe(false);
      await Promise.all([
        s.recall(scope, 'caching strategy'),
        s.recall(scope, 'retry backoff'),
        s.isDuplicate(scope, corpusWrite(3).content),
        s.retain(scope, [{ content: 'a thirteenth record written during the hydration race', context: 'lesson', documentId: 'conc-doc' }]),
      ]);
      expect(s.isHydrated).toBe(true);
      expect(s.indexSize).toBe(13);
    } finally {
      await s.close();
    }
  });

  it('a second explicit hydrate() is a no-op', async () => {
    const s = makeStore(prefix);
    try {
      await s.hydrate();
      const first = s.indexSize;
      await s.hydrate();
      await s.hydrate();
      expect(s.indexSize).toBe(first);
    } finally {
      await s.close();
    }
  });

  it('sanity: connection instrumentation is live', async () => {
    const before = connCount;
    const s = makeStore(prefix);
    try {
      await s.hydrate();
    } finally {
      await s.close();
    }
    expect(connCount).toBe(before + 1);
  });

  /**
   * REGRESSION GUARD (connection leak): `conn()` must memoise its in-flight
   * promise the way hydrate() memoises `this.hydrating`. `health()` and
   * `listScopes()` do NOT funnel through `hydrate()`, so either one racing a
   * first recall/retain enters `conn()` while `this.client` is still null.
   * Without the guard two ioredis sockets are opened, the second assignment
   * overwrites the first, and `close()` only quits the one it can still see —
   * the orphan stays open for the life of the process, an unbounded FD leak on
   * any startup shape that health-checks a store before serving.
   */
  it('health() racing a first recall opens exactly one Redis connection', async () => {
    const before = connCount;
    const s = makeStore(prefix);
    try {
      await Promise.all([s.health(), s.recall(scope, 'caching strategy')]);
    } finally {
      await s.close();
    }
    expect(connCount - before).toBe(1);
  });

  it('four concurrent entrants that all bypass hydrate() still share one connection', async () => {
    const before = connCount;
    const s = makeStore(prefix);
    try {
      const out = await Promise.all([
        s.health(),
        s.listScopes(),
        s.health(),
        s.recall(scope, 'retry backoff'),
      ]);
      // The shared socket is a working one, not a half-open loser.
      expect((out[0] as { healthy: boolean }).healthy).toBe(true);
      expect((out[2] as { healthy: boolean }).healthy).toBe(true);
    } finally {
      await s.close();
    }
    expect(connCount - before).toBe(1);
  });

  /**
   * REGRESSION GUARD (key leak): `deleteScope()` must delete the
   * `om:docid:{scope}:{documentId}` pointers alongside `om:rec:{id}`,
   * `om:scope:{scope}` and the `om:scopes` membership. A surviving pointer is
   * not merely untidy — a later retain() with the same documentId resolves it
   * and RESURRECTS the deleted id, writing into a record the scope set no
   * longer references.
   */
  it('deleteScope() deletes the om:docid pointers it created', async () => {
    const p = nextPrefix();
    const s = makeStore(p);
    try {
      await s.retain('doomed', [{ content: 'a document that will outlive its own scope', context: 'lesson', documentId: 'ghost' }]);
      expect(await raw!.get(`${p}docid:doomed:ghost`)).not.toBeNull();
      await s.deleteScope('doomed');
      expect(await raw!.get(`${p}docid:doomed:ghost`)).toBeNull();
    } finally {
      await s.close();
      await cleanup(p, ['doomed'], [`${p}docid:doomed:ghost`]);
    }
  });

  /** The consequence the pointer cleanup exists to prevent. */
  it('a retain after deleteScope allocates a fresh id rather than resurrecting the deleted one', async () => {
    const p = nextPrefix();
    const s = makeStore(p);
    try {
      await s.retain('recycled', [{ content: 'the original document before the scope was deleted', context: 'lesson', documentId: 'phoenix' }]);
      const oldId = (await raw!.zrange(`${p}scope:recycled`, 0, -1))[0]!;

      await s.deleteScope('recycled');
      expect(await raw!.exists(`${p}rec:${oldId}`)).toBe(0);

      await s.retain('recycled', [{ content: 'a wholly new document written under the same documentId', context: 'lesson', documentId: 'phoenix' }]);
      const ids = await raw!.zrange(`${p}scope:recycled`, 0, -1);
      expect(ids).toHaveLength(1);
      const newId = ids[0]!;
      expect(newId).not.toBe(oldId);
      const rec = await raw!.hgetall(`${p}rec:${newId}`);
      expect(rec.content).toBe('a wholly new document written under the same documentId');
      expect(await raw!.get(`${p}docid:recycled:phoenix`)).toBe(newId);
    } finally {
      await s.close();
      await cleanup(p, ['recycled'], [`${p}docid:recycled:phoenix`]);
    }
  });

  it('deleteScope() removes the records from Redis and from the derived index', async () => {
    const p = nextPrefix();
    const s = makeStore(p);
    try {
      await s.retain('gone', [corpusWrite(0), corpusWrite(1)]);
      const ids = await raw!.zrange(`${p}scope:gone`, 0, -1);
      expect(s.indexSize).toBe(2);
      await s.deleteScope('gone');
      expect(s.indexSize).toBe(0);
      for (const id of ids) expect(await raw!.exists(`${p}rec:${id}`)).toBe(0);
      expect(await raw!.smembers(`${p}scopes`)).not.toContain('gone');

      const cold = makeStore(p);
      try {
        await cold.hydrate();
        expect(cold.indexSize).toBe(0);
      } finally {
        await cold.close();
      }
    } finally {
      await s.close();
      await cleanup(p, ['gone']);
    }
  });
});
