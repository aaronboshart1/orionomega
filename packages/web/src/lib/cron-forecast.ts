/**
 * @module lib/cron-forecast
 * Minimal next-N-runs forecaster for standard 5-field cron expressions.
 *
 * Supports: `*`, `*​/N`, single number, ranges `a-b`, lists `a,b,c`, and
 * range/step combinations like `1-10/2`. Day-of-week uses 0-7 with both 0
 * and 7 mapping to Sunday. All computation is done in the user's *local*
 * timezone (the browser's `Date` semantics) — sufficient for a UI preview;
 * the gateway's croner-driven scheduler remains the source of truth for
 * actual fire times in arbitrary IANA zones.
 */

type FieldKind = 'minute' | 'hour' | 'dom' | 'month' | 'dow';

const RANGES: Record<FieldKind, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

function parseField(raw: string, kind: FieldKind): Set<number> | null {
  const [lo, hi] = RANGES[kind];
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const stepMatch = part.match(/^(.+?)\/(\d+)$/);
    const body = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;

    let start: number;
    let end: number;
    if (body === '*') {
      start = lo;
      end = hi;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-').map((n) => Number.parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      start = a;
      end = b;
    } else {
      const n = Number.parseInt(body, 10);
      if (!Number.isFinite(n)) return null;
      start = n;
      end = n;
    }

    // For DOW, accept 0-7 with 7 == Sunday on either endpoint and normalize
    // each emitted value via mod 7. Bounds check uses an extended upper bound.
    const upper = kind === 'dow' ? 7 : hi;
    if (start < lo || end > upper || start > end) return null;

    for (let v = start; v <= end; v += step) {
      out.add(kind === 'dow' ? v % 7 : v);
    }
  }
  return out.size > 0 ? out : null;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True if dom field is `*` (affects vixie-cron OR semantics with dow). */
  domAny: boolean;
  dowAny: boolean;
}

export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields;
  const minute = parseField(m, 'minute');
  const hour = parseField(h, 'hour');
  const domSet = parseField(dom, 'dom');
  const month = parseField(mon, 'month');
  const dowSet = parseField(dow, 'dow');
  if (!minute || !hour || !domSet || !month || !dowSet) return null;
  return {
    minute,
    hour,
    dom: domSet,
    month,
    dow: dowSet,
    domAny: dom.trim() === '*',
    dowAny: dow.trim() === '*',
  };
}

/**
 * Forecast the next N fire times after `from` (default: now). Returns a
 * possibly-shorter array if no matches are found within the search window
 * (~366 days). Walks minute-by-minute with smart skips on month/day
 * mismatches; bounded by ~525,600 iterations for safety.
 */
export function nextRuns(expr: string, n = 5, from: Date = new Date()): Date[] {
  const cron = parseCron(expr);
  if (!cron) return [];

  const out: Date[] = [];
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations && out.length < n; i++) {
    const month = cursor.getMonth() + 1;
    if (!cron.month.has(month)) {
      // Jump to first of next month, midnight.
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      cursor.setMonth(cursor.getMonth() + 1);
      continue;
    }
    const dom = cursor.getDate();
    const dow = cursor.getDay();
    // Vixie cron: if both dom and dow are restricted, match either (OR).
    const domOk = cron.dom.has(dom);
    const dowOk = cron.dow.has(dow);
    let dayMatch: boolean;
    if (cron.domAny && cron.dowAny) dayMatch = true;
    else if (cron.domAny) dayMatch = dowOk;
    else if (cron.dowAny) dayMatch = domOk;
    else dayMatch = domOk || dowOk;

    if (!dayMatch) {
      cursor.setHours(0, 0, 0, 0);
      cursor.setDate(cursor.getDate() + 1);
      continue;
    }
    if (!cron.hour.has(cursor.getHours())) {
      cursor.setMinutes(0);
      cursor.setHours(cursor.getHours() + 1);
      continue;
    }
    if (!cron.minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1);
      continue;
    }
    out.push(new Date(cursor.getTime()));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return out;
}
