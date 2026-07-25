/**
 * Phase 3 — RedisMemoryStore CONTRACT SEMANTICS.
 *
 * Risk surface: the MemoryStore contract as implemented by RedisMemoryStore.
 * The existing smoke test covers the happy path (retain / recall / hydrate /
 * upsert / deleteScope). This file probes the edges the smoke test skips:
 *
 *   - deleteScope() completeness (om:docid:* pointers, no id resurrection)
 *   - listScopes() counts across add / upsert / delete
 *   - retain([]) / retainOne() equivalence / importance clamping / metadata
 *   - upsert field semantics (HSET merges, so the old hash must be dropped)
 *   - duplicate documentId INSIDE one retain batch
 *   - recall() token budgeting (`continue`, not `break`) and tokensUsed
 *   - recall() minRelevance 0 and 1, empty scope, empty query
 *   - lowConfidence (`best < 0.4`)
 *   - isDuplicate() against a GLOBAL (cross-scope) index
 *
 * REDIS SAFETY: db 15 only, every key under a pid-unique prefix, cleanup
 * deletes only keys matching that prefix (SCAN MATCH, never `KEYS *`).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import { createRedisConnection, type RedisLike } from '../redis-connection.js';
import { estimateTokens } from '@orionomega/shared/similarity';

// Honour REDIS_URL so CI can point at its service container, and so the
// skip-guard can be exercised against an unreachable server.
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DB = 15;
const BASE = `omtest-semantics-${process.pid}-`;

let sub = 0;
const nextPrefix = () => `${BASE}${sub++}:`;

const stores: RedisMemoryStore[] = [];
function mk(prefix: string, extra: Record<string, unknown> = {}): RedisMemoryStore {
  const s = new RedisMemoryStore({
    redis: { url: URL, db: DB, keyPrefix: prefix },
    ...extra,
  });
  stores.push(s);
  return s;
}

const REDIS_UP = await (async () => {
  try {
    const s = new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: `${BASE}probe:` } });
    const h = await s.health();
    await s.close();
    return h.healthy;
  } catch {
    return false;
  }
})();

const d = REDIS_UP ? describe : describe.skip;

/** Raw client for keyspace assertions. Full keys are written by hand. */
let raw: RedisLike | null = null;
async function rawClient(): Promise<RedisLike> {
  if (!raw) raw = await createRedisConnection({ url: URL, db: DB });
  return raw;
}

/** SCAN for keys under OUR prefix only. Never a wildcard over the whole db. */
async function scanMine(pattern: string): Promise<string[]> {
  const c = (await rawClient()) as unknown as {
    scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  };
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', '500');
    found.push(...keys);
    cursor = next;
  } while (cursor !== '0');
  return found;
}

afterAll(async () => {
  if (!REDIS_UP) return;
  for (const s of stores) {
    try {
      await s.close();
    } catch {
      /* ignore */
    }
  }
  try {
    const c = await rawClient();
    // Only keys we created: BASE embeds this process's pid.
    const mine = await scanMine(`${BASE}*`);
    if (mine.length > 0) await c.del(...mine);
    await c.quit();
  } catch {
    /* ignore */
  }
  raw = null;
});

// ── deleteScope() completeness ────────────────────────────────────────────

