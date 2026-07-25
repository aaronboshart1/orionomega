/**
 * @module memory/redis-store
 * {@link MemoryStore} backed by self-hosted Redis, with an in-process scored
 * index (docs/memory-architecture-v2.md §5, §8).
 *
 * ── DIVISION OF LABOUR ────────────────────────────────────────────────────
 *
 *   Redis         — authoritative record storage. Durability is AOF/RDB.
 *   MemoryIndex   — DERIVED. Rebuilt from Redis at boot, updated on append.
 *                   Holds no content, only postings and per-doc metadata.
 *   this.meta     — id → {scope, context, timestamp, tokens}. Lets recall
 *                   filter by scope and drop expired records BEFORE fetching
 *                   content from Redis, so a cross-scope index still serves
 *                   scope-narrowed queries with one round trip.
 *
 * ── IDS ARE GLOBAL, NOT PER-SCOPE ─────────────────────────────────────────
 *
 * A single `om:seq` counter allocates every record's id, so ids are unique
 * across scopes and ONE index can serve them all. That is what makes
 * cross-scope search cheap (§10): one query reaches every scope, so there is
 * no federation step and no periodic rollup to keep scopes in sync. Per-scope
 * counters would force either an index per scope or composite keys.
 *
 * ── KEYSPACE ──────────────────────────────────────────────────────────────
 *
 *   om:seq                        STRING  global INCR id allocator
 *   om:rec:{id}                   HASH    the record
 *   om:scope:{scope}              ZSET    ids in a scope, scored by seq
 *   om:scopes                     SET     known scope names
 *   om:docid:{scope}:{documentId} STRING  documentId → id, for upsert
 *   om:scopedocs:{scope}          SET     documentIds used in a scope
 *   om:pin:{scope}                HASH    pinned facts, always loaded
 *
 * Scope membership is a ZSET, not a SET, because the Memory Map and
 * `memory_read` both need ORDER: a range read is a score window and a segment
 * is a `[from, to]` seq span. A SET can answer neither without pulling every id
 * and sorting in process.
 *
 * `keyPrefix` is applied by this class rather than by ioredis so the key layout
 * stays greppable in redis-cli.
 */

import { createLogger } from '../logging/logger.js';
import { MemoryIndex, trigramCandidateFloor } from './memory-index.js';
import { isMemoryExpired } from './retention-engine.js';
import {
  createRedisConnection,
  probeEvictionPolicy,
  type RedisConnectionConfig,
  type RedisLike,
} from './redis-connection.js';
import type {
  MemoryStore,
  MemoryWrite,
  RecallOutcome,
  RecallQuery,
  RecalledRecord,
  RetainOutcome,
  ScopeInfo,
} from './store.js';
import { estimateTokens, normalize, trigramSimilarity } from '@orionomega/shared/similarity';
import { rankTerms, renderMemoryMap, type MemoryMapOptions, type SegmentSummary } from './memory-map.js';

const log = createLogger('redis-store');

/** Per-record metadata held in process so recall can filter before fetching. */
interface RecordMeta {
  scope: string;
  context: string;
  timestamp: string;
  tokens: number;
}

/** Outcome of a {@link RedisMemoryStore.collectGarbage} pass. */
export interface GcReport {
  /** Record hashes examined. */
  scanned: number;
  /** Past their category TTL (pinned categories are never counted). */
  expired: number;
  /** Referenced by no scope set — unreachable by any query. */
  orphaned: number;
  /** Actually removed. Zero on a dry run. */
  deleted: number;
  dryRun: boolean;
}

/** Schedule for the background GC loop. */
export interface GcScheduleOptions {
  /** Gap between passes. Floored at 60 s. Default 6 h. */
  intervalMs?: number;
  /**
   * Delay before the FIRST pass. Default 5 min.
   *
   * Not zero: GC scans the whole keyspace, and doing that during startup would
   * compete with hydration for the same connection right when the agent is
   * least responsive. A short delay still clears crash debris promptly.
   */
  initialDelayMs?: number;
  /**
   * Skip a pass unless at least this many records were written since the last
   * one. Default 1 — i.e. never scan an idle keyspace repeatedly.
   */
  minWritesBetweenRuns?: number;
}

export interface RedisMemoryStoreOptions {
  redis?: RedisConnectionConfig;
  /** Injected client, for tests. When set, no connection is created. */
  client?: RedisLike;
  /** Default relevance floor when a query does not specify one. */
  minRelevance?: number;
  /** Skip the boot hydration scan (tests that seed their own state). */
  skipHydrate?: boolean;
  /**
   * Start the background GC loop as soon as the store is constructed.
   *
   * Off by default so tests and short-lived scripts do not schedule background
   * work they never stop. Long-lived owners (the gateway) should pass this, or
   * call {@link RedisMemoryStore.startGc} explicitly — without one or the other
   * nothing ever calls {@link RedisMemoryStore.collectGarbage} and expired
   * records accumulate silently behind the read-time TTL filter.
   */
  gc?: GcScheduleOptions | boolean;
}

const DEFAULT_MIN_RELEVANCE = 0.15;
const DEFAULT_MAX_TOKENS = 4096;
/**
 * Max in-scope candidates fetched to confirm a duplicate. Dedup runs on the
 * write path, so this bounds its cost; candidates are relevance-ordered, so
 * the most similar are the ones kept.
 */
const DUPLICATE_PROBE_LIMIT = 32;

/**
 * Segment close thresholds — whichever trips first.
 *
 * Segments exist so the Memory Map can name spans of history. Too small and
 * the map is a wall of rows; too large and "expand this segment" pulls back
 * more than the budget allows.
 */
const SEGMENT_MAX_RECORDS = 50;
const SEGMENT_MAX_TOKENS = 8_000;
/** Terms in a generated segment label. */
const SEGMENT_LABEL_TERMS = 4;

/**
 * Atomic scope deletion.
 *
 * Enumerates and removes every key belonging to a scope in one indivisible
 * step. Keys are derived from the prefix inside the script rather than passed
 * in KEYS[], which is safe on the single instance §15 specifies but would need
 * rework for Redis Cluster.
 */
