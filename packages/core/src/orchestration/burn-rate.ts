/**
 * @module orchestration/burn-rate
 * Live budget burn-rate computation (Task #245).
 *
 * Turns a stream of cumulative-cost readings into a time-series view: an
 * instantaneous spend-over-time series plus a sliding-window burn rate ($/hr).
 * When a session budget cap is configured, it also reports how close the run is
 * to the cap and a rough projection of when the cap will be hit at the current
 * rate.
 *
 * Everything here is pure and side-effect-free so it can be unit-tested without
 * a running gateway. The gateway feeds it cumulative cost readings as they
 * arrive; the web UI renders the resulting snapshot.
 */

/** A single cumulative-cost reading at a point in time. */
export interface CostSample {
  /** Epoch milliseconds when the reading was taken. */
  t: number;
  /** Cumulative session cost in USD at time {@link t}. Monotonically non-decreasing. */
  cumulativeUsd: number;
}

/** A downsampled point in the spend-over-time series. */
export interface SpendPoint {
  /** Epoch milliseconds. */
  t: number;
  /** Cumulative cost in USD at this point. */
  cumulativeUsd: number;
  /**
   * Instantaneous burn rate ($/hr) over the interval ending at this point
   * (relative to the previous retained point). 0 for the first point.
   */
  usdPerHour: number;
}

/** A complete burn-rate view derived from a set of cost samples. */
export interface BurnRateSnapshot {
  /** Sliding-window burn rate ($/hr). 0 when there is insufficient data. */
  burnRateUsdPerHour: number;
  /** Cumulative cost (USD) at the most recent sample. */
  totalUsd: number;
  /** Down-sampled spend-over-time series (oldest → newest). */
  spendSeries: SpendPoint[];
  /** Configured session budget cap (USD), when present. */
  capUsd?: number;
  /** Fraction of the cap consumed (0..1+). Present only when {@link capUsd} is set. */
  fractionOfCap?: number;
  /**
   * Projected milliseconds until the cap is hit at the current burn rate.
   * `0` when already at/over cap, `null` when not approaching (rate ≤ 0 or no cap).
   */
  msToCapExhaustion?: number | null;
  /** True when {@link fractionOfCap} ≥ the near-cap threshold. */
  approachingCap: boolean;
  /** True when cumulative cost has reached/exceeded the cap. */
  overCap: boolean;
}

const MS_PER_HOUR = 3_600_000;

/** Default sliding window for the headline burn rate. */
export const DEFAULT_BURN_WINDOW_MS = 5 * 60_000;
/** Default fraction of cap at which we flag "approaching". */
export const DEFAULT_NEAR_CAP_THRESHOLD = 0.8;
/** Default maximum points retained in the spend series sent to the UI. */
export const DEFAULT_MAX_SERIES_POINTS = 60;

/**
 * Compute the burn rate ($/hr) over a sliding window ending at `nowMs`.
 *
 * Uses the earliest sample at or after `nowMs - windowMs` as the window anchor
 * and the latest sample as the end. Returns 0 when fewer than two distinct
 * readings fall in the window or no time has elapsed.
 */
export function computeBurnRate(
  samples: CostSample[],
  opts: { windowMs?: number; nowMs?: number } = {},
): number {
  if (samples.length < 2) return 0;
  const windowMs = opts.windowMs ?? DEFAULT_BURN_WINDOW_MS;
  const last = samples[samples.length - 1];
  const nowMs = opts.nowMs ?? last.t;
  const windowStart = nowMs - windowMs;

  // Anchor: the latest sample at or before windowStart (so the window covers a
  // full `windowMs` of spend) — fall back to the first sample if none precede.
  let anchor = samples[0];
  for (const s of samples) {
    if (s.t <= windowStart) anchor = s;
    else break;
  }

  const elapsedMs = last.t - anchor.t;
  if (elapsedMs <= 0) return 0;
  const spend = last.cumulativeUsd - anchor.cumulativeUsd;
  if (spend <= 0) return 0;
  return (spend / elapsedMs) * MS_PER_HOUR;
}

/**
 * Build a downsampled spend-over-time series with per-interval instantaneous
 * burn rates. Evenly strides the samples so at most `maxPoints` are returned
 * (the most recent sample is always retained).
 */