d('deleteScope() completeness', () => {
  it('removes om:rec, om:scope and the om:scopes membership', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'the quick brown fox jumps over the lazy dog', context: 'lesson' },
      { content: 'a second unrelated record about pelicans', context: 'lesson' },
    ]);
    expect(await scanMine(`${p}rec:*`)).toHaveLength(2);

    await store.deleteScope('alpha');

    expect(await scanMine(`${p}rec:*`)).toHaveLength(0);
    expect(await scanMine(`${p}scope:alpha`)).toHaveLength(0);
    expect(await store.listScopes()).toEqual([]);
  });

  it('drops the deleted records out of the in-process index', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'the quick brown fox jumps over the lazy dog', context: 'lesson' },
    ]);
    expect(store.indexSize).toBe(1);
    await store.deleteScope('alpha');
    expect(store.indexSize).toBe(0);
    const out = await store.recall('alpha', 'quick brown fox');
    expect(out.records).toEqual([]);
  });

  it('is a no-op (not a throw) for a scope that never existed', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await expect(store.deleteScope('never-existed')).resolves.toBeUndefined();
    expect(await store.listScopes()).toEqual([]);
    // And twice in a row on a real scope.
    await store.retain('alpha', [{ content: 'something worth remembering here', context: 'lesson' }]);
    await store.deleteScope('alpha');
    await expect(store.deleteScope('alpha')).resolves.toBeUndefined();
  });

  // deleteScope() reads the records first to recover their documentIds, then
  // deletes om:rec:{id}, om:docid:{scope}:{documentId}, om:scope:{scope} and the
  // om:scopes membership. Nothing under the scope may survive: a surviving docid
  // pointer has no TTL and would let a later retain resurrect a deleted id.
  it('deleteScope() also removes the om:docid:{scope}:{documentId} pointers', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'document scoped record about migrations', context: 'lesson', documentId: 'doc-1' },
    ]);
    expect(await scanMine(`${p}docid:alpha:*`)).toHaveLength(1);

    await store.deleteScope('alpha');

    expect(await scanMine(`${p}docid:alpha:*`)).toHaveLength(0);
    // And nothing else under the scope either.
    expect(await scanMine(`${p}rec:*`)).toHaveLength(0);
  });

  it('a post-delete retain with the same documentId allocates a fresh id, not the dead one', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'document scoped record about migrations', context: 'lesson', documentId: 'doc-1' },
    ]);
    const c = await rawClient();
    const idBefore = await c.get(`${p}docid:alpha:doc-1`);
    expect(idBefore).toBeTruthy();

    await store.deleteScope('alpha');
    // Burn some ids so a fresh allocation would be visibly different.
    await store.retain('beta', [
      { content: 'filler record one for id allocation', context: 'lesson' },
      { content: 'filler record two for id allocation', context: 'lesson' },
    ]);
    await store.retain('alpha', [
      { content: 'rewritten document scoped record', context: 'lesson', documentId: 'doc-1' },
    ]);

    const idAfter = await c.get(`${p}docid:alpha:doc-1`);
    // The pointer was deleted with the scope, so the write allocates from om:seq
    // instead of writing into the id the deleted record used to occupy.
    expect(idAfter).not.toBe(idBefore);
    expect(Number(idAfter)).toBeGreaterThan(Number(idBefore));
    // The dead id stays dead — the rewrite did not land in the old hash.
    expect(await c.hgetall(`${p}rec:${idBefore}`)).toEqual({});

    const out = await store.recall('alpha', 'rewritten document scoped record');
    expect(out.records.map((r) => r.content)).toEqual(['rewritten document scoped record']);
  });
});

// ── listScopes() ──────────────────────────────────────────────────────────

d('listScopes()', () => {
  it('counts match reality across adds, upserts and deletes', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const count = async (id: string) =>
      (await store.listScopes()).find((s) => s.id === id)?.recordCount;

    expect(await store.listScopes()).toEqual([]);

    await store.retain('alpha', [
      { content: 'alpha record one about deployment', context: 'lesson' },
      { content: 'alpha record two about rollbacks', context: 'lesson' },
    ]);
    await store.retain('beta', [{ content: 'beta record about pelicans', context: 'lesson' }]);

    const scopes = await store.listScopes();
    expect(scopes.map((s) => s.id).sort()).toEqual(['alpha', 'beta']);
    expect(await count('alpha')).toBe(2);
    expect(await count('beta')).toBe(1);

    // Upsert of an existing documentId must NOT inflate the count.
    await store.retain('alpha', [
      { content: 'alpha doc record version one', context: 'lesson', documentId: 'd1' },
    ]);
    expect(await count('alpha')).toBe(3);
    await store.retain('alpha', [
      { content: 'alpha doc record version two', context: 'lesson', documentId: 'd1' },
    ]);
    expect(await count('alpha')).toBe(3);

    await store.deleteScope('alpha');
    expect((await store.listScopes()).map((s) => s.id)).toEqual(['beta']);
    expect(await count('beta')).toBe(1);
  });

  it('a fresh store sees the same scope counts (Redis is authoritative)', async () => {
    const p = nextPrefix();
    const a = mk(p);
    await a.retain('alpha', [
      { content: 'persisted record about the build pipeline', context: 'lesson' },
      { content: 'another persisted record about caching', context: 'lesson' },
    ]);
    const b = mk(p);
    expect(await b.listScopes()).toEqual([{ id: 'alpha', recordCount: 2 }]);
  });
});

// ── retain() / retainOne() ────────────────────────────────────────────────

