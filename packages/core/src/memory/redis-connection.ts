/**
 * @module memory/redis-connection
 * Shared ioredis connection factory.
 *
 * `ioredis` is an OPTIONAL dependency (see packages/core/package.json). It is
 * loaded through a variable module specifier so TypeScript does not statically
 * resolve a package that may not be installed — the same indirection
 * `redis-queue.ts` uses for `bullmq`. Do not convert this to a static import.
 *
 * Per docs/memory-architecture-v2.md §15 this is intended to be the single
 * place connection options are configured, so connection count stays bounded
 * and auth/TLS is not re-implemented per subsystem.
 *
 * NOTE: `RedisTaskQueue` does not consume this yet — it still builds its own
 * `{ url }` connection inline. Migrating it is deliberate follow-up work, kept
 * out of the memory change so a queue regression cannot be blamed on it.
 */

import { createLogger } from '../logging/logger.js';

const log = createLogger('redis-connection');

/** Connection settings for the memory store. Mirrors `orchestration.queue`. */
export interface RedisConnectionConfig {
  /** e.g. `redis://localhost:6379`. Falls back to `REDIS_URL`. */
  url?: string;
  username?: string;
  password?: string;
  /** Logical DB index. Keep memory separate from BullMQ's keyspace. */
  db?: number;
  /** Prefix applied to every key. Default `om:`. */
  keyPrefix?: string;
  /** Enable TLS (rediss:// also works via the URL). */
  tls?: boolean;
}

/**
 * The subset of the ioredis surface the memory store uses.
 *
 * Declared structurally so the package need not be installed to typecheck.
 */
