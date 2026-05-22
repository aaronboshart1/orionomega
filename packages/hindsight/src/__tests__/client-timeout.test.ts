/**
 * Unit tests for HTTP request timeout via AbortController (C1 fix).
 *
 * Verifies:
 *  - fetch() is wrapped with an AbortController signal.
 *  - A hanging fetch is aborted after DEFAULT_TIMEOUT_MS.
 *  - The timeout throws HindsightError with statusCode=0.
 *  - The circuit breaker records the failure on timeout.
 *  - Requests that complete before the deadline work normally.
 *
 * Mocks global.fetch so no running server is required.
 * Uses vi.useFakeTimers to advance time without real delays.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HindsightClient } from '../client.js';
import { HindsightError } from '../errors.js';

const BASE_URL = 'http://test-server';

/**
 * A mock fetch that never resolves on its own but rejects immediately
 * when its AbortSignal fires. This simulates a server that hangs
 * indefinitely until the client-side timeout triggers.
 */
function makeHangingFetch(): typeof globalThis.fetch {
  return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) return; // no signal ⟹ never settles (test must handle this)
      if (signal.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as unknown as typeof globalThis.fetch;
}

describe('HindsightClient — DEFAULT_TIMEOUT_MS constant', () => {
  it('exposes DEFAULT_TIMEOUT_MS as a public static number', () => {
    expect(typeof HindsightClient.DEFAULT_TIMEOUT_MS).toBe('number');
    expect(HindsightClient.DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('DEFAULT_TIMEOUT_MS is at least 5 seconds', () => {
    // A 5-second floor prevents misconfiguration that breaks normal latency.
    expect(HindsightClient.DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe('HindsightClient — request timeout (C1)', () => {
  let client: HindsightClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new HindsightClient(BASE_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('throws HindsightError when fetch hangs past DEFAULT_TIMEOUT_MS', async () => {
    global.fetch = makeHangingFetch();

    const call = client.recall('bank', 'query');
    const check = expect(call).rejects.toBeInstanceOf(HindsightError);
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 1_000);
    await check;
  });

  it('HindsightError from a timeout has statusCode 0', async () => {
    global.fetch = makeHangingFetch();

    const errPromise = client.recall('bank', 'query').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 1_000);
    const err = await errPromise;

    expect(err).toBeInstanceOf(HindsightError);
    expect((err as HindsightError).statusCode).toBe(0);
  });

  it('HindsightError message references the abort or timeout', async () => {
    global.fetch = makeHangingFetch();

    const errPromise = client.recall('bank', 'query').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 1_000);
    const err = await errPromise;

    expect(err).toBeInstanceOf(HindsightError);
    const lower = (err as HindsightError).message.toLowerCase();
    expect(lower.includes('abort') || lower.includes('timeout')).toBe(true);
  });

  it('circuit breaker failureCount increases after a timeout', async () => {
    global.fetch = makeHangingFetch();

    const errPromise = client.recall('bank', 'query').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 1_000);
    await errPromise;

    expect(client.getStatus().failureCount).toBeGreaterThan(0);
  });

  it('does not reject before DEFAULT_TIMEOUT_MS has elapsed', async () => {
    global.fetch = makeHangingFetch();

    let rejected = false;
    const call = client.recall('bank', 'query').catch(() => { rejected = true; });

    // Advance to just before the threshold — should not have timed out yet.
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS - 500);
    await Promise.resolve(); // flush microtasks

    expect(rejected).toBe(false);

    // Clean up: advance past the timeout so the promise settles.
    await vi.advanceTimersByTimeAsync(2_000);
    await call;
  });

  it('passes the AbortSignal to fetch so the timeout actually aborts the request', async () => {
    const fetchMock = makeHangingFetch();
    global.fetch = fetchMock;

    const errPromise = client.recall('bank', 'query').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 1_000);
    await errPromise;

    // Verify fetch was called with a RequestInit that includes a signal.
    const [, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('succeeds when the server responds before the timeout', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ results: [] }),
    } as unknown as Response);

    const result = await client.recall('bank', 'query');
    expect(result).toBeDefined();
    expect(client.getStatus().failureCount).toBe(0);
  });

  it('timeout on retain also throws HindsightError with statusCode 0', async () => {
    global.fetch = makeHangingFetch();

    const call = client.retain('bank', [{
      content: 'test memory',
      context: 'decision',
      timestamp: new Date().toISOString(),
    }]);
    const errPromise = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 1_000);
    const err = await errPromise;

    expect(err).toBeInstanceOf(HindsightError);
    expect((err as HindsightError).statusCode).toBe(0);
  });
});