d('retain() write semantics', () => {
  it('retain(scope, []) returns {ok:true,count:0} and touches nothing', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const out = await store.retain('alpha', []);
    expect(out).toEqual({ ok: true, count: 0 });
    expect(await scanMine(`${p}*`)).toEqual([]);
    // It short-circuits before hydrate(), so it must not have connected/hydrated either.
    expect(store.isHydrated).toBe(false);
    expect(await store.listScopes()).toEqual([]);
  });

  it('retainOne() is equivalent to retain() with a single write', async () => {
    const p1 = nextPrefix();
    const p2 = nextPrefix();
    const one = mk(p1);
    const many = mk(p2);

    const r1 = await one.retainOne('alpha', 'a memorable sentence about caches', 'lesson', ['t1']);
    const stamped = (await rawClient()).hgetall(`${p1}rec:1`);
    const r2 = await many.retain('alpha', [
      {
        content: 'a memorable sentence about caches',
        context: 'lesson',
        tags: ['t1'],
        // retainOne() defaults the timestamp to now; pin the comparison write to
        // the same instant so the two records are otherwise field-for-field equal.
        timestamp: (await stamped).timestamp,
      },
    ]);
    expect(r1).toEqual({ ok: true, count: 1 });
    expect(r2).toEqual(r1);

    const c = await rawClient();
    const h1 = await c.hgetall(`${p1}rec:1`);
    const h2 = await c.hgetall(`${p2}rec:1`);
    expect(h1.content).toBe(h2.content);
    expect(h1.context).toBe(h2.context);
    expect(h1.scope).toBe(h2.scope);
    expect(h1.tags).toBe(h2.tags);
    expect(h1.tokens).toBe(h2.tokens);
    expect(h1.timestamp).toBeTruthy();
    expect(h2.timestamp).toBeTruthy();

    const q = 'a memorable sentence about caches';
    const o1 = await one.recall('alpha', q);
    const o2 = await many.recall('alpha', q);
    expect(o1.records).toEqual(o2.records);
    expect(o1.tokensUsed).toBe(o2.tokensUsed);
    expect(o1.lowConfidence).toBe(o2.lowConfidence);
  });

  it('importance is clamped into [0,1]', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'record with a wildly negative importance', context: 'lesson', importance: -5 },
      { content: 'record with a wildly excessive importance', context: 'lesson', importance: 99 },
      { content: 'record with a sane importance value here', context: 'lesson', importance: 0.42 },
      { content: 'record with importance exactly zero here', context: 'lesson', importance: 0 },
      { content: 'record with no importance supplied at all', context: 'lesson' },
    ]);
    const c = await rawClient();
    expect((await c.hgetall(`${p}rec:1`)).importance).toBe('0');
    expect((await c.hgetall(`${p}rec:2`)).importance).toBe('1');
    expect((await c.hgetall(`${p}rec:3`)).importance).toBe('0.42');
    // importance: 0 is `!== undefined`, so it must be stored, not dropped.
    expect((await c.hgetall(`${p}rec:4`)).importance).toBe('0');
    expect((await c.hgetall(`${p}rec:5`)).importance).toBeUndefined();
  });

  it('a caller-supplied timestamp is preserved verbatim', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const ts = '2020-01-02T03:04:05.000Z';
    await store.retain('alpha', [
      { content: 'a record carrying an explicit timestamp', context: 'lesson', timestamp: ts },
    ]);
    const out = await store.recall('alpha', 'a record carrying an explicit timestamp');
    expect(out.records[0]?.timestamp).toBe(ts);
  });

  // MemoryWrite.metadata is part of the interface (store.ts:50) and must survive
  // the write, JSON-encoded onto `rec.metadata` the way tags are.
  it('MemoryWrite.metadata is persisted onto the record hash', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      {
        content: 'a record carrying caller metadata',
        context: 'lesson',
        metadata: { source: 'unit-test', runId: 'r-42' },
      },
    ]);
    const c = await rawClient();
    const h = await c.hgetall(`${p}rec:1`);
    expect(h.metadata).toBeTruthy();
    expect(JSON.parse(h.metadata!)).toEqual({ source: 'unit-test', runId: 'r-42' });
    // A write without metadata must not invent the field.
    await store.retain('alpha', [{ content: 'a record carrying no metadata', context: 'lesson' }]);
    expect((await c.hgetall(`${p}rec:2`)).metadata).toBeUndefined();
  });

  // retain() collapses duplicate documentIds WITHIN one batch (last write wins)
  // before allocating ids, so a batch behaves like the sequential upsert path.
  // Without the collapse each write allocated its own id, only the last won the
  // om:docid pointer, and the earlier record was an unreachable orphan that
  // still scored in recall.
  it('two writes sharing a documentId in ONE batch upsert rather than duplicate', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const out = await store.retain('alpha', [
      { content: 'batched document first revision text', context: 'lesson', documentId: 'same' },
      { content: 'batched document second revision text', context: 'lesson', documentId: 'same' },
    ]);
    const c = await rawClient();
    // Scope membership is a ZSET scored by seq, so the count comes from ZCARD.
    expect(await c.zcard(`${p}scope:alpha`)).toBe(1);
    // One record results, so the outcome counts one write, not two.
    expect(out).toEqual({ ok: true, count: 1 });
    expect(await scanMine(`${p}rec:*`)).toHaveLength(1);
  });

  it('the surviving batch revision is the last one, and it is the only recallable record', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'batched document first revision text', context: 'lesson', documentId: 'same' },
      { content: 'batched document second revision text', context: 'lesson', documentId: 'same' },
    ]);
    const out = await store.recall('alpha', 'batched document revision text');
    // Last write wins — same as two sequential upserts of the same documentId.
    expect(out.records.map((r) => r.content)).toEqual(['batched document second revision text']);
    // No orphan left behind in the hot index either.
    expect(store.indexSize).toBe(1);
  });

  // HSET MERGES, so the upsert path DELs the old hash before writing. Without
  // the del, fields present on the old revision but absent from the new one
  // (tags, importance, metadata) survive and the stored record becomes a union
  // of every revision ever written.
  it('an upsert that drops tags/importance/metadata does not keep the old values', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      {
        content: 'first revision of the upserted record',
        context: 'lesson',
        documentId: 'u1',
        tags: ['old-tag'],
        importance: 0.9,
        metadata: { old: 'value' },
      },
    ]);
    await store.retain('alpha', [
      { content: 'second revision of the upserted record', context: 'lesson', documentId: 'u1' },
    ]);
    const c = await rawClient();
    const h = await c.hgetall(`${p}rec:1`);
    expect(h.content).toBe('second revision of the upserted record');
    expect(h.tags).toBeUndefined();
    expect(h.importance).toBeUndefined();
    expect(h.metadata).toBeUndefined();
    // The fields the new revision DOES carry are still there — the del must not
    // leave a hole where the record used to be.
    expect(h.scope).toBe('alpha');
    expect(h.context).toBe('lesson');
    expect(h.documentId).toBe('u1');
    expect(h.timestamp).toBeTruthy();
  });
});

