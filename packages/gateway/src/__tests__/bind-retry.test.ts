import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { bindWithRetry, resolveBindRetryBudgetMs, DEFAULT_BIND_RETRY_BUDGET_MS, formatAllBindsFailedMessage, type ServerLike } from '../bind-retry.js';

/**
 * A fake `net.Server` that we drive manually: each `listen()` call records
 * the attempt and either fires `'error'` (with a queued errno) or
 * `'listening'`.
 */
class FakeServer extends EventEmitter implements ServerLike {
  attempts: Array<{ port: number; address: string }> = [];
  /** Queue of outcomes for successive listen() calls. `null` = success. */
  outcomes: Array<NodeJS.ErrnoException | null> = [];

  listen(port: number, address: string): void {
    this.attempts.push({ port, address });
    const outcome = this.outcomes.shift() ?? null;
    // Defer one tick so once() handlers attached on the same call are wired.
    queueMicrotask(() => {
      if (outcome) this.emit('error', outcome);
      else this.emit('listening');
    });
  }
}

function eaddrinuse(): NodeJS.ErrnoException {
  const e = new Error('listen EADDRINUSE: address already in use 127.0.0.1:8000') as NodeJS.ErrnoException;
  e.code = 'EADDRINUSE';
  return e;
}

describe('bindWithRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('succeeds on the first attempt', async () => {
    const srv = new FakeServer();
    srv.outcomes = [null];
    const p = bindWithRetry(srv, { port: 8000, address: '127.0.0.1' });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(1);
    expect(srv.attempts).toHaveLength(1);
  });

  it('retries through EADDRINUSE and eventually succeeds', async () => {
    const srv = new FakeServer();
    // 3 EADDRINUSEs then success.
    srv.outcomes = [eaddrinuse(), eaddrinuse(), eaddrinuse(), null];
    const onRetry = vi.fn();
    const p = bindWithRetry(srv, {
      port: 8000,
      address: '127.0.0.1',
      totalBudgetMs: 60_000,
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      onRetry,
    });
    // Drive the timers forward to let backoffs elapse.
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(4);
    expect(srv.attempts).toHaveLength(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
    // Backoff progression: 1s, 2s, 4s.
    expect(onRetry.mock.calls[0]![0].delayMs).toBe(1_000);
    expect(onRetry.mock.calls[1]![0].delayMs).toBe(2_000);
    expect(onRetry.mock.calls[2]![0].delayMs).toBe(4_000);
  });

  it('caps backoff at maxDelayMs', async () => {
    const srv = new FakeServer();
    // Many EADDRINUSEs then success — enough to hit the cap.
    srv.outcomes = [eaddrinuse(), eaddrinuse(), eaddrinuse(), eaddrinuse(), eaddrinuse(), null];
    const onRetry = vi.fn();
    const p = bindWithRetry(srv, {
      port: 8000,
      address: '127.0.0.1',
      totalBudgetMs: 600_000,
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      onRetry,
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    // Attempts 4 and 5 should both be capped at 5_000ms.
    expect(onRetry.mock.calls[3]![0].delayMs).toBe(5_000);
    expect(onRetry.mock.calls[4]![0].delayMs).toBe(5_000);
  });

  it('exits exactly once with a giveup result when EADDRINUSE persists past the budget', async () => {
    const srv = new FakeServer();
    // Permanent EADDRINUSE.
    srv.outcomes = Array.from({ length: 50 }, () => eaddrinuse());
    const onRetry = vi.fn();
    const p = bindWithRetry(srv, {
      port: 8000,
      address: '127.0.0.1',
      totalBudgetMs: 10_000, // small budget so the test runs quickly
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
      onRetry,
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('giveup');
      expect(result.lastErr?.code).toBe('EADDRINUSE');
      expect(result.attempts).toBeGreaterThan(1);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(10_000);
    }
    // We should not loop forever — total attempts is bounded by the budget.
    expect(srv.attempts.length).toBeLessThan(20);
  });

  it('returns fatal on a non-EADDRINUSE listen error without retrying', async () => {
    const srv = new FakeServer();
    const eaccess = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    eaccess.code = 'EACCES';
    srv.outcomes = [eaccess];
    const p = bindWithRetry(srv, { port: 80, address: '0.0.0.0' });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('fatal');
      expect(result.attempts).toBe(1);
      expect(result.lastErr?.code).toBe('EACCES');
    }
    expect(srv.attempts).toHaveLength(1);
  });

  it('aborts cleanly on shutdown signal during backoff', async () => {
    const srv = new FakeServer();
    srv.outcomes = [eaddrinuse(), eaddrinuse(), null];
    const ac = new AbortController();
    const p = bindWithRetry(srv, {
      port: 8000,
      address: '127.0.0.1',
      totalBudgetMs: 60_000,
      initialDelayMs: 1_000,
      signal: ac.signal,
    });
    // Let the first attempt fail and enter backoff.
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('shutdown');
    }
    // We should NOT have attempted to listen again after abort.
    expect(srv.attempts.length).toBeLessThanOrEqual(2);
  });
});

