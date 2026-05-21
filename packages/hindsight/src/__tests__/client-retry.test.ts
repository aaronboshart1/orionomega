/**
 * Unit tests for createBank() retry logic (SHM/500 resilience).
 *
 * Verifies:
 *  - Retries up to 3 times on 500/502/503, with exponential backoff.
 *  - Does NOT retry on 4xx (client errors / auth failures).
 *  - Handles the race condition where the bank was created despite the 500.
 *  - Propagates the error when all retries are exhausted and bank doesn't exist.
 *
 * Mocks global.fetch and vi.useFakeTimers to avoid real delays.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HindsightClient } from '../client.js';

const BASE_URL = 'http://test-server';
const BANK_ID = 'project-shm-test';

/** Build a minimal Response-like object. */
function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** A Response for a successful bank list containing BANK_ID. */
function bankListResponse(): Response {
  return makeResponse(200, { banks: [{ bank_id: BANK_ID, name: 'Test' }] });
}

/** A Response for an empty bank list. */
function emptyListResponse(): Response {
  return makeResponse(200, { banks: [] });
}

/** A minimal BankConfig for tests. */
const BANK_CONFIG = { name: 'SHM test bank' };

describe('HindsightClient.createBank() — retry on transient 500', () => {
  let client: HindsightClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new HindsightClient(BASE_URL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('succeeds on first attempt when server returns 200', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeResponse(200, {}));
    await expect(client.createBank(BANK_ID, BANK_CONFIG)).resolves.toBeUndefined();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('retries twice after 500s and succeeds on third attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(500, { error: 'Internal Server Error' }))
      .mockResolvedValueOnce(makeResponse(500, { error: 'Internal Server Error' }))
      .mockResolvedValueOnce(makeResponse(200, {}));
    global.fetch = fetchMock;

    // Attach the resolution handler before advancing timers so the promise
    // always has a handler and never triggers an unhandled-rejection warning.
    const result = client.createBank(BANK_ID, BANK_CONFIG);
    const check = expect(result).resolves.toBeUndefined();
    // Advance through both backoff delays (1 s + 2 s).
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await check;

    // 2 failed PUTs + 1 successful PUT = 3 PUT calls total.
    const putCalls = fetchMock.mock.calls.filter(
      ([_url, init]) => (init as RequestInit).method === 'PUT',
    );
    expect(putCalls).toHaveLength(3);
  });

  it('retries on 502 and 503 as well', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(502, { error: 'Bad Gateway' }))
      .mockResolvedValueOnce(makeResponse(503, { error: 'Service Unavailable' }))
      .mockResolvedValueOnce(makeResponse(200, {}));
    global.fetch = fetchMock;

    const result = client.createBank(BANK_ID, BANK_CONFIG);
    const check = expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await check;
  });

  it('does NOT retry on 400 (client error)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResponse(400, { error: 'Bad Request' }),
    );
    await expect(client.createBank(BANK_ID, BANK_CONFIG)).rejects.toThrow();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401 (auth failure)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResponse(401, { error: 'Unauthorized' }),
    );
    await expect(client.createBank(BANK_ID, BANK_CONFIG)).rejects.toThrow();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 422 (validation error)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResponse(422, { error: 'Unprocessable Entity' }),
    );
    await expect(client.createBank(BANK_ID, BANK_CONFIG)).rejects.toThrow();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('handles race condition: bank exists despite 500 after all retries', async () => {
    // All 3 PUT attempts return 500, but a subsequent GET /banks shows
    // the bank was actually created (common with /dev/shm exhaustion).
    const fetchMock = vi.fn()
      // 3 failed PUT attempts
      .mockResolvedValueOnce(makeResponse(500, { error: 'shm exhausted' }))
      .mockResolvedValueOnce(makeResponse(500, { error: 'shm exhausted' }))
      .mockResolvedValueOnce(makeResponse(500, { error: 'shm exhausted' }))
      // bankExists() → listBanksCached() → GET /banks → bank is there
      .mockResolvedValueOnce(bankListResponse());
    global.fetch = fetchMock;

    // Attach the handler before advancing timers to avoid unhandled-rejection warnings.
    const result = client.createBank(BANK_ID, BANK_CONFIG);
    const check = expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await check;
  });

  it('throws when all retries exhausted and bank does not exist', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(500, { error: 'shm exhausted' }))
      .mockResolvedValueOnce(makeResponse(500, { error: 'shm exhausted' }))
      .mockResolvedValueOnce(makeResponse(500, { error: 'shm exhausted' }))
      // bankExists() check returns empty list
      .mockResolvedValueOnce(emptyListResponse());
    global.fetch = fetchMock;

    // Attach the rejection handler immediately — before timer advancement — so
    // the promise always has a handler and never triggers the Node.js
    // PromiseRejectionHandledWarning.
    const result = client.createBank(BANK_ID, BANK_CONFIG);
    const check = expect(result).rejects.toThrow(/500/);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await check;
  });
});