export interface RedisLike {
  hset(key: string, values: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  get(key: string): Promise<string | null>;
  /**
   * `mode: 'NX'` sets only when the key is absent, returning 'OK' on success
   * and null when it already existed. That check-and-set is atomic in Redis,
   * which is what makes concurrent documentId allocation converge on one id.
   */
  set(key: string, value: string, mode?: 'NX'): Promise<string | null>;
  /** Cursor-based key iteration. Returns [nextCursor, keys]. */
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
  /**
   * Sorted-set membership, scored by record `seq`.
   *
   * Scope membership is a ZSET rather than a SET because Phase 4 needs ORDER:
   * `memory_read({around, radius})` is a score range, and a Memory Map segment
   * is a `[from, to]` seq window. A plain SET can answer neither without
   * pulling every id and sorting in process.
   */
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  /** Members in score order. Use '-inf'/'+inf' for open ranges. */
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  /** Score of a member, or null when absent. */
  zscore(key: string, member: string): Promise<string | null>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  /**
   * Run a Lua script server-side.
   *
   * Redis executes a script ATOMICALLY — no other client's commands interleave
   * with it. That is stronger than MULTI for read-then-write sequences, because
   * the script can branch on what it read. `deleteScope` needs exactly that:
   * it must enumerate a scope's members and delete them with no window in
   * which a concurrent retain could slip a record in and be orphaned.
   *
   * NOTE: the scripts here compute their own keys from a prefix rather than
   * declaring them in KEYS[]. That is safe on a single instance — which §15
   * specifies — but would need reworking for Redis Cluster, where every key a
   * script touches must hash to the same slot.
   */
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** Batched, NOT atomic — commands may interleave with other clients'. */
  pipeline(): RedisPipeline;
  /**
   * MULTI/EXEC. Same chainable shape as {@link pipeline}, but the server
   * executes the queued commands as one unit with no interleaving.
   *
   * Note Redis does NOT roll back on per-command errors, so `exec()` results
   * must still be inspected. What MULTI buys is isolation: a multi-command
   * mutation (e.g. DEL-then-HSET to replace a record) cannot be observed
   * half-applied, and cannot be left half-applied by a connection that dies
   * between the two commands.
   */
  multi(): RedisPipeline;
  config(op: 'GET', param: string): Promise<string[]>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

/** Chainable pipeline; only the commands the store issues are declared. */
export interface RedisPipeline {
  hset(key: string, values: Record<string, string>): RedisPipeline;
  hgetall(key: string): RedisPipeline;
  set(key: string, value: string): RedisPipeline;
  del(...keys: string[]): RedisPipeline;
  sadd(key: string, ...members: string[]): RedisPipeline;
  srem(key: string, ...members: string[]): RedisPipeline;
  zadd(key: string, score: number, member: string): RedisPipeline;
  zrem(key: string, ...members: string[]): RedisPipeline;
  hdel(key: string, ...fields: string[]): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/** Hide credentials in a Redis URL before logging. Mirrors queue/index.ts. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return '[redacted]';
  }
}

/** Resolve the effective URL: explicit config, then `REDIS_URL`, then localhost. */
export function resolveRedisUrl(cfg?: RedisConnectionConfig): string {
  return cfg?.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
}

/**
 * Create a connected ioredis client.
 *
 * Throws a actionable error when `ioredis` is absent rather than a bare
 * MODULE_NOT_FOUND, because the package is optional and its absence is a
 * configuration mistake rather than a bug.
 */
export async function createRedisConnection(cfg?: RedisConnectionConfig): Promise<RedisLike> {
  const url = resolveRedisUrl(cfg);

  let Redis: new (url: string, opts?: Record<string, unknown>) => RedisLike;
  try {
    // Variable specifier — see the module docstring.
    const moduleName = 'ioredis';
    const mod = (await import(moduleName)) as unknown as {
      default?: new (url: string, opts?: Record<string, unknown>) => RedisLike;
    };
    const ctor = mod.default ?? (mod as unknown as new (url: string, opts?: Record<string, unknown>) => RedisLike);
    Redis = ctor;
  } catch (err) {
    throw new Error(
      `Redis memory backend selected but the 'ioredis' package is not installed. ` +
        `Install it (and ensure Redis is reachable at ${redactUrl(url)}), or set ` +
        `memory.backend to a non-Redis value. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const opts: Record<string, unknown> = {
    // Fail fast rather than queueing commands forever behind a dead socket —
    // the store surfaces this as `degraded`, which is only useful if it is
    // observed promptly (§13).
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  };
  if (cfg?.username) opts.username = cfg.username;
  if (cfg?.password) opts.password = cfg.password;
  if (cfg?.db !== undefined) opts.db = cfg.db;
  if (cfg?.tls) opts.tls = {};

  const client = new Redis(url, opts);
  client.on('error', (err: unknown) => {
    log.debug('Redis connection error', {
      url: redactUrl(url),
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info('Redis memory connection created', {
    url: redactUrl(url),
    db: cfg?.db ?? 0,
    keyPrefix: cfg?.keyPrefix ?? 'om:',
  });

  return client;
}

/**
 * Warn when `maxmemory-policy` is not `noeviction`.
 *
 * BullMQ silently loses jobs under any eviction policy, and the policy is
 * INSTANCE-WIDE — selecting a different DB index does not isolate it
 * (docs/memory-architecture-v2.md §15). The memory store bounds its own size
 * rather than relying on eviction, so `noeviction` is the correct setting for a
 * shared instance.
 */
export async function probeEvictionPolicy(client: RedisLike): Promise<string | null> {
  try {
    const res = await client.config('GET', 'maxmemory-policy');
    const policy = Array.isArray(res) ? res[1] : undefined;
    if (!policy) return null;
    if (policy !== 'noeviction') {
      log.warn(
        `Redis maxmemory-policy is '${policy}', not 'noeviction'. ` +
          `This is instance-wide: if the BullMQ task queue shares this instance it can ` +
          `silently lose jobs, and memory records may be evicted out from under the index. ` +
          `Set 'maxmemory-policy noeviction', or point memory.redis.url at a separate instance.`,
      );
    }
    return policy;
  } catch {
    // CONFIG GET is disabled on many managed/hardened Redis deployments.
    // Not being able to check is not an error.
    return null;
  }
}