// ── recall() ──────────────────────────────────────────────────────────────

d('recall() edges', () => {
  it('an unknown scope recalls empty rather than throwing', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const out = await store.recall('no-such-scope', 'anything at all');
    expect(out).toEqual({ records: [], lowConfidence: true, tokensUsed: 0 });
  });

  it('an empty scope in a populated store recalls empty', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'a record that lives in the alpha scope', context: 'lesson' },
    ]);
    const out = await store.recall('beta', 'a record that lives in the alpha scope');
    expect(out.records).toEqual([]);
    expect(out.lowConfidence).toBe(true);
    expect(out.tokensUsed).toBe(0);
  });

  it('an empty query recalls nothing (normalised query is empty)', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'a record that lives in the alpha scope', context: 'lesson' },
    ]);
    for (const q of ['', '   ', '!!!']) {
      const out = await store.recall('alpha', q);
      expect(out.records).toEqual([]);
      expect(out.lowConfidence).toBe(true);
      expect(out.tokensUsed).toBe(0);
    }
  });

  it('minRelevance 1 admits only an exact-score match', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const exact = 'alpha beta gamma delta epsilon zeta';
    await store.retain('alpha', [
      { content: exact, context: 'lesson' },
      { content: 'alpha beta gamma delta epsilon', context: 'lesson' },
      { content: 'alpha beta gamma', context: 'lesson' },
    ]);
    const out = await store.recall('alpha', exact, { minRelevance: 1 });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.content).toBe(exact);
    expect(out.records[0]!.relevance).toBe(1);
    expect(out.lowConfidence).toBe(false);
  });

  it('minRelevance 0 admits every record reachable from the query postings', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'alpha beta gamma delta epsilon zeta', context: 'lesson' },
      { content: 'gamma only appears in this particular record', context: 'lesson' },
    ]);
    const out = await store.recall('alpha', 'alpha beta gamma delta epsilon zeta', {
      minRelevance: 0,
      maxTokens: 100_000,
    });
    expect(out.records).toHaveLength(2);
    for (const r of out.records) expect(r.relevance).toBeGreaterThan(0);
  });

  it('minRelevance 0 does NOT reach records with no lexical overlap at all', async () => {
    // Documents the real contract: the index is posting-driven, so a zero-scoring
    // record is unreachable even at a zero floor. Callers must not read
    // `minRelevance: 0` as "return everything in the scope".
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'zzzz wwww yyyy xxxx vvvv uuuu tttt', context: 'lesson' },
    ]);
    const out = await store.recall('alpha', 'alpha beta gamma delta epsilon', { minRelevance: 0 });
    expect(out.records).toEqual([]);
  });

  it('lowConfidence is false for a strong corpus and true for a weak one', async () => {
    const pStrong = nextPrefix();
    const strong = mk(pStrong);
    const exact = 'alpha beta gamma delta epsilon zeta';
    await strong.retain('alpha', [{ content: exact, context: 'lesson' }]);
    const hi = await strong.recall('alpha', exact);
    expect(hi.records.length).toBeGreaterThan(0);
    expect(Math.max(...hi.records.map((r) => r.relevance))).toBeGreaterThanOrEqual(0.4);
    expect(hi.lowConfidence).toBe(false);

    const pWeak = nextPrefix();
    const weak = mk(pWeak);
    await weak.retain('alpha', [
      { content: 'alpha padding padding padding padding padding', context: 'lesson' },
    ]);
    const lo = await weak.recall('alpha', 'alpha beta gamma');
    expect(lo.records.length).toBeGreaterThan(0);
    expect(Math.max(...lo.records.map((r) => r.relevance))).toBeLessThan(0.4);
    expect(lo.lowConfidence).toBe(true);
  });

  it('expired records are filtered out of recall but stay in Redis', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    await store.retain('alpha', [
      // session_anchor has a 30-day TTL; lesson is pinned and never expires.
      { content: 'expired anchor about the migration plan', context: 'session_anchor', timestamp: old },
      { content: 'pinned lesson about the migration plan', context: 'lesson', timestamp: old },
    ]);
    const out = await store.recall('alpha', 'migration plan');
    expect(out.records.map((r) => r.context)).toEqual(['lesson']);
    const c = await rawClient();
    expect((await c.hgetall(`${p}rec:1`)).content).toBe('expired anchor about the migration plan');
  });
});

