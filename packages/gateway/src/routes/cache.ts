/**
 * @module routes/cache
 * Lightweight TTL cache for REST endpoint responses.
 *
 * Entries are stored in a plain Map and lazily evicted on read.
 * Two TTLs are exposed:
 *   STATE_TTL_MS  — used for the full-state endpoint (longer, heavier payload)
 *   ACTIVITY_TTL_MS — used for the since-timestamp activity endpoint (shorter)
 */

export const STATE_TTL_MS = 2_000;
export const ACTIVITY_TTL_MS = 1_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  /**
   * Return a cached value if it exists and has not expired.
   * Expired entries are evicted on access.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a value under `key` for `ttlMs` milliseconds. */
  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Remove a specific key immediately. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Evict all expired entries. Call periodically if the cache is long-lived. */
  purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }
}