const DELETE_SCOPE_LUA = `
local prefix = ARGV[1]
local scope  = ARGV[2]
local scopeKey = prefix .. 'scope:' .. scope

local ids = redis.call('ZRANGE', scopeKey, 0, -1)
for i = 1, #ids do
  redis.call('DEL', prefix .. 'rec:' .. ids[i])
end

local docsKey = prefix .. 'scopedocs:' .. scope
local docs = redis.call('SMEMBERS', docsKey)
for i = 1, #docs do
  redis.call('DEL', prefix .. 'docid:' .. scope .. ':' .. docs[i])
end
redis.call('DEL', docsKey)

redis.call('DEL', prefix .. 'pin:' .. scope)

local segn = tonumber(redis.call('GET', prefix .. 'segn:' .. scope) or '0')
for i = 1, segn do
  redis.call('DEL', prefix .. 'seg:' .. scope .. ':' .. i)
end
redis.call('DEL', prefix .. 'segn:' .. scope)

redis.call('DEL', scopeKey)
redis.call('SREM', prefix .. 'scopes', scope)
return #ids
`;

export class RedisMemoryStore implements MemoryStore {
  private client: RedisLike | null = null;
  private readonly index = new MemoryIndex();
  private readonly meta = new Map<number, RecordMeta>();
  private readonly prefix: string;
  private readonly opts: RedisMemoryStoreOptions;
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  /** In-flight connection, memoised so concurrent callers share one socket. */
  private connecting: Promise<RedisLike> | null = null;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private gcInterval: ReturnType<typeof setInterval> | null = null;
  private gcRunning = false;
  private writesSinceGc = 0;
  /** Highest record id this instance has ingested — the sync high-water mark. */
  private maxIngestedId = 0;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private lastGc: { at: string; report: GcReport } | null = null;
  /** True when the client was supplied by the caller; we must not replace it. */
  private readonly injectedClient: boolean;

  constructor(opts: RedisMemoryStoreOptions = {}) {
    this.opts = opts;
    this.prefix = opts.redis?.keyPrefix ?? 'om:';
    this.injectedClient = opts.client !== undefined;
    if (opts.client) this.client = opts.client;
    if (opts.gc) this.startGc(opts.gc === true ? {} : opts.gc);
  }

  // ── keys ────────────────────────────────────────────────────────────────
  private kSeq() { return `${this.prefix}seq`; }
  private kRec(id: number) { return `${this.prefix}rec:${id}`; }
  private kScope(scope: string) { return `${this.prefix}scope:${scope}`; }
  private kScopes() { return `${this.prefix}scopes`; }
  private kDocId(scope: string, documentId: string) { return `${this.prefix}docid:${scope}:${documentId}`; }
  /** Every documentId used in a scope, so cleanup never has to read records. */
  private kScopeDocs(scope: string) { return `${this.prefix}scopedocs:${scope}`; }
  private kPin(scope: string) { return `${this.prefix}pin:${scope}`; }
  private kSeg(scope: string, n: number) { return `${this.prefix}seg:${scope}:${n}`; }
  /** Ordinal of the currently-open segment. */
  private kSegN(scope: string) { return `${this.prefix}segn:${scope}`; }

  /** Index size, for diagnostics and the recall-health surface (§13). */
  get indexSize(): number { return this.index.size; }
  get isHydrated(): boolean { return this.hydrated; }

  /**
   * Recall-health reporter (§13).
   *
   * Deliberately NOT a connectivity signal. The old surface reported whether a
   * socket was open, which told a user nothing actionable; this reports what
   * memory can currently DO:
   *
   *   ready       — hydrated and serving
   *   rebuilding  — index cold, so recall will under-return until it warms
   *   degraded    — Redis unreachable or a write failed
   *
   * The word "offline" never appears. Assigned by MemoryBridge.
   */
  onActivity?: (activity: {
    busy: boolean;
    health: 'ready' | 'rebuilding' | 'degraded';
    reason?: 'redis_unreachable' | 'index_cold' | 'write_failed';
    op?: string;
    count?: number;
  }) => void;

  /** In-flight operations, so `busy` reflects overlap rather than one call. */
  private activeOps = 0;

  private emitActivity(
    op: string,
    delta: number,
    opts: { degraded?: 'redis_unreachable' | 'write_failed'; count?: number } = {},
  ): void {
    if (!this.onActivity) return;
    this.activeOps = Math.max(0, this.activeOps + delta);
    const health = opts.degraded ? 'degraded' : this.hydrated ? 'ready' : 'rebuilding';
    this.onActivity({
      busy: this.activeOps > 0,
      health,
      ...(opts.degraded ? { reason: opts.degraded } : this.hydrated ? {} : { reason: 'index_cold' as const }),
      op,
      ...(opts.count !== undefined ? { count: opts.count } : {}),
    });
  }