// ── recall() token budgeting ──────────────────────────────────────────────

d('recall() token budgeting', () => {
  // Ranked A > B > C by keyword coverage of "alpha beta gamma".
  const A = `alpha beta gamma ${'padding '.repeat(20)}`.trim();
  const B = `alpha beta ${'padding '.repeat(200)}`.trim();
  const C = `alpha ${'padding '.repeat(3)}`.trim();
  const tA = estimateTokens(A);
  const tB = estimateTokens(B);
  const tC = estimateTokens(C);
  const Q = 'alpha beta gamma';

  async function seeded() {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: A, context: 'lesson' },
      { content: B, context: 'lesson' },
      { content: C, context: 'lesson' },
    ]);
    return store;
  }

  it('control: the three records rank A > B > C and carry the expected token counts', async () => {
    const store = await seeded();
    const out = await store.recall('alpha', Q, { maxTokens: 1_000_000 });
    expect(out.records.map((r) => r.content)).toEqual([A, B, C]);
    expect(out.records.map((r) => r.estimatedTokens)).toEqual([tA, tB, tC]);
    expect(out.tokensUsed).toBe(tA + tB + tC);
    expect(tB).toBeGreaterThan(tC);
  });

  it('`continue` (not `break`) lets a smaller lower-ranked record fill the tail of the budget', async () => {
    const store = await seeded();
    const budget = tA + tC; // fits A and C, but never A and B
    const out = await store.recall('alpha', Q, { maxTokens: budget });
    // With `break` this would be [A] only.
    expect(out.records.map((r) => r.content)).toEqual([A, C]);
    expect(out.tokensUsed).toBe(budget);
  });

  it('a budget smaller than the top hit still returns the records that fit', async () => {
    const store = await seeded();
    const out = await store.recall('alpha', Q, { maxTokens: tC });
    expect(out.records.map((r) => r.content)).toEqual([C]);
    expect(out.tokensUsed).toBe(tC);
  });

  it('tokensUsed always equals the sum of the returned records estimatedTokens', async () => {
    const store = await seeded();
    for (const maxTokens of [tC, tA, tA + tC, tA + tB, tA + tB + tC, 1_000_000]) {
      const out = await store.recall('alpha', Q, { maxTokens });
      const sum = out.records.reduce((n, r) => n + (r.estimatedTokens ?? 0), 0);
      expect({ maxTokens, tokensUsed: out.tokensUsed }).toEqual({ maxTokens, tokensUsed: sum });
      expect(out.tokensUsed).toBeLessThanOrEqual(maxTokens);
    }
  });

  it('a budget of 0 returns nothing and reports zero tokens', async () => {
    const store = await seeded();
    const out = await store.recall('alpha', Q, { maxTokens: 0 });
    expect(out.records).toEqual([]);
    expect(out.tokensUsed).toBe(0);
    expect(out.lowConfidence).toBe(true);
  });
});

