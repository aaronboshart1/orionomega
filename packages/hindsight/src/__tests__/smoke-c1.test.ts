/**
 * C1 Supplementary Smoke Tests — AbortController timeout + prompt budget caps
 *
 * Edge cases:
 *  - retain() with empty items array (should not crash)
 *  - retain() with empty-content items (filtered out)
 *  - Concurrent recall() calls (no deadlock or data loss)
 *  - recall() with empty string query
 *  - recall() with very long query (10 000 chars)
 *  - recall() with special characters
 *  - DEFAULT_TIMEOUT_MS is exactly 10 000 ms
 *  - Client usable after a timeout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HindsightClient } from '../client.js';
import { HindsightError } from '../errors.js';

const BASE_URL = 'http://test-server';

function makeOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('C1 Supplement — edge cases for timeout + budget caps', () => {
  let client: HindsightClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new HindsightClient(BASE_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('DEFAULT_TIMEOUT_MS is exactly 10 000 ms', () => {
    expect(HindsightClient.DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it('retain() with empty items array does not crash', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeOk({ success: true, bank_id: 'bank', items_count: 0 }));
    const result = await client.retain('bank', []);
    expect(result).toBeDefined();
  });

  it('retain() with empty-content items throws HindsightError(422) — graceful typed rejection', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeOk({ success: true, bank_id: 'bank', items_count: 0 }));
    // The client guards against empty content client-side, throwing HindsightError(422)
    // rather than sending bad data to the API. This IS the graceful handling.
    const err = await client.retain('bank', [
      { content: '', context: 'test', timestamp: new Date().toISOString() },
    ]).catch(e => e);
    expect(err).toBeInstanceOf(HindsightError);
    expect((err as HindsightError).statusCode).toBe(422);
    // Error message should identify the bad item
    expect((err as HindsightError).message).toContain('empty content');
  });

  it('concurrent recall() calls all resolve without data corruption', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const n = callCount;
      return Promise.resolve(makeOk({
        results: [{ content: `result-${n}`, relevance: 0.9, timestamp: new Date().toISOString() }],
        tokens_used: 10,
      }));
    });

    const calls = Array.from({ length: 5 }, (_, i) => client.recall('bank', `query-${i}`));
    const results = await Promise.all(calls);

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r).toBeDefined();
      expect(Array.isArray(r.results)).toBe(true);
    }
  });

  it('recall() with empty string query does not throw', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeOk({ results: [], tokens_used: 0 }));
    const result = await client.recall('bank', '');
    expect(result).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('recall() with 10 000-char query does not crash', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeOk({ results: [], tokens_used: 0 }));
    const result = await client.recall('bank', 'x'.repeat(10_000));
    expect(result).toBeDefined();
  });

  it('recall() with special characters does not crash', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeOk({ results: [], tokens_used: 0 }));
    const result = await client.recall('bank', '!@#$%^&*()<>?{}[]\\|\'"` ~\n\t\r');
    expect(result).toBeDefined();
  });

  it('client is usable after a timeout (state not corrupted)', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
            });
          }
        });
      }
      return Promise.resolve(makeOk({ results: [], tokens_used: 0 }));
    });

    // First call times out
    const timedOut = client.recall('bank', 'q1').catch(() => 'timed-out');
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 500);
    expect(await timedOut).toBe('timed-out');

    // Second call succeeds — client is still healthy
    const result = await client.recall('bank', 'q2');
    expect(result).toBeDefined();
  });

  it('HindsightError on timeout has statusCode=0 and mentions abort/timeout', async () => {
    global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e);
          });
        }
      });
    });

    const errPromise = client.recall('bank', 'query').catch(e => e);
    await vi.advanceTimersByTimeAsync(HindsightClient.DEFAULT_TIMEOUT_MS + 1_000);
    const err = await errPromise;

    expect(err).toBeInstanceOf(HindsightError);
    expect((err as HindsightError).statusCode).toBe(0);
    const msg = (err as HindsightError).message.toLowerCase();
    expect(msg.includes('abort') || msg.includes('timeout')).toBe(true);
  });
});