  /**
   * The Redis client, connecting on first use.
   *
   * The in-flight promise is memoised. Without it, two concurrent entrants
   * both observe `this.client === null` across the `await` and each open a
   * socket; the loser is overwritten and leaks for the life of the process,
   * keeping the event loop alive. `health()` and `listScopes()` skip
   * `hydrate()` (which has its own guard) and land here directly, so the
   * "probe health, then serve" startup shape hits this race.
   */
  private async conn(): Promise<RedisLike> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = await createRedisConnection(this.opts.redis);
      await probeEvictionPolicy(client);
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Rebuild the in-process index from Redis.
   *
   * Idempotent and concurrency-safe: overlapping callers await the same
   * promise rather than scanning twice. Every public method funnels through
   * this, so a store is usable immediately after construction.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydrating) return this.hydrating;

    this.hydrating = (async () => {
      if (this.opts.skipHydrate) {
        this.hydrated = true;
        return;
      }
      const started = Date.now();
      const client = await this.conn();
      const scopes = await client.smembers(this.kScopes());

      let loaded = 0;
      for (const scope of scopes) {
        const ids = await client.zrange(this.kScope(scope), 0, -1);
        // Batch HGETALL so hydration is O(records / batch) round trips.
        const BATCH = 500;
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids.slice(i, i + BATCH);
          const pipe = client.pipeline();
          for (const id of chunk) pipe.hgetall(this.kRec(Number(id)));
          const res = await pipe.exec();
          if (!res) continue;
          for (let j = 0; j < res.length; j++) {
            const [err, val] = res[j]!;
            if (err || !val) continue;
            const rec = val as Record<string, string>;
            if (!rec.content) continue;
            const id = Number(chunk[j]);
            this.ingestIntoIndex(id, rec);
            loaded++;
          }
        }
      }

      this.hydrated = true;
      log.info('Memory index hydrated from Redis', {
        scopes: scopes.length,
        records: loaded,
        ms: Date.now() - started,
      });
    })();

    try {
      await this.hydrating;
    } finally {
      this.hydrating = null;
    }
  }

  /**
   * Learn about records written by OTHER processes sharing this keyspace.
   *
   * Redis is shared; the index is not. Each store holds a private
   * `MemoryIndex`, so without this a second instance's writes stay invisible
   * until the next full hydration — the cross-instance divergence that made
   * "workers can share a store" false.
   *
   * Cheap by construction: ids come from ONE global `om:seq` counter, so a
   * single GET reveals whether anything new exists. Only the delta is fetched;
   * an idle keyspace costs one round trip.
   *
   * Returns the number of records ingested.
   */
  async syncFromRedis(): Promise<number> {
    if (!this.hydrated) {
      await this.hydrate();
      return 0;
    }
    const client = await this.conn();

    const seqRaw = await client.get(this.kSeq());
    const high = Number(seqRaw) || 0;
    if (high <= this.maxIngestedId) return 0;

    const missing: number[] = [];
    for (let id = this.maxIngestedId + 1; id <= high; id++) {
      if (!this.index.has(id)) missing.push(id);
    }
    if (missing.length === 0) {
      this.maxIngestedId = high;
      return 0;
    }

    let ingested = 0;
    const BATCH = 500;
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const pipe = client.pipeline();
      for (const id of chunk) pipe.hgetall(this.kRec(id));
      const res = await pipe.exec();
      if (!res) continue;
      for (let j = 0; j < res.length; j++) {
        const tuple = res[j];
        const id = chunk[j];
        if (!tuple || id === undefined) continue;
        const [err, val] = tuple;
        if (err || !val) continue;
        const rec = val as Record<string, string>;
        // A gap in the id space is normal: allocateId burns an id when it
        // loses a SET NX race, and GC deletes records.
        if (!rec.content) continue;
        this.ingestIntoIndex(id, rec);
        ingested++;
      }
    }

    this.maxIngestedId = high;
    if (ingested > 0) {
      log.debug('Synced records written by another instance', { ingested, high });
    }
    return ingested;
  }

  /**
   * Start periodic cross-instance sync.
   *
   * Off by default. A single-process deployment needs nothing; enable it when
   * more than one process shares a keyspace. Timers are `unref`'d so a
   * background chore cannot hold the process open, and a pass that throws is
   * logged rather than propagated — an async throw in a timer is an unhandled
   * rejection.
   */
  startSync(intervalMs = 15_000): void {
    if (this.syncInterval) return;
    const ms = Math.max(1_000, intervalMs);
    this.syncInterval = setInterval(() => {
      if (this.syncing) return;
      this.syncing = true;
      void this.syncFromRedis()
        .catch((err) => {
          log.debug('Cross-instance sync failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.syncing = false;
        });
    }, ms);
    (this.syncInterval as { unref?: () => void }).unref?.();
    log.info('Cross-instance memory sync started', { intervalMs: ms });
  }

  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  /**
   * Drop an id the index believes in but Redis no longer has.
   *
   * The other half of divergence: `syncFromRedis` teaches this instance about
   * new records, but nothing taught it to FORGET ones another process (or GC)
   * deleted. Recall already discovers the miss when a fetch returns an empty
   * hash — it just used to skip the record and leave the index lying about
   * `indexSize` until the next hydration. Now the discovery is the repair.
   */
  private evictStale(id: number): void {
    if (!this.index.has(id)) return;
    this.index.remove(id);
    this.meta.delete(id);
    log.debug('Evicted a record that no longer exists in Redis', { id });
  }

  /** Add a fetched record to the derived in-process state. */
  private ingestIntoIndex(id: number, rec: Record<string, string>): void {
    if (id > this.maxIngestedId) this.maxIngestedId = id;
    this.index.add(id, rec.content ?? '');
    this.meta.set(id, {
      scope: rec.scope ?? '',
      context: rec.context ?? '',
      timestamp: rec.timestamp ?? '',
      tokens: Number(rec.tokens) || estimateTokens(rec.content ?? ''),
    });
  }

  // ── MemoryStore ─────────────────────────────────────────────────────────

  async retain(scope: string, writes: MemoryWrite[], _opts?: { async?: boolean }): Promise<RetainOutcome> {
    if (writes.length === 0) return { ok: true, count: 0 };
    this.emitActivity('retain', +1);
    try {
    await this.hydrate();
    const client = await this.conn();

    // Collapse duplicate documentIds WITHIN this batch, last write wins.
    // Without this, two writes sharing a documentId both allocate ids (the
    // om:docid pointer is only read once, before the loop) and the first
    // record is orphaned forever — reachable by neither documentId nor upsert.
    const effective: MemoryWrite[] = [];
    const slotByDocId = new Map<string, number>();
    for (const w of writes) {
      if (w.documentId) {
        const slot = slotByDocId.get(w.documentId);
        if (slot !== undefined) {
          effective[slot] = w;
          continue;
        }
        slotByDocId.set(w.documentId, effective.length);
      }
      effective.push(w);
    }

    // Resolve existing ids so a re-write upserts rather than duplicates.
    const existing = new Map<string, number>();
    const docIds = [...slotByDocId.keys()];
    if (docIds.length > 0) {
      const ids = await Promise.all(docIds.map((d) => client.get(this.kDocId(scope, d))));
      docIds.forEach((d, i) => {
        const v = ids[i];
        if (v) existing.set(d, Number(v));
      });
    }

    // MULTI, not pipeline. The upsert path issues DEL-then-HSET to replace a
    // record; through a plain pipeline those are merely batched, so a
    // connection that dies between them destroys the previous revision without
    // landing the new one — turning "stale fields survive" into "the record is
    // silently gone". MULTI makes the replacement indivisible.
    const pipe = client.multi();
    // Record where each write's commands sit so exec()'s per-command result
    // tuples can be mapped back explicitly. Deriving the offsets from a
    // command-count pattern would be fragile.
    const queued: Array<{ id: number; rec: Record<string, string>; first: number; count: number }> = [];
    let cursor = 0;

    for (const w of effective) {
      const id = await this.allocateId(client, scope, w, existing);

      const rec: Record<string, string> = {
        scope,
        content: w.content,
        context: w.context,
        timestamp: w.timestamp ?? new Date().toISOString(),
        tokens: String(estimateTokens(w.content)),
      };
      if (w.documentId) rec.documentId = w.documentId;
      if (w.tags?.length) rec.tags = JSON.stringify(w.tags);
      if (w.importance !== undefined) rec.importance = String(clamp01(w.importance));
      if (w.metadata) rec.metadata = JSON.stringify(w.metadata);

      const first = cursor;
      // HSET MERGES. When an id is being reused the old hash must be dropped
      // first, or optional fields (tags, importance, metadata) from earlier
      // revisions survive a revision that omits them, and the stored record
      // becomes a union of every version ever written.
      if (w.documentId) {
        pipe.del(this.kRec(id));
        cursor++;
      }
      pipe.hset(this.kRec(id), rec);
      cursor++;
      pipe.zadd(this.kScope(scope), id, String(id));
      cursor++;
      pipe.sadd(this.kScopes(), scope);
      cursor++;
      if (w.documentId) {
        // The om:docid pointer is established atomically in allocateId(), not
        // here — writing it in this batch would reintroduce the read-then-write
        // race it exists to close.
        //
        // Track the documentId in a per-scope set so deleteScope can reclaim
        // its pointer directly. Recovering documentIds by reading record
        // bodies instead would (a) insert an extra round trip into
        // deleteScope's read-then-delete window, widening the race with a
        // concurrent retain, and (b) miss any pointer whose record hash was
        // lost — leaving exactly the stale pointer that resurrects a deleted id.
        pipe.sadd(this.kScopeDocs(scope), w.documentId);
        cursor++;
      }

      queued.push({ id, rec, first, count: cursor - first });
    }

    const res = await pipe.exec();

    // `exec()` RESOLVING IS NOT AN ACKNOWLEDGEMENT. ioredis reports per-command
    // failures inside the result tuples and does not reject for them — an OOM
    // rejection under maxmemory+noeviction, a READONLY replica, or WRONGTYPE
    // all resolve normally. Ignoring the tuples reported ok:true for writes
    // that never landed AND polluted the index with records Redis does not
    // have, producing phantom recalls until the process restarts.
    if (res === null) {
      log.warn('Retain pipeline was discarded by Redis; nothing was written', {
        scope,
        writes: queued.length,
      });
      return { ok: false, count: 0 };
    }

    let stored = 0;
    for (const q of queued) {
      let commandsOk = true;
      for (let i = q.first; i < q.first + q.count; i++) {
        const tuple = res[i];
        if (!tuple || tuple[0]) {
          commandsOk = false;
          break;
        }
      }
      if (!commandsOk) continue;
      stored++;
      // Skip empty content so a hot store's index matches what hydrate() would
      // rebuild (hydrate skips contentless records).
      if (!q.rec.content) continue;
      this.ingestIntoIndex(q.id, q.rec);
    }

    if (stored !== queued.length) {
      log.warn('Retain partially failed', { scope, requested: queued.length, stored });
    }

    // Drives the scheduler's idle check, so GC never rescans a keyspace that
    // has not changed.
    this.writesSinceGc += stored;

    // Segment bookkeeping is advisory metadata for the Memory Map — never let
    // it fail the write that produced the records.
    await this.updateSegments(
      client,
      scope,
      queued.map((q) => ({ id: q.id, tokens: Number(q.rec.tokens) || 0 })),
    );

    this.emitActivity('retain', -1, stored === queued.length ? { count: stored } : { degraded: 'write_failed', count: stored });
    return { ok: stored === queued.length, count: stored };
    } catch (err) {
      this.emitActivity('retain', -1, { degraded: 'redis_unreachable' });
      throw err;
    }
  }

  /**
   * Resolve the id a write should land on.
   *
   * For a write with no documentId this is just the next counter value.
   *
   * With a documentId it must be an ATOMIC resolve-or-allocate. The previous
   * read-then-write (GET, then SET inside the write batch) let concurrent
   * retains of the same documentId all observe a missing pointer and each mint
   * their own id — producing N records where the caller asked for an idempotent
   * upsert, with all but one orphaned.
   *
   * `SET ... NX` performs the check and the set as one operation, so exactly
   * one caller wins. The losers read back the winner's id and write to the same
   * record, which is the intended last-write-wins upsert. The loser's INCR is
   * wasted, which is harmless — ids are an opaque counter, not a dense sequence.
   */
  private async allocateId(
    client: RedisLike,
    scope: string,
    w: MemoryWrite,
    existing: Map<string, number>,
  ): Promise<number> {
    if (!w.documentId) return client.incr(this.kSeq());

    const known = existing.get(w.documentId);
    if (known !== undefined) return known;

    const key = this.kDocId(scope, w.documentId);
    const candidate = await client.incr(this.kSeq());
    const won = await client.set(key, String(candidate), 'NX');
    if (won) return candidate;

    // Lost the race (or the pointer appeared between our GET and now).
    const actual = await client.get(key);
    return actual ? Number(actual) : candidate;
  }

  async retainOne(scope: string, content: string, context: string, tags?: string[]): Promise<RetainOutcome> {
    return this.retain(scope, [{ content, context, ...(tags ? { tags } : {}) }]);
  }

  /**
   * Scored recall.
   *
   * The index returns records already scored (§8.2), so nothing is rescored
   * here. Filtering by scope and expiry happens against in-process metadata,
   * so only the records that survive are fetched from Redis.
   */
  async recall(scope: string, query: string, opts?: RecallQuery): Promise<RecallOutcome> {
    this.emitActivity('recall', +1);
    try {
    await this.hydrate();

    const minRelevance = opts?.minRelevance ?? this.opts.minRelevance ?? DEFAULT_MIN_RELEVANCE;
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;

    const hits = this.index.search(query, minRelevance);
    if (hits.length === 0) return { records: [], lowConfidence: true, tokensUsed: 0 };

    // Scope + expiry filtering against metadata, before any Redis I/O.
    const eligible: Array<{ id: number; relevance: number; meta: RecordMeta }> = [];
    for (const h of hits) {
      const m = this.meta.get(h.id);
      if (!m) continue;
      if (m.scope !== scope) continue;
      if (m.timestamp && isMemoryExpired(m.context, m.timestamp)) continue;
      eligible.push({ id: h.id, relevance: h.relevance, meta: m });
    }
    if (eligible.length === 0) return { records: [], lowConfidence: true, tokensUsed: 0 };

    // Fill the token budget from the top of the ranking.
    const chosen: typeof eligible = [];
    let tokensUsed = 0;
    for (const e of eligible) {
      if (tokensUsed + e.meta.tokens > maxTokens) continue;
      chosen.push(e);
      tokensUsed += e.meta.tokens;
    }
    if (chosen.length === 0) return { records: [], lowConfidence: true, tokensUsed: 0 };

    const client = await this.conn();
    const pipe = client.pipeline();
    for (const c of chosen) pipe.hgetall(this.kRec(c.id));
    const res = await pipe.exec();

    const records: RecalledRecord[] = [];
    // Bill only for content actually delivered. The budget above is computed
    // from in-process metadata, but a record's hash can be gone by fetch time
    // (eviction, a partially-applied write, external deletion). Charging for
    // it would tell the caller it spent budget on content it never received,
    // and anything sizing a downstream prompt from tokensUsed would under-fill.
    let actualTokens = 0;
    if (res) {
      for (let i = 0; i < res.length; i++) {
        const tuple = res[i];
        const c = chosen[i];
        if (!tuple || !c) continue;
        const [err, val] = tuple;
        if (err) continue;
        const rec = (val ?? {}) as Record<string, string>;
        if (!rec.content) {
          // The index ranked a record Redis no longer holds — another process
          // or GC removed it. Repair the index here rather than skipping and
          // diverging further.
          this.evictStale(c.id);
          continue;
        }
        records.push({
          content: rec.content,
          context: rec.context ?? c.meta.context,
          timestamp: rec.timestamp ?? c.meta.timestamp,
          relevance: c.relevance,
          estimatedTokens: c.meta.tokens,
        });
        actualTokens += c.meta.tokens;
      }
    }

    // Mirrors the previous backend's semantics: a result set whose best match
    // is weak is flagged so the caller can hedge.
    const best = records.length > 0 ? Math.max(...records.map((r) => r.relevance)) : 0;
    this.emitActivity('recall', -1, { count: records.length });
    return { records, lowConfidence: best < 0.4, tokensUsed: actualTokens };
    } catch (err) {
      this.emitActivity('recall', -1, { degraded: 'redis_unreachable' });
      throw err;
    }
  }

  /**
   * Near-duplicate detection against a scope.
   *
   * The index's relevance score is a RANKING function, not a symmetric
   * similarity metric — it blends a keyword channel with a trigram channel and
   * applies a length penalty:
   *
   *   relevance = (keyword×0.6 + trigram×0.4) × (normLength < 20 ? 0.8 : 1)
   *
   * Comparing it against a similarity threshold was wrong in a way that
   * silently disabled dedup for short records: a BYTE-IDENTICAL duplicate has
   * keyword = trigram = 1, so its relevance ceilings at 0.80 once the length
   * penalty applies — permanently below the 0.85 default. Short preferences,
   * decisions and one-line lessons are exactly what the `core` scope holds, so
   * they accumulated without bound on every re-learn.
   *
   * The index is therefore used only as a CANDIDATE GENERATOR, and the verdict
   * comes from the same symmetric Jaccard the previous backend used
   * (`trigramSimilarity >= threshold`).
   */
  /**
   * Records in a scope whose seq falls within `[fromSeq, toSeq]`, in order.
   *
   * This is what backs `memory_read` (§11): search returns fragments, but what
   * an agent usually needs is the surrounding conversation. Ordering comes from
   * the scope ZSET, so interleaved writes to other scopes cannot pad the window.
   *
   * `limit` caps the result — the tool layer enforces a byte ceiling on top,
   * since an unbounded span read would let the agent pull an arbitrary fraction
   * of the session back into context and defeat the dynamic window entirely.
   */
  async range(
    scope: string,
    fromSeq: number,
    toSeq: number,
    limit = 200,
  ): Promise<Array<RecalledRecord & { seq: number }>> {
    await this.hydrate();
    const client = await this.conn();

    const lo = Math.min(fromSeq, toSeq);
    const hi = Math.max(fromSeq, toSeq);
    const ids = (await client.zrangebyscore(this.kScope(scope), lo, hi))
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .slice(0, Math.max(0, limit));
    if (ids.length === 0) return [];

    const pipe = client.pipeline();
    for (const id of ids) pipe.hgetall(this.kRec(id));
    const res = await pipe.exec();
    if (!res) return [];

    const out: Array<RecalledRecord & { seq: number }> = [];
    for (let i = 0; i < res.length; i++) {
      const tuple = res[i];
      const id = ids[i];
      if (!tuple || id === undefined) continue;
      const [err, val] = tuple;
      if (err || !val) continue;
      const rec = val as Record<string, string>;
      if (!rec.content) continue;
      out.push({
        seq: id,
        content: rec.content,
        context: rec.context ?? '',
        timestamp: rec.timestamp ?? '',
        // A range read is positional, not a search — there is no query to score
        // against, so relevance is not meaningful here.
        relevance: 1,
        estimatedTokens: Number(rec.tokens) || estimateTokens(rec.content),
      });
    }
    return out;
  }

  // ── Segments (Memory Map §9) ────────────────────────────────────────────

  /**
   * Fold newly-written records into the scope's open segment, closing it when
   * either threshold trips.
   *
   * Segment boundaries are assigned ONCE from a monotonic seq range and never
   * re-derived. That is deliberate: if boundaries shifted as the scope grew,
   * a segment id the agent saw two turns ago would silently point somewhere
   * else. Ids are opaque and stable; labels are display-only metadata that an
   * async titler may overwrite freely without breaking addressing.
   *
   * Best-effort — segments are advisory metadata, so a failure here must never
   * fail the write that produced the records.
   */
  private async updateSegments(
    client: RedisLike,
    scope: string,
    written: Array<{ id: number; tokens: number }>,
  ): Promise<void> {
    if (written.length === 0) return;
    try {
      const nRaw = await client.get(this.kSegN(scope));
      let n = nRaw ? Number(nRaw) : 0;
      if (!Number.isFinite(n) || n < 1) {
        n = 1;
        await client.set(this.kSegN(scope), '1');
      }

      const key = this.kSeg(scope, n);
      const cur = await client.hgetall(key);
      const isNew = !cur || !cur.from;

      const minSeq = Math.min(...written.map((w) => w.id));
      const maxSeq = Math.max(...written.map((w) => w.id));
      const addTokens = written.reduce((t, w) => t + w.tokens, 0);

      const from = isNew ? minSeq : Number(cur.from);
      const to = Math.max(isNew ? maxSeq : Number(cur.to), maxSeq);
      const count = (isNew ? 0 : Number(cur.count) || 0) + written.length;
      const tokens = (isNew ? 0 : Number(cur.tokens) || 0) + addTokens;

      const fields: Record<string, string> = {
        n: String(n),
        from: String(from),
        to: String(to),
        count: String(count),
        tokens: String(tokens),
        openedAt: isNew ? new Date().toISOString() : (cur.openedAt ?? new Date().toISOString()),
      };
      await client.hset(key, fields);

      if (count >= SEGMENT_MAX_RECORDS || tokens >= SEGMENT_MAX_TOKENS) {
        await this.closeSegment(client, scope, n, from, to);
      }
    } catch (err) {
      log.debug('Segment update failed (non-fatal)', {
        scope,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Seal a segment and compute its label.
   *
   * The label is derived from the segment's own records ranked by TF-IDF
   * against the index's current document frequencies, then FROZEN. Recomputing
   * it later would let one appended record silently relabel old history — and
   * the Memory Map's whole value is that what the agent saw last turn still
   * means the same thing this turn.
   */
  private async closeSegment(
    client: RedisLike,
    scope: string,
    n: number,
    from: number,
    to: number,
  ): Promise<void> {
    const records = await this.range(scope, from, to, SEGMENT_MAX_RECORDS);
    const counts = new Map<string, number>();
    for (const r of records) {
      for (const w of new Set(normalize(r.content).split(' '))) {
        if (w.length > 2) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }

    const ranked = rankTerms(
      counts,
      (term) => this.index.docFrequency(term),
      Math.max(1, this.index.size),
      SEGMENT_LABEL_TERMS,
    );
    const label = ranked.map((t) => t.term).join(', ') || '(no distinctive terms)';

    await client.hset(this.kSeg(scope, n), {
      closedAt: new Date().toISOString(),
      label,
    });
    await client.set(this.kSegN(scope), String(n + 1));
    log.debug('Segment closed', { scope, n, from, to, label });
  }

  /** All segments for a scope, oldest first. */
  async listSegments(scope: string): Promise<SegmentSummary[]> {
    const client = await this.conn();
    const nRaw = await client.get(this.kSegN(scope));
    const latest = nRaw ? Number(nRaw) : 0;
    if (!Number.isFinite(latest) || latest < 1) return [];

    const pipe = client.pipeline();
    for (let i = 1; i <= latest; i++) pipe.hgetall(this.kSeg(scope, i));
    const res = await pipe.exec();
    if (!res) return [];

    const out: SegmentSummary[] = [];
    for (let i = 0; i < res.length; i++) {
      const tuple = res[i];
      if (!tuple) continue;
      const [err, val] = tuple;
      if (err || !val) continue;
      const h = val as Record<string, string>;
      if (!h.from) continue;
      const n = i + 1;
      out.push({
        id: `seg:${scope}:${n}`,
        n,
        from: Number(h.from),
        to: Number(h.to),
        count: Number(h.count) || 0,
        label: h.label ?? '(open)',
        openedAt: h.openedAt ?? '',
        ...(h.closedAt ? { closedAt: h.closedAt } : {}),
      });
    }
    return out;
  }

  /**
   * The Memory Map block for a scope, or null when there is nothing to say.
   *
   * Deterministic and LLM-free: it reads stored segment metadata and renders
   * it. Injected on every turn, so it must stay cheap.
   */
  async buildMemoryMap(
    scope: string,
    opts?: MemoryMapOptions & { verbatim?: { from: number; to: number; count: number } | null },
  ): Promise<string | null> {
    await this.hydrate();
    const [bounds, segments, pins] = await Promise.all([
      this.bounds(scope),
      this.listSegments(scope),
      this.listPins(scope),
    ]);
    if (!bounds) return null;

    // Frequent terms come from the most recent segment's label material, which
    // is already ranked and frozen — no corpus re-scan on the turn path.
    const recent = segments[segments.length - 1];
    const frequentTerms = recent
      ? recent.label
          .split(', ')
          .filter((t) => t && t !== '(open)' && t !== '(no distinctive terms)')
          .map((term) => ({ term, count: this.index.docFrequency(term) }))
      : [];

    return renderMemoryMap(
      {
        scope,
        totalRecords: bounds.count,
        bounds: { min: bounds.min, max: bounds.max },
        segments,
        verbatim: opts?.verbatim ?? null,
        frequentTerms,
        pinnedCount: pins.length,
      },
      opts,
    );
  }

  /** The seq bounds of a scope, or null when it holds nothing. */
  async bounds(scope: string): Promise<{ min: number; max: number; count: number } | null> {
    const client = await this.conn();
    const count = await client.zcard(this.kScope(scope));
    if (count === 0) return null;
    const first = await client.zrange(this.kScope(scope), 0, 0);
    const last = await client.zrange(this.kScope(scope), -1, -1);
    const min = Number(first[0]);
    const max = Number(last[0]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min, max, count };
  }

  /**
   * Pin a durable fact. Pins are always loaded and exempt from TTL — the
   * deterministic, inspectable way to keep something in context, written by
   * the agent via `memory_pin` rather than synthesised by a model (§11).
   *
   * Keyed by `key` so a pin can be revised or removed by name rather than
   * accumulating near-duplicates.
   */
  async pin(scope: string, key: string, content: string): Promise<void> {
    const client = await this.conn();
    await client.hset(this.kPin(scope), { [key]: content });
  }

  async unpin(scope: string, key: string): Promise<void> {
    const client = await this.conn();
    const pipe = client.pipeline();
    pipe.hdel(this.kPin(scope), key);
    await pipe.exec();
  }

  /** All pins in a scope, in insertion order as Redis reports them. */
  async listPins(scope: string): Promise<Array<{ key: string; content: string }>> {
    const client = await this.conn();
    const all = await client.hgetall(this.kPin(scope));
    return Object.entries(all ?? {}).map(([key, content]) => ({ key, content }));
  }

  async isDuplicate(scope: string, content: string, threshold = 0.85): Promise<boolean> {
    await this.hydrate();

    // The floor is derived from the scorer's own constants rather than
    // hard-coded, so retuning the weights cannot silently make it unsound and
    // reintroduce the false negatives this replaced.
    const candidateFloor = trigramCandidateFloor(threshold);
    const hits = this.index.search(content, candidateFloor);
    if (hits.length === 0) return false;

    const inScope = hits.filter((h) => {
      const m = this.meta.get(h.id);
      if (!m || m.scope !== scope) return false;
      // An expired record must not block re-learning the same content.
      return !(m.timestamp && isMemoryExpired(m.context, m.timestamp));
    });
    if (inScope.length === 0) return false;

    // Bound the fetch AFTER scope filtering. The original defect was that the
    // limit was applied to the raw cross-scope hit list, so out-of-scope
    // records could crowd out an in-scope duplicate. Capping the already-
    // filtered, relevance-ordered list keeps dedup cost bounded on the write
    // path without reintroducing that false negative: index.search returns
    // hits sorted by descending relevance, so the most similar in-scope
    // candidates are the ones retained.
    const probe = inScope.slice(0, DUPLICATE_PROBE_LIMIT);

    const client = await this.conn();
    const pipe = client.pipeline();
    for (const h of probe) pipe.hgetall(this.kRec(h.id));
    const res = await pipe.exec();
    if (!res) return false;

    for (const tuple of res) {
      const [err, val] = tuple;
      if (err || !val) continue;
      const rec = val as Record<string, string>;
      if (rec.content && trigramSimilarity(content, rec.content) >= threshold) return true;
    }
    return false;
  }

  async listScopes(): Promise<ScopeInfo[]> {
    const client = await this.conn();
    const names = await client.smembers(this.kScopes());
    const out: ScopeInfo[] = [];
    for (const name of names) {
      out.push({ id: name, recordCount: await client.zcard(this.kScope(name)) });
    }
    return out;
  }

  async deleteScope(scope: string): Promise<void> {
    const client = await this.conn();

    // Enumerate BEFORE the script only so the in-process index can be pruned
    // to match. The delete itself does its own enumeration inside Lua.
    const ids = await client.zrange(this.kScope(scope), 0, -1);

    // ATOMIC. The previous MULTI version read the membership, then deleted it
    // in a second round trip — a record written in that window was dropped
    // from the scope set while its om:rec hash survived, leaving an orphan
    // that hydrate() (which walks scope sets) could never see. Redis runs a
    // script with no interleaving, so the window does not exist.
    //
    // documentIds come from the per-scope set, not from reading record bodies:
    // a leaked om:docid pointer lets a later retain RESURRECT a deleted id,
    // and reading pointers out of hashes misses exactly the ones whose hash
    // was already lost.
    await client.eval(DELETE_SCOPE_LUA, 0, this.prefix, scope);

    for (const id of ids) {
      const n = Number(id);
      this.index.remove(n);
      this.meta.delete(n);
    }

    log.info('Scope deleted', { scope, records: ids.length });
  }

  /**
   * Physically reclaim records that recall can no longer reach.
   *
   * TTL is ADVISORY at read time (§15) — `recall()` and `isDuplicate()` filter
   * expired records but nothing deleted them, so they occupied Redis, the
   * index and `meta` forever. That became load-bearing once dedup started
   * honouring expiry too: an expired record is invisible to both read paths, so
   * re-learning the same content accreted dead records nothing would reclaim.
   *
   * Two classes are collected:
   *
   *   EXPIRED  — `isMemoryExpired(context, timestamp)` says so. That predicate
   *              already implements pinned-beats-TTL and treats a TTL of 0 as
   *              "never expires", so this must NOT be reimplemented as a Redis
   *              EXPIRE (which would read 0 as "expire immediately" and destroy
   *              every decision, preference, architecture and lesson record).
   *
   *   ORPHANED — an `om:rec:{id}` hash referenced by no scope set. This is what
   *              a retain interleaved with `deleteScope` leaves behind: the id
   *              is dropped from the scope set while its hash survives,
   *              invisible to `hydrate()` (which walks scope sets) and
   *              unreachable by any query. GC is what makes that race a
   *              recoverable leak rather than a permanent one.
   *
   * Safe to run against a live store — it mutates the derived index and meta in
   * step with Redis.
   */
  async collectGarbage(opts?: { dryRun?: boolean }): Promise<GcReport> {
    await this.hydrate();
    const client = await this.conn();
    const dryRun = opts?.dryRun ?? false;

    // Which ids are still referenced, and by which scope.
    const scopeById = new Map<number, string>();
    for (const scope of await client.smembers(this.kScopes())) {
      for (const raw of await client.zrange(this.kScope(scope), 0, -1)) {
        scopeById.set(Number(raw), scope);
      }
    }

    const doomed: Array<{ id: number; scope?: string; documentId?: string; reason: 'expired' | 'orphaned' }> = [];
    let scanned = 0;

    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${this.prefix}rec:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length === 0) continue;

      const pipe = client.pipeline();
      for (const k of keys) pipe.hgetall(k);
      const res = await pipe.exec();
      if (!res) continue;

      for (let i = 0; i < res.length; i++) {
        const tuple = res[i];
        const key = keys[i];
        if (!tuple || !key) continue;
        const [err, val] = tuple;
        if (err || !val) continue;

        scanned++;
        const rec = val as Record<string, string>;
        const id = Number(key.slice(`${this.prefix}rec:`.length));
        if (!Number.isFinite(id)) continue;

        const scope = scopeById.get(id);
        if (scope === undefined) {
          doomed.push({ id, documentId: rec.documentId, reason: 'orphaned' });
          continue;
        }
        if (rec.timestamp && isMemoryExpired(rec.context ?? '', rec.timestamp)) {
          doomed.push({ id, scope, documentId: rec.documentId, reason: 'expired' });
        }
      }
    } while (cursor !== '0');

    const expired = doomed.filter((d) => d.reason === 'expired').length;
    const orphaned = doomed.filter((d) => d.reason === 'orphaned').length;

    if (dryRun || doomed.length === 0) {
      log.info('Memory GC complete', { scanned, expired, orphaned, deleted: 0, dryRun });
      return { scanned, expired, orphaned, deleted: 0, dryRun };
    }

    const pipe = client.multi();
    for (const d of doomed) {
      pipe.del(this.kRec(d.id));
      if (d.scope) {
        pipe.zrem(this.kScope(d.scope), String(d.id));
        if (d.documentId) {
          pipe.del(this.kDocId(d.scope, d.documentId));
          pipe.srem(this.kScopeDocs(d.scope), d.documentId);
        }
      }
    }
    await pipe.exec();

    for (const d of doomed) {
      this.index.remove(d.id);
      this.meta.delete(d.id);
    }

    log.info('Memory GC complete', { scanned, expired, orphaned, deleted: doomed.length, dryRun });
    return { scanned, expired, orphaned, deleted: doomed.length, dryRun };
  }

  /** Last completed GC pass, for diagnostics and the recall-health surface. */
  get lastGcReport(): { at: string; report: GcReport } | null {
    return this.lastGc;
  }

  /**
   * Start the background GC loop.
   *
   * Without this, {@link collectGarbage} is a method nobody calls and expired
   * records accumulate forever — the read-time TTL filter hides them, so the
   * growth is invisible until Redis runs out of memory.
   *
   * Follows the same conventions as the other periodic maintenance task in the
   * codebase: the timers are `unref`'d so a background chore never keeps the
   * process alive, a second `start` is a no-op until {@link stopGc}, and a pass
   * that throws is logged rather than propagated (an unhandled rejection in a
   * timer would take the process down).
   *
   * Passes never overlap, and an idle keyspace is not rescanned.
   */
  startGc(opts: GcScheduleOptions = {}): void {
    if (this.gcTimer || this.gcInterval) return;

    const intervalMs = Math.max(60_000, opts.intervalMs ?? 6 * 60 * 60 * 1000);
    const initialDelayMs = Math.max(0, opts.initialDelayMs ?? 5 * 60 * 1000);
    const minWrites = Math.max(0, opts.minWritesBetweenRuns ?? 1);

    const pass = () => {
      void this.runScheduledGc(minWrites);
    };

    this.gcTimer = setTimeout(() => {
      this.gcTimer = null;
      pass();
      this.gcInterval = setInterval(pass, intervalMs);
      (this.gcInterval as { unref?: () => void }).unref?.();
    }, initialDelayMs);
    (this.gcTimer as { unref?: () => void }).unref?.();

    log.info('Memory GC scheduled', { intervalMs, initialDelayMs, minWrites });
  }

  /** Stop the background GC loop. Safe to call when not started. */
  stopGc(): void {
    if (this.gcTimer) {
      clearTimeout(this.gcTimer);
      this.gcTimer = null;
    }
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  /** One scheduled pass: skip if idle or already running; never throw. */
  private async runScheduledGc(minWrites: number): Promise<void> {
    if (this.gcRunning) {
      log.debug('Memory GC still running — skipping this pass');
      return;
    }
    if (this.writesSinceGc < minWrites) {
      log.debug('Memory GC skipped — no writes since last pass', {
        writesSinceGc: this.writesSinceGc,
      });
      return;
    }

    this.gcRunning = true;
    const writesAtStart = this.writesSinceGc;
    try {
      const report = await this.collectGarbage();
      // Subtract rather than zero, so writes that landed DURING the pass still
      // count toward the next one instead of being silently swallowed.
      this.writesSinceGc = Math.max(0, this.writesSinceGc - writesAtStart);
      this.lastGc = { at: new Date().toISOString(), report };
    } catch (err) {
      log.warn('Scheduled memory GC failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.gcRunning = false;
    }
  }

  async health(): Promise<{ healthy: boolean }> {
    try {
      const client = await this.conn();
      const pong = await client.ping();
      return { healthy: pong === 'PONG' };
    } catch (err) {
      log.debug('Redis health probe failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { healthy: false };
    }
  }

  /**
   * Release the connection. Safe to call more than once.
   *
   * An INJECTED client (tests) is left in place: nulling it would make the
   * next call fall through to `conn()` and open a real connection to
   * localhost, so a test that closed its fake store would start writing to a
   * live Redis.
   */
  async close(): Promise<void> {
    this.stopGc();
    this.stopSync();
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      /* already gone */
    }
    if (!this.injectedClient) this.client = null;
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
