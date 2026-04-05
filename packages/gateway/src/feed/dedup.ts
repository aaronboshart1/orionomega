/**
 * @module feed/dedup
 * In-process message deduplication.
 *
 * Tracks recently-seen message IDs with a TTL to prevent duplicate inserts
 * from retrying clients or concurrent WebSocket + REST submissions.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 10_000;

interface DedupEntry {
  messageId: string;
  expiresAt: number;
}

export class DedupStore {
  private seen: Map<string, DedupEntry> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {
    // Purge expired entries every 10 minutes
    this.cleanupTimer = setInterval(() => this.purge(), 10 * 60 * 1000);
    this.cleanupTimer.unref(); // Don't prevent process exit
  }

  /**
   * Check if a messageId has been seen before.
   * If not seen, marks it as seen and returns false.
   * If already seen, returns true (duplicate).
   */
  checkAndMark(messageId: string): boolean {
    this.evictIfNeeded();
    const existing = this.seen.get(messageId);
    if (existing && Date.now() < existing.expiresAt) {
      return true; // duplicate
    }
    this.seen.set(messageId, {
      messageId,
      expiresAt: Date.now() + this.ttlMs,
    });
    return false; // new
  }

  /**
   * Check if a messageId has been seen (read-only).
   */
  has(messageId: string): boolean {
    const entry = this.seen.get(messageId);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.seen.delete(messageId);
      return false;
    }
    return true;
  }

  /** Remove all expired entries. */
  purge(): void {
    const now = Date.now();
    for (const [key, entry] of this.seen) {
      if (now >= entry.expiresAt) this.seen.delete(key);
    }
  }

  /** Evict oldest entries if over capacity. */
  private evictIfNeeded(): void {
    if (this.seen.size >= MAX_ENTRIES) {
      // Delete the oldest 20% of entries
      const toDelete = Math.floor(MAX_ENTRIES * 0.2);
      const iter = this.seen.keys();
      for (let i = 0; i < toDelete; i++) {
        const next = iter.next();
        if (next.done) break;
        this.seen.delete(next.value);
      }
    }
  }

  /** Stop the cleanup timer. Call during shutdown. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