describe('formatAllBindsFailedMessage', () => {
  it('produces a single line that includes attempts, elapsed seconds, and last errno per address (giveup)', () => {
    const msg = formatAllBindsFailedMessage({
      port: 8000,
      budgetMs: 60_000,
      outcomes: [
        { address: '127.0.0.1', reason: 'giveup', attempts: 7, elapsedMs: 60_300, lastErrCode: 'EADDRINUSE', lastErrMessage: 'in use' },
        { address: '::1', reason: 'giveup', attempts: 6, elapsedMs: 60_100, lastErrCode: 'EADDRINUSE', lastErrMessage: 'in use' },
      ],
    });
    expect(msg).toContain('Failed to bind to [127.0.0.1, ::1]:8000');
    expect(msg).toContain('60s budget');
    expect(msg).toContain('exiting');
    expect(msg).toContain('127.0.0.1: EADDRINUSE after 7 attempt(s), 60.3s');
    expect(msg).toContain('::1: EADDRINUSE after 6 attempt(s), 60.1s');
    // Single line, no embedded newlines.
    expect(msg.split('\n')).toHaveLength(1);
  });

  it('uses "on first attempt" wording when every address failed fatally on attempt 1', () => {
    const msg = formatAllBindsFailedMessage({
      port: 80,
      budgetMs: 60_000,
      outcomes: [
        { address: '0.0.0.0', reason: 'fatal', attempts: 1, elapsedMs: 12, lastErrCode: 'EACCES', lastErrMessage: 'denied' },
      ],
    });
    expect(msg).toContain('on first attempt');
    expect(msg).not.toContain('budget');
    expect(msg).toContain('EACCES after 1 attempt(s)');
  });

  it('falls back to UNKNOWN when no errno is present', () => {
    const msg = formatAllBindsFailedMessage({
      port: 8000,
      budgetMs: 60_000,
      outcomes: [{ address: '127.0.0.1', reason: 'giveup', attempts: 3, elapsedMs: 5_000 }],
    });
    expect(msg).toContain('UNKNOWN after 3 attempt(s), 5s');
  });
});

describe('resolveBindRetryBudgetMs', () => {
  it('returns the default when env var is missing', () => {
    expect(resolveBindRetryBudgetMs({})).toBe(DEFAULT_BIND_RETRY_BUDGET_MS);
  });
  it('returns the default for invalid values', () => {
    expect(resolveBindRetryBudgetMs({ ORIONOMEGA_BIND_RETRY_MS: 'banana' })).toBe(DEFAULT_BIND_RETRY_BUDGET_MS);
    expect(resolveBindRetryBudgetMs({ ORIONOMEGA_BIND_RETRY_MS: '0' })).toBe(DEFAULT_BIND_RETRY_BUDGET_MS);
    expect(resolveBindRetryBudgetMs({ ORIONOMEGA_BIND_RETRY_MS: '-100' })).toBe(DEFAULT_BIND_RETRY_BUDGET_MS);
  });
  it('honors a valid override', () => {
    expect(resolveBindRetryBudgetMs({ ORIONOMEGA_BIND_RETRY_MS: '90000' })).toBe(90_000);
  });
});