export function buildSpendSeries(
  samples: CostSample[],
  maxPoints = DEFAULT_MAX_SERIES_POINTS,
): SpendPoint[] {
  if (samples.length === 0) return [];
  const limit = Math.max(2, maxPoints);

  let retained: CostSample[];
  if (samples.length <= limit) {
    retained = samples;
  } else {
    retained = [];
    const stride = (samples.length - 1) / (limit - 1);
    for (let i = 0; i < limit; i++) {
      retained.push(samples[Math.round(i * stride)]);
    }
    // Guarantee the final sample is the true latest reading.
    retained[retained.length - 1] = samples[samples.length - 1];
  }

  const series: SpendPoint[] = [];
  for (let i = 0; i < retained.length; i++) {
    const cur = retained[i];
    let usdPerHour = 0;
    if (i > 0) {
      const prev = retained[i - 1];
      const dt = cur.t - prev.t;
      const dUsd = cur.cumulativeUsd - prev.cumulativeUsd;
      if (dt > 0 && dUsd > 0) usdPerHour = (dUsd / dt) * MS_PER_HOUR;
    }
    series.push({ t: cur.t, cumulativeUsd: cur.cumulativeUsd, usdPerHour });
  }
  return series;
}

/**
 * Derive a full {@link BurnRateSnapshot} from raw cost samples.
 */
export function summarizeBurnRate(
  samples: CostSample[],
  opts: {
    capUsd?: number;
    windowMs?: number;
    nowMs?: number;
    maxPoints?: number;
    nearCapThreshold?: number;
  } = {},
): BurnRateSnapshot {
  const totalUsd = samples.length > 0 ? samples[samples.length - 1].cumulativeUsd : 0;
  const burnRateUsdPerHour = computeBurnRate(samples, { windowMs: opts.windowMs, nowMs: opts.nowMs });
  const spendSeries = buildSpendSeries(samples, opts.maxPoints);

  const snapshot: BurnRateSnapshot = {
    burnRateUsdPerHour,
    totalUsd,
    spendSeries,
    approachingCap: false,
    overCap: false,
  };

  const cap = opts.capUsd;
  if (cap !== undefined && cap > 0) {
    const nearThreshold = opts.nearCapThreshold ?? DEFAULT_NEAR_CAP_THRESHOLD;
    const fractionOfCap = totalUsd / cap;
    const remaining = cap - totalUsd;
    snapshot.capUsd = cap;
    snapshot.fractionOfCap = fractionOfCap;
    snapshot.overCap = remaining <= 0;
    snapshot.approachingCap = fractionOfCap >= nearThreshold;
    if (snapshot.overCap) {
      snapshot.msToCapExhaustion = 0;
    } else if (burnRateUsdPerHour > 0) {
      snapshot.msToCapExhaustion = (remaining / burnRateUsdPerHour) * MS_PER_HOUR;
    } else {
      snapshot.msToCapExhaustion = null;
    }
  }

  return snapshot;
}

/**
 * Stateful, bounded accumulator of cost samples for a single session.
 *
 * The gateway holds one tracker per session and calls {@link record} with the
 * latest cumulative cost whenever costs change; {@link snapshot} produces the
 * view sent to clients.
 */
export class BurnRateTracker {
  private samples: CostSample[] = [];
  private readonly maxSamples: number;
  private readonly minIntervalMs: number;
  private readonly windowMs: number;

  constructor(opts: { maxSamples?: number; minIntervalMs?: number; windowMs?: number } = {}) {
    this.maxSamples = Math.max(2, opts.maxSamples ?? 1000);
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 1000);
    this.windowMs = opts.windowMs ?? DEFAULT_BURN_WINDOW_MS;
  }

  /**
   * Record a cumulative cost reading. Readings that arrive within
   * `minIntervalMs` of the previous one are coalesced (the latest value wins)
   * to keep the buffer from filling with near-duplicate points. Non-increasing
   * cumulative values still update the latest reading's value/time.
   */
  record(cumulativeUsd: number, nowMs: number = Date.now()): void {
    if (!Number.isFinite(cumulativeUsd) || cumulativeUsd < 0) return;
    const last = this.samples[this.samples.length - 1];

    if (last) {
      // Coalesce rapid updates into the most recent point.
      if (nowMs - last.t < this.minIntervalMs) {
        last.t = nowMs;
        last.cumulativeUsd = Math.max(last.cumulativeUsd, cumulativeUsd);
        return;
      }
      // Skip exact-duplicate values that don't advance the series.
      if (cumulativeUsd === last.cumulativeUsd && nowMs > last.t) {
        last.t = nowMs;
        return;
      }
    }

    this.samples.push({ t: nowMs, cumulativeUsd });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  /** Produce a burn-rate snapshot from the recorded samples. */
  snapshot(opts: { capUsd?: number; nowMs?: number; maxPoints?: number; nearCapThreshold?: number } = {}): BurnRateSnapshot {
    return summarizeBurnRate(this.samples, {
      capUsd: opts.capUsd,
      windowMs: this.windowMs,
      nowMs: opts.nowMs,
      maxPoints: opts.maxPoints,
      nearCapThreshold: opts.nearCapThreshold,
    });
  }

  /** Return a copy of the retained samples (for inspection/testing). */
  getSamples(): CostSample[] {
    return this.samples.map((s) => ({ ...s }));
  }

  /** Clear all recorded samples. */
  reset(): void {
    this.samples = [];
  }
}
