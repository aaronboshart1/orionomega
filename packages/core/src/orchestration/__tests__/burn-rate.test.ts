/**
 * @module orchestration/__tests__/burn-rate
 *
 * Unit tests for the live burn-rate computation (Task #245).
 *
 * Covers:
 * - computeBurnRate: empty / single-sample / zero-elapsed edge cases + windowing
 * - buildSpendSeries: empty, downsampling, per-interval instantaneous rate
 * - summarizeBurnRate: cap fraction, approaching/over flags, time-to-exhaustion
 * - BurnRateTracker: bounded buffer, coalescing, reset
 */

import { describe, it, expect } from 'vitest';
import {
  computeBurnRate,
  buildSpendSeries,
  summarizeBurnRate,
  BurnRateTracker,
  type CostSample,
} from '../burn-rate.js';

const MS_PER_HOUR = 3_600_000;

// ── computeBurnRate ───────────────────────────────────────────────────────────

describe('computeBurnRate', () => {
  it('returns 0 for an empty sample set', () => {
    expect(computeBurnRate([])).toBe(0);
  });

  it('returns 0 for a single sample (no elapsed interval)', () => {
    expect(computeBurnRate([{ t: 1000, cumulativeUsd: 5 }])).toBe(0);
  });

  it('returns 0 when no time has elapsed between samples', () => {
    const samples: CostSample[] = [
      { t: 1000, cumulativeUsd: 1 },
      { t: 1000, cumulativeUsd: 2 },
    ];
    expect(computeBurnRate(samples)).toBe(0);
  });

  it('returns 0 when spend does not increase across the window', () => {
    const samples: CostSample[] = [
      { t: 0, cumulativeUsd: 5 },
      { t: MS_PER_HOUR, cumulativeUsd: 5 },
    ];
    expect(computeBurnRate(samples)).toBe(0);
  });

  it('computes $/hr over a one-hour span', () => {
    const samples: CostSample[] = [
      { t: 0, cumulativeUsd: 0 },
      { t: MS_PER_HOUR, cumulativeUsd: 3 },
    ];
    // $3 over 1h → $3/hr (window large enough to anchor on the first sample).
    expect(computeBurnRate(samples, { windowMs: 2 * MS_PER_HOUR })).toBeCloseTo(3, 6);
  });

  it('computes $/hr over a sub-hour span', () => {
    const samples: CostSample[] = [
      { t: 0, cumulativeUsd: 0 },
      { t: MS_PER_HOUR / 2, cumulativeUsd: 1 }, // $1 in 30 min → $2/hr
    ];
    expect(computeBurnRate(samples, { windowMs: MS_PER_HOUR })).toBeCloseTo(2, 6);
  });

  it('anchors on the sliding window, ignoring older spend', () => {
    // Spend $10 in the first hour, then $1 in the last 5 minutes.
    const now = 2 * MS_PER_HOUR;
    const samples: CostSample[] = [
      { t: 0, cumulativeUsd: 0 },
      { t: MS_PER_HOUR, cumulativeUsd: 10 },
      { t: now - 5 * 60_000, cumulativeUsd: 10 },
      { t: now, cumulativeUsd: 11 },
    ];
    // 5-minute window: $1 over 5 min → $12/hr (not the lifetime average).
    const rate = computeBurnRate(samples, { windowMs: 5 * 60_000, nowMs: now });
    expect(rate).toBeCloseTo(12, 6);
  });
});

// ── buildSpendSeries ──────────────────────────────────────────────────────────

describe('buildSpendSeries', () => {
  it('returns an empty array for no samples', () => {
    expect(buildSpendSeries([])).toEqual([]);
  });

  it('keeps all samples when under the cap and computes per-interval rates', () => {
    const samples: CostSample[] = [
      { t: 0, cumulativeUsd: 0 },
      { t: MS_PER_HOUR, cumulativeUsd: 2 },
      { t: 2 * MS_PER_HOUR, cumulativeUsd: 5 },
    ];
    const series = buildSpendSeries(samples, 60);
    expect(series).toHaveLength(3);
    expect(series[0].usdPerHour).toBe(0); // first point has no prior interval
    expect(series[1].usdPerHour).toBeCloseTo(2, 6); // $2 in 1h
    expect(series[2].usdPerHour).toBeCloseTo(3, 6); // $3 in 1h
  });

  it('downsamples to at most maxPoints and retains the latest reading', () => {
    const samples: CostSample[] = Array.from({ length: 500 }, (_, i) => ({
      t: i * 1000,
      cumulativeUsd: i * 0.1,
    }));
    const series = buildSpendSeries(samples, 60);
    expect(series.length).toBeLessThanOrEqual(60);
    expect(series.length).toBeGreaterThan(1);
    // Last retained point is the true latest sample.
    expect(series[series.length - 1].t).toBe(samples[samples.length - 1].t);
    expect(series[series.length - 1].cumulativeUsd).toBeCloseTo(
      samples[samples.length - 1].cumulativeUsd,
      6,
    );
  });
});

// ── summarizeBurnRate ─────────────────────────────────────────────────────────

