/**
 * @module memory/memory-telemetry
 * Lightweight in-process telemetry for the Hindsight memory subsystem.
 *
 * Tracks recall effectiveness, retain success rates, and error counts so
 * operators can detect degradation without instrumenting every call site.
 *
 * F13: Recall effectiveness metric — emits per-bank hit/miss ratios.
 */

import { createLogger } from '../logging/logger.js';

const log = createLogger('memory-telemetry');

// ── Types ──────────────────────────────────────────────────────────────────

/** Raw counters for one bank. */
export interface BankCounters {
  recallTotal: number;
  recallHit: number;      // recall returned ≥1 result
  recallMiss: number;     // recall returned 0 results
  recallFiltered: number; // API had results but all dropped by threshold
  retainTotal: number;
  retainSuccess: number;
  retainFailure: number;
  errorTotal: number;
  errorTransient: number;
  errorPermanent: number;
}

/** Snapshot used for monitoring hooks and log output. */
export interface TelemetrySnapshot {
  ts: string;
  banks: Record<string, BankCounters>;
  /** Overall recall effectiveness (0–1). Null if no recalls recorded. */
  recallEffectiveness: number | null;
  /** Total memory operations since process start. */
  totalOps: number;
}

/** Monitoring hook invoked after each operation with a lightweight metric. */
export type TelemetryEvent =
  | { type: 'recall'; bank: string; hit: boolean; filtered: boolean; resultCount: number; durationMs: number }
  | { type: 'retain'; bank: string; success: boolean; itemCount: number; durationMs: number }
  | { type: 'error'; bank: string; op: 'recall' | 'retain'; transient: boolean; message: string };

// ── Internal state ─────────────────────────────────────────────────────────

const banks = new Map<string, BankCounters>();

function getOrCreate(bankId: string): BankCounters {
  let c = banks.get(bankId);
  if (!c) {
    c = {
      recallTotal: 0, recallHit: 0, recallMiss: 0, recallFiltered: 0,
      retainTotal: 0, retainSuccess: 0, retainFailure: 0,
      errorTotal: 0, errorTransient: 0, errorPermanent: 0,
    };
    banks.set(bankId, c);
  }
  return c;
}

// ── Monitoring hook ────────────────────────────────────────────────────────

/** Optional external monitoring hook — set once at startup. */
let monitoringHook: ((event: TelemetryEvent) => void) | null = null;

/**
 * Register a monitoring hook for real-time telemetry events.
 * Called synchronously after each operation — keep it fast.
 *
 * @example
 * ```ts
 * setMonitoringHook((event) => {
 *   if (event.type === 'recall' && !event.hit) {
 *     myAlertManager.increment('memory.recall.miss');
 *   }
 * });
 * ```
 */
export function setMonitoringHook(hook: (event: TelemetryEvent) => void): void {
  monitoringHook = hook;
}

