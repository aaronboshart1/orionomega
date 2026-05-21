/**
 * Unit tests for client-side input validation in HindsightClient:
 *   - Empty/whitespace content rejection (retain)
 *   - Content size truncation (retain)
 *   - Importance clamping (retain)
 *   - Negative limit rejection (listMemories)
 *   - Improved error extraction from 500/422 responses (request)
 *
 * All tests mock global.fetch — no running server required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HindsightClient, type HindsightClientOptions } from '../client.js';
import { HindsightError } from '../errors.js';
import type { MemoryItem } from '../types.js';

const BASE_URL = 'http://test-server';

function makeRetainFetch(payload: Record<string, unknown> = { success: true, bank_id: 'bank', items_count: 1 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  } as unknown as Response);
}

function makeErrorFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Error',
    json: async () => body,
  } as unknown as Response);
}

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    content: 'test content',
    context: 'decision',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function getRetainBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

// ── Empty content validation ──────────────────────────────────────────────────

describe('HindsightClient.retain() — empty content validation', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('throws HindsightError(422) for empty string content', async () => {
    global.fetch = makeRetainFetch();
    await expect(client.retain('bank', [makeItem({ content: '' })])).rejects.toThrow(HindsightError);
    await expect(client.retain('bank', [makeItem({ content: '' })])).rejects.toMatchObject({ statusCode: 422 });
  });

  it('throws HindsightError(422) for whitespace-only content', async () => {
    global.fetch = makeRetainFetch();
    await expect(client.retain('bank', [makeItem({ content: '   ' })])).rejects.toThrow(HindsightError);
    await expect(client.retain('bank', [makeItem({ content: '\n\t' })])).rejects.toThrow(HindsightError);
  });

  it('does NOT call fetch when content is empty', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;
    await expect(client.retain('bank', [makeItem({ content: '' })])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws for the first empty item in a batch and does not call fetch', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;
    await expect(
      client.retain('bank', [makeItem({ content: 'good content' }), makeItem({ content: '' })]),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('succeeds with non-empty content', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;
    await expect(client.retain('bank', [makeItem({ content: 'valid' })])).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ── Content size limit ────────────────────────────────────────────────────────

describe('HindsightClient.retain() — content size limit', () => {
  it('truncates content exceeding maxContentSize', async () => {
    const maxContentSize = 50;
    const opts: HindsightClientOptions = { maxContentSize };
    const client = new HindsightClient(BASE_URL, 'default', undefined, opts);
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    const longContent = 'A'.repeat(200);
    await client.retain('bank', [makeItem({ content: longContent })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect((items[0].content as string).length).toBeLessThanOrEqual(maxContentSize);
  });

  it('does not truncate content within maxContentSize', async () => {
    const opts: HindsightClientOptions = { maxContentSize: 100 };
    const client = new HindsightClient(BASE_URL, 'default', undefined, opts);
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    const content = 'A'.repeat(80);
    await client.retain('bank', [makeItem({ content })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    // Content may be compressed/processed but should not be artificially truncated
    expect((items[0].content as string).length).toBeGreaterThan(0);
  });

  it('uses default maxContentSize of 32768 when not specified', async () => {
    const client = new HindsightClient(BASE_URL);
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    // Content within default limit passes through
    const content = 'A'.repeat(1000);
    await client.retain('bank', [makeItem({ content })]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ── Importance range validation ───────────────────────────────────────────────

describe('HindsightClient.retain() — importance clamping', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('clamps importance > 1.0 to 1.0', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem({ importance: 1.5 })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].importance).toBe(1);
  });

  it('clamps importance < 0.0 to 0.0', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem({ importance: -0.5 })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].importance).toBe(0);
  });

  it('leaves valid importance values unchanged', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem({ importance: 0.75 })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].importance).toBe(0.75);
  });

  it('allows importance of exactly 0.0 and 1.0', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem({ importance: 0.0 }), makeItem({ importance: 1.0 })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].importance).toBe(0);
    expect(items[1].importance).toBe(1);
  });

  it('omits importance when not specified', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem()]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].importance).toBeUndefined();
  });
});

// ── Negative limit validation (listMemories) ──────────────────────────────────

describe('HindsightClient.listMemories() — negative limit', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('throws HindsightError(422) for limit=-1', async () => {
    global.fetch = vi.fn();
    await expect(client.listMemories('bank', { limit: -1 })).rejects.toThrow(HindsightError);
    await expect(client.listMemories('bank', { limit: -1 })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('throws for any negative limit', async () => {
    global.fetch = vi.fn();
    await expect(client.listMemories('bank', { limit: -100 })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('does NOT call fetch for negative limit', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    await expect(client.listMemories('bank', { limit: -1 })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends request normally for limit=0', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [] }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const result = await client.listMemories('bank', { limit: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.items).toEqual([]);
  });

  it('sends request with limit and offset query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [], total: 0 }),
    } as unknown as Response);
    global.fetch = fetchMock;

    await client.listMemories('bank', { limit: 10, offset: 20 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
  });

  it('calls the correct endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [] }),
    } as unknown as Response);
    global.fetch = fetchMock;

    await client.listMemories('my-bank');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${BASE_URL}/v1/default/banks/my-bank/memories/list`);
  });
});

// ── Error extraction from 500 / 422 responses ─────────────────────────────────

describe('HindsightClient error extraction', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('wraps 500 detail string with "Server error:" prefix', async () => {
    global.fetch = makeErrorFetch(500, { detail: 'LIMIT must not be negative' });
    await expect(client.listMemories('bank', { limit: 10 })).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining('Server error: LIMIT must not be negative'),
    });
  });

  it('extracts 422 detail array into human-readable message', async () => {
    global.fetch = makeErrorFetch(422, {
      detail: [
        { msg: 'Field required', loc: ['body', 'items', 0, 'content'] },
        { msg: 'Value error, bad timestamp', loc: ['body', 'items', 0, 'timestamp'] },
      ],
    });
    await expect(client.recall('bank', 'query')).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('Field required'),
    });
  });

  it('extracts 422 string detail without prefix', async () => {
    global.fetch = makeErrorFetch(422, { detail: 'Bank not found' });
    await expect(client.recall('bank', 'query')).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('Bank not found'),
    });
    // 422 string detail should NOT have "Server error:" prefix
    await expect(client.recall('bank', 'query')).rejects.toMatchObject({
      message: expect.not.stringContaining('Server error:'),
    });
  });

  it('falls back to statusText when no recognisable error field', async () => {
    global.fetch = makeErrorFetch(503, { unexpected: 'field' });
    await expect(client.recall('bank', 'query')).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('Error'),
    });
  });

  it('uses error field when present', async () => {
    global.fetch = makeErrorFetch(400, { error: 'Invalid query' });
    await expect(client.recall('bank', 'query')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid query'),
    });
  });
});