describe('summarizeBurnRate', () => {
  it('produces a zeroed snapshot for no samples', () => {
    const snap = summarizeBurnRate([]);
    expect(snap.totalUsd).toBe(0);
    expect(snap.burnRateUsdPerHour).toBe(0);
    expect(snap.spendSeries).toEqual([]);
    expect(snap.approachingCap).toBe(false);
    expect(snap.overCap).toBe(false);
    expect(snap.capUsd).toBeUndefined();
  });

  it('omits cap fields when no cap is configured', () => {
    const snap = summarizeBurnRate([
      { t: 0, cumulativeUsd: 0 },
      { t: MS_PER_HOUR, cumulativeUsd: 1 },
    ]);
    expect(snap.capUsd).toBeUndefined();
    expect(snap.fractionOfCap).toBeUndefined();
    expect(snap.msToCapExhaustion).toBeUndefined();
  });

  it('reports fraction-of-cap and not-yet-approaching below threshold', () => {
    const snap = summarizeBurnRate(
      [
        { t: 0, cumulativeUsd: 0 },
        { t: MS_PER_HOUR, cumulativeUsd: 5 },
      ],
      { capUsd: 100, windowMs: 2 * MS_PER_HOUR },
    );
    expect(snap.capUsd).toBe(100);
    expect(snap.fractionOfCap).toBeCloseTo(0.05, 6);
    expect(snap.approachingCap).toBe(false);
    expect(snap.overCap).toBe(false);
    // $5 spent, $95 remaining at $5/hr → 19h projected.
    expect(snap.msToCapExhaustion).toBeCloseTo(19 * MS_PER_HOUR, 0);
  });

  it('flags approaching the cap at/above the near-cap threshold', () => {
    const snap = summarizeBurnRate(
      [
        { t: 0, cumulativeUsd: 0 },
        { t: MS_PER_HOUR, cumulativeUsd: 85 },
      ],
      { capUsd: 100, windowMs: 2 * MS_PER_HOUR },
    );
    expect(snap.approachingCap).toBe(true);
    expect(snap.overCap).toBe(false);
  });

  it('flags over-cap and zero time-to-exhaustion once spend ≥ cap', () => {
    const snap = summarizeBurnRate(
      [
        { t: 0, cumulativeUsd: 0 },
        { t: MS_PER_HOUR, cumulativeUsd: 120 },
      ],
      { capUsd: 100, windowMs: 2 * MS_PER_HOUR },
    );
    expect(snap.overCap).toBe(true);
    expect(snap.approachingCap).toBe(true);
    expect(snap.msToCapExhaustion).toBe(0);
  });

  it('returns null time-to-exhaustion when the burn rate is zero', () => {
    const snap = summarizeBurnRate(
      [
        { t: 0, cumulativeUsd: 5 },
        { t: MS_PER_HOUR, cumulativeUsd: 5 }, // no spend → rate 0
      ],
      { capUsd: 100, windowMs: 2 * MS_PER_HOUR },
    );
    expect(snap.burnRateUsdPerHour).toBe(0);
    expect(snap.msToCapExhaustion).toBeNull();
  });
});

// ── BurnRateTracker ───────────────────────────────────────────────────────────

describe('BurnRateTracker', () => {
  it('records distinct samples and produces a snapshot', () => {
    const tracker = new BurnRateTracker({ minIntervalMs: 0 });
    tracker.record(0, 0);
    tracker.record(2, MS_PER_HOUR);
    const snap = tracker.snapshot({});
    expect(snap.totalUsd).toBe(2);
    expect(tracker.getSamples()).toHaveLength(2);
  });

  it('coalesces rapid updates within minIntervalMs into the latest point', () => {
    const tracker = new BurnRateTracker({ minIntervalMs: 1000 });
    tracker.record(1, 0);
    tracker.record(2, 500); // within 1s → coalesced
    tracker.record(3, 600); // within 1s → coalesced
    const samples = tracker.getSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].cumulativeUsd).toBe(3);
    expect(samples[0].t).toBe(600);
  });

  it('ignores invalid (negative / non-finite) readings', () => {
    const tracker = new BurnRateTracker({ minIntervalMs: 0 });
    tracker.record(-5, 0);
    tracker.record(Number.NaN, 1);
    expect(tracker.getSamples()).toHaveLength(0);
  });

  it('bounds the buffer to maxSamples (drops oldest)', () => {
    const tracker = new BurnRateTracker({ maxSamples: 10, minIntervalMs: 0 });
    for (let i = 0; i < 100; i++) tracker.record(i, i * 1000);
    const samples = tracker.getSamples();
    expect(samples).toHaveLength(10);
    // Oldest dropped → first retained is sample #90.
    expect(samples[0].cumulativeUsd).toBe(90);
    expect(samples[samples.length - 1].cumulativeUsd).toBe(99);
  });

  it('threads the cap through to the snapshot', () => {
    const tracker = new BurnRateTracker({ minIntervalMs: 0 });
    tracker.record(0, 0);
    tracker.record(90, MS_PER_HOUR);
    const snap = tracker.snapshot({ capUsd: 100 });
    expect(snap.capUsd).toBe(100);
    expect(snap.approachingCap).toBe(true);
  });

  it('clears samples on reset', () => {
    const tracker = new BurnRateTracker({ minIntervalMs: 0 });
    tracker.record(1, 0);
    tracker.record(2, 1000);
    tracker.reset();
    expect(tracker.getSamples()).toHaveLength(0);
  });
});
