'use client';

import { useChatStore } from '@/stores/chat';
import type { BurnRateSnapshot } from '@/stores/chat';
import { formatCost, formatElapsedMs } from '@/utils/format';
import { useMemo } from 'react';

/** Format a $/hr value compactly. */
function formatRate(usdPerHour: number): string {
  if (usdPerHour <= 0) return '$0.00/hr';
  if (usdPerHour < 0.01) return `$${usdPerHour.toFixed(4)}/hr`;
  if (usdPerHour < 1) return `$${usdPerHour.toFixed(3)}/hr`;
  return `$${usdPerHour.toFixed(2)}/hr`;
}

/**
 * Build an SVG polyline path for the cumulative spend series, normalised into a
 * `width`×`height` box. Returns null when there aren't enough points to draw.
 */
function buildSparkline(
  series: BurnRateSnapshot['spendSeries'],
  width: number,
  height: number,
): { line: string; area: string } | null {
  if (series.length < 2) return null;
  const ts = series.map((p) => p.t);
  const vals = series.map((p) => p.cumulativeUsd);
  const minT = Math.min(...ts);
  const maxT = Math.max(...ts);
  const maxV = Math.max(...vals);
  const spanT = maxT - minT || 1;
  const spanV = maxV || 1;

  const pts = series.map((p) => {
    const x = ((p.t - minT) / spanT) * width;
    // Invert Y so larger spend is higher on screen; leave a 1px margin.
    const y = height - (p.cumulativeUsd / spanV) * (height - 2) - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const line = pts.join(' ');
  const area = `${pts[0].split(',')[0]},${height} ${line} ${pts[pts.length - 1].split(',')[0]},${height}`;
  return { line, area };
}

/**
 * Live budget burn-rate view (Task #245).
 *
 * Renders the current burn rate ($/hr), an inline SVG sparkline of cumulative
 * spend over time, and — when a session budget cap is configured — how close
 * the session is to (or over) the cap plus a projected time-to-exhaustion.
 *
 * No charting dependency: the sparkline is a hand-rolled SVG polyline so the
 * web bundle stays lean.
 */
export function BurnRateView() {
  const burnRate = useChatStore((s) => s.burnRate);

  const spark = useMemo(
    () => (burnRate ? buildSparkline(burnRate.spendSeries, 120, 28) : null),
    [burnRate],
  );

  // Nothing to show until at least one cost sample with non-zero spend exists.
  if (!burnRate || burnRate.totalUsd <= 0) return null;

  const {
    burnRateUsdPerHour,
    capUsd,
    fractionOfCap,
    msToCapExhaustion,
    approachingCap,
    overCap,
  } = burnRate;

  const pct = fractionOfCap !== undefined ? Math.min(fractionOfCap, 1) * 100 : null;

  // Colour the burn rate / progress by cap status.
  const accent = overCap
    ? 'text-red-500'
    : approachingCap
      ? 'text-amber-500'
      : 'text-green-500/70';
  const strokeColor = overCap ? '#ef4444' : approachingCap ? '#f59e0b' : '#22c55e';

  return (
    <div className="flex flex-col gap-1 text-[10px] text-zinc-600 select-none">
      <div className="flex items-center gap-2">
        <span title="Live spend rate over the last few minutes">
          <span className={`font-medium ${accent}`}>{formatRate(burnRateUsdPerHour)}</span>
        </span>
        {spark && (
          <svg
            width={120}
            height={28}
            viewBox="0 0 120 28"
            className="overflow-visible"
            aria-label="Spend over time"
            role="img"
          >
            <polyline points={spark.area} fill={strokeColor} fillOpacity={0.12} stroke="none" />
            <polyline
              points={spark.line}
              fill="none"
              stroke={strokeColor}
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        )}
      </div>

      {capUsd !== undefined && (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <span title="Session budget cap">
              {formatCost(burnRate.totalUsd)} / {formatCost(capUsd)}
              {pct !== null && <span className="ml-1 text-zinc-500">({pct.toFixed(0)}%)</span>}
            </span>
            {overCap ? (
              <span className="font-medium text-red-500">over budget</span>
            ) : approachingCap ? (
              <span className="font-medium text-amber-500">
                {msToCapExhaustion != null
                  ? `~${formatElapsedMs(msToCapExhaustion)} to cap`
                  : 'approaching cap'}
              </span>
            ) : msToCapExhaustion != null ? (
              <span className="text-zinc-500">~{formatElapsedMs(msToCapExhaustion)} to cap</span>
            ) : null}
          </div>
          {pct !== null && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: strokeColor }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
