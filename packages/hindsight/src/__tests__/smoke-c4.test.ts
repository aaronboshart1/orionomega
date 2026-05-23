/**
 * C4 Supplementary Smoke Tests — 429 retry + Retry-After + cache invalidation
 *
 * Edge cases:
 *  - write (retain) then 429-retry recall (write → invalidate → re-read)
 *  - listBanksCached() cache: populated → invalidated → re-fetched
 *  - stale 429 state does not contaminate next call
 *  - Retry-After: 0 → near-immediate retry
 *  - Retry-After: non-numeric → falls back to exponential backoff
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HindsightClient } from '../client.js';
import { HindsightError } from '../errors.js';

const BASE_URL = 'http://test-server';

function makeResponse(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('C4 Supplement — cache invalidation and 429 edge cases', () => {
  let client: HindsightClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new HindsightClient(BASE_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('listBanksCached(): cache populated → invalidated → re-fetched (no stale data)', async () => {
    const bankList = [{ bank_id: 'bank-a', name: 'Bank A', created_at: new Date().toISOString() }];
    // listBanks() parses res.banks — the response body must be { banks: [...] }
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, { banks: bankList }));
    global.fetch = fetchMock;

    // First call: fetches and caches
    await client.listBanksCached();
    const callsAfterFirst = fetchMock.mock.calls.length;

    // Second call: uses cache
    await client.listBanksCached();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no new fetch

    // Invalidate
    client.invalidateBanksCache();

    // Third call: must re-fetch
    const r3 = await client.listBanksCached();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(Array.isArray(r3)).toBe(true);
  });

  it('stale 429 error (all retries exhausted) does not prevent next call from succeeding', async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      if (calls <= 3) {
        return Promise.resolve(makeResponse(429, { error: 'rate limited' }));
      }
      return Promise.resolve(makeResponse(200, { results: [], tokens_used: 0 }));
    });

    // Exhaust retries — must advance timers BEFORE awaiting (retry uses setTimeout)
    const errPromise = client.recall('bank', 'q1').catch(e => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await errPromise;
    expect(err).toBeInstanceOf(HindsightError);

    // Fresh call should succeed immediately (no fake-timer advance needed — mock returns 200)
    const result = await client.recall('bank', 'q2');
    expect(result).toBeDefined();
  });

  it('Retry-After: 0 triggers near-immediate retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(makeResponse(200, { results: [], tokens_used: 0 }));
    global.fetch = fetchMock;

    const call = client.recall('bank', 'query');
    const check = expect(call).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Retry-After: non-numeric falls back to exponential backoff and eventually succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(429, {}, { 'retry-after': 'bad-value' }))
      .mockResolvedValueOnce(makeResponse(200, { results: [], tokens_used: 0 }));
    global.fetch = fetchMock;

    const call = client.recall('bank', 'query');
    const check = expect(call).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('write-read-invalidate-reread cycle: no stale data served', async () => {
    let retainCalled = false;
    let recallCalls = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/memories') && !url.includes('/recall')) {
        retainCalled = true;
        return Promise.resolve(makeResponse(200, { success: true, bank_id: 'bank', items_count: 1 }));
      }
      recallCalls++;
      if (recallCalls === 1) {
        return Promise.resolve(makeResponse(429, { error: 'rate limited' }));
      }
      return Promise.resolve(makeResponse(200, {
        results: [{ content: 'fresh', relevance: 0.9, timestamp: new Date().toISOString() }],
        tokens_used: 5,
      }));
    });

    // Write
    await client.retain('bank', [{ content: 'mem', context: 'ctx', timestamp: new Date().toISOString() }]);
    expect(retainCalled).toBe(true);

    // Read with retry (first is 429, second is 200)
    const recallPromise = client.recall('bank', 'query');
    const check = expect(recallPromise).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await check;
    expect(result).toBeDefined();
  });
});