function emit(event: TelemetryEvent): void {
  try {
    monitoringHook?.(event);
  } catch (err) {
    // Never let a monitoring hook crash the memory pipeline
    log.debug('Monitoring hook threw', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Recording API ──────────────────────────────────────────────────────────

/**
 * Record a completed recall operation.
 *
 * @param bankId - Bank that was queried.
 * @param resultCount - Number of results returned after filtering.
 * @param totalFromApi - Raw count returned by the API before client filtering.
 * @param durationMs - Round-trip duration in milliseconds.
 */
export function recordRecall(
  bankId: string,
  resultCount: number,
  totalFromApi: number,
  durationMs: number,
): void {
  const c = getOrCreate(bankId);
  c.recallTotal++;

  const hit = resultCount > 0;
  const filtered = totalFromApi > 0 && resultCount === 0;

  if (hit) c.recallHit++;
  else c.recallMiss++;
  if (filtered) c.recallFiltered++;

  emit({ type: 'recall', bank: bankId, hit, filtered, resultCount, durationMs });

  // Periodically log effectiveness summary at info level (every 50 recalls)
  if (c.recallTotal % 50 === 0) {
    const effectiveness = c.recallTotal > 0 ? (c.recallHit / c.recallTotal) : null;
    log.info('Memory recall effectiveness checkpoint', {
      bankId,
      total: c.recallTotal,
      hits: c.recallHit,
      misses: c.recallMiss,
      filtered: c.recallFiltered,
      effectiveness: effectiveness !== null ? effectiveness.toFixed(3) : 'n/a',
    });
  }
}

/**
 * Record a completed retain operation.
 *
 * @param bankId - Target bank.
 * @param success - Whether the retain succeeded.
 * @param itemCount - Number of items in the batch.
 * @param durationMs - Operation duration in milliseconds.
 */
export function recordRetain(
  bankId: string,
  success: boolean,
  itemCount: number,
  durationMs: number,
): void {
  const c = getOrCreate(bankId);
  c.retainTotal++;
  if (success) c.retainSuccess++;
  else c.retainFailure++;

  emit({ type: 'retain', bank: bankId, success, itemCount, durationMs });
}

/**
 * Record a memory subsystem error.
 *
 * @param bankId - Associated bank (or 'unknown').
 * @param op - Operation type.
 * @param transient - Whether this is a transient (retryable) error.
 * @param message - Error message.
 */
export function recordError(
  bankId: string,
  op: 'recall' | 'retain',
  transient: boolean,
  message: string,
): void {
  const c = getOrCreate(bankId);
  c.errorTotal++;
  if (transient) c.errorTransient++;
  else c.errorPermanent++;

  emit({ type: 'error', bank: bankId, op, transient, message });
}

// ── Query API ──────────────────────────────────────────────────────────────

/**
 * F13: Overall recall effectiveness across all banks.
 * Returns null if no recalls have been recorded yet.
 */
export function getRecallEffectiveness(): number | null {
  let total = 0;
  let hits = 0;
  for (const c of banks.values()) {
    total += c.recallTotal;
    hits += c.recallHit;
  }
  return total > 0 ? hits / total : null;
}

/** Per-bank recall effectiveness. Returns null for banks with no recalls. */
export function getBankEffectiveness(bankId: string): number | null {
  const c = banks.get(bankId);
  if (!c || c.recallTotal === 0) return null;
  return c.recallHit / c.recallTotal;
}

/** Full telemetry snapshot (useful for health endpoints or debug dumps). */
export function getSnapshot(): TelemetrySnapshot {
  const bankSnapshot: Record<string, BankCounters> = {};
  let totalOps = 0;
  for (const [id, c] of banks.entries()) {
    bankSnapshot[id] = { ...c };
    totalOps += c.recallTotal + c.retainTotal;
  }
  return {
    ts: new Date().toISOString(),
    banks: bankSnapshot,
    recallEffectiveness: getRecallEffectiveness(),
    totalOps,
  };
}

/**
 * Emit a structured telemetry summary log.
 * Call this at session end or on a periodic timer for monitoring visibility.
 */
export function logTelemetrySummary(): void {
  const snap = getSnapshot();
  if (snap.totalOps === 0) return;

  log.info('Memory telemetry summary', {
    banks: Object.fromEntries(
      Object.entries(snap.banks).map(([id, c]) => [
        id,
        {
          recall: `${c.recallHit}/${c.recallTotal} hits (${c.recallFiltered} filtered)`,
          retain: `${c.retainSuccess}/${c.retainTotal} ok`,
          errors: c.errorTotal,
        },
      ]),
    ),
    overallEffectiveness: snap.recallEffectiveness !== null
      ? (snap.recallEffectiveness * 100).toFixed(1) + '%'
      : 'n/a',
  });
}

/** Reset all counters (useful for tests). */
export function resetTelemetry(): void {
  banks.clear();
}