// ── isDuplicate() ─────────────────────────────────────────────────────────

d('isDuplicate()', () => {
  it('is scope-local: an identical record in another scope is not a duplicate', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const text = 'a distinctive sentence about pelican migration routes';
    await store.retain('beta', [{ content: text, context: 'lesson' }]);
    expect(await store.isDuplicate('alpha', text)).toBe(false);
    expect(await store.isDuplicate('beta', text)).toBe(true);
  });

  it('respects the threshold argument', async () => {
    const p = nextPrefix();
    const store = mk(p);
    await store.retain('alpha', [
      { content: 'a distinctive sentence about pelican migration routes', context: 'lesson' },
    ]);
    expect(await store.isDuplicate('alpha', 'a distinctive sentence about pelican habits', 0.99)).toBe(false);
    expect(await store.isDuplicate('alpha', 'a distinctive sentence about pelican habits', 0.5)).toBe(true);
  });

  // The index is a candidate generator only, searched with NO limit, so
  // cross-scope matches cannot crowd an in-scope duplicate out of the window.
  // Ids are global by design, so the competing records take the LOW ids and a
  // limited search sorted (relevance desc, id asc) would truncate the alpha copy
  // away — a false negative that lets a duplicate be written.
  it('an in-scope duplicate is found even behind many equally-good cross-scope matches', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const text = 'a distinctive sentence about pelican migration routes';
    for (let i = 0; i < 20; i++) {
      await store.retain(`other-${i}`, [{ content: text, context: 'lesson' }]);
    }
    await store.retain('alpha', [{ content: text, context: 'lesson' }]);

    expect(await store.isDuplicate('alpha', text)).toBe(true);
    // Still scope-local: a scope with no copy of its own is unaffected.
    expect(await store.isDuplicate('gamma', text)).toBe(false);
  });

  it('control: with only seven competing scopes the same-scope duplicate is still found', async () => {
    const p = nextPrefix();
    const store = mk(p);
    const text = 'a distinctive sentence about pelican migration routes';
    for (let i = 0; i < 7; i++) {
      await store.retain(`other-${i}`, [{ content: text, context: 'lesson' }]);
    }
    await store.retain('alpha', [{ content: text, context: 'lesson' }]);
    expect(await store.isDuplicate('alpha', text)).toBe(true);
  });
});

// ── hydration ─────────────────────────────────────────────────────────────

d('hydration', () => {
  it('concurrent hydrate() calls scan once and leave the store hydrated', async () => {
    const p = nextPrefix();
    const seed = mk(p);
    await seed.retain('alpha', [
      { content: 'hydration record one about the scheduler', context: 'lesson' },
      { content: 'hydration record two about the scheduler', context: 'lesson' },
    ]);

    const fresh = mk(p);
    expect(fresh.isHydrated).toBe(false);
    await Promise.all([fresh.hydrate(), fresh.hydrate(), fresh.hydrate()]);
    expect(fresh.isHydrated).toBe(true);
    expect(fresh.indexSize).toBe(2);
    await fresh.hydrate();
    expect(fresh.indexSize).toBe(2);
  });

  it('hydration restores the token metadata recall budgets against', async () => {
    const p = nextPrefix();
    const seed = mk(p);
    const text = `alpha beta gamma ${'padding '.repeat(20)}`.trim();
    await seed.retain('alpha', [{ content: text, context: 'lesson' }]);
    const before = await seed.recall('alpha', 'alpha beta gamma');

    const fresh = mk(p);
    const after = await fresh.recall('alpha', 'alpha beta gamma');
    expect(after.records).toEqual(before.records);
    expect(after.tokensUsed).toBe(before.tokensUsed);
    expect(after.lowConfidence).toBe(before.lowConfidence);
  });
});
