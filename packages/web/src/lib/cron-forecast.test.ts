/**
 * @module lib/cron-forecast.test
 * Unit tests for the client-side cron parser and next-runs forecaster.
 */

import { describe, it, expect } from 'vitest';
import { parseCron, nextRuns } from './cron-forecast';

describe('parseCron', () => {
  it('rejects expressions that do not have exactly 5 fields', () => {
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('* * * * * *')).toBeNull();
    expect(parseCron('')).toBeNull();
  });

  it('parses a wildcard expression into full ranges', () => {
    const cron = parseCron('* * * * *');
    expect(cron).not.toBeNull();
    expect(cron!.minute.size).toBe(60);
    expect(cron!.hour.size).toBe(24);
    expect(cron!.domAny).toBe(true);
    expect(cron!.dowAny).toBe(true);
  });

  it('parses step, range, and list syntax', () => {
    const cron = parseCron('0,30 9-17 * * 1-5');
    expect(cron).not.toBeNull();
    expect([...cron!.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...cron!.hour].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron!.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses range/step combinations', () => {
    const cron = parseCron('1-10/2 * * * *');
    expect([...cron!.minute].sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9]);
  });

  it('normalizes day-of-week 7 to Sunday (0)', () => {
    const cron = parseCron('0 0 * * 7');
    expect(cron!.dow.has(0)).toBe(true);
  });

  it('returns null for out-of-range or invalid fields', () => {
    expect(parseCron('99 * * * *')).toBeNull();
    expect(parseCron('* 25 * * *')).toBeNull();
    expect(parseCron('* * * * 8')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull();
  });
});

describe('nextRuns', () => {
  it('returns [] for an invalid expression', () => {
    expect(nextRuns('not a cron')).toEqual([]);
  });

  it('forecasts the next N runs strictly after the `from` time', () => {
    const from = new Date('2026-01-01T10:15:30');
    const runs = nextRuns('0 * * * *', 3, from);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toEqual(new Date('2026-01-01T11:00:00'));
    expect(runs[1]).toEqual(new Date('2026-01-01T12:00:00'));
    expect(runs[2]).toEqual(new Date('2026-01-01T13:00:00'));
  });

  it('honors a specific minute/hour daily schedule', () => {
    const from = new Date('2026-03-10T08:00:00');
    const runs = nextRuns('30 9 * * *', 2, from);
    expect(runs[0]).toEqual(new Date('2026-03-10T09:30:00'));
    expect(runs[1]).toEqual(new Date('2026-03-11T09:30:00'));
  });

  it('honors a weekday-restricted schedule (Mondays)', () => {
    // 2026-06-10 is a Wednesday; next Monday at 00:00 is 2026-06-15.
    const from = new Date('2026-06-10T12:00:00');
    const runs = nextRuns('0 0 * * 1', 1, from);
    expect(runs[0]!.getDay()).toBe(1);
    expect(runs[0]).toEqual(new Date('2026-06-15T00:00:00'));
  });
});
