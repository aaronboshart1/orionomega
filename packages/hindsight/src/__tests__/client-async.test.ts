/**
 * Unit tests for async retain option and item metadata forwarding
 * in HindsightClient.retain().
 *
 * Mocks global.fetch so no running server is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HindsightClient } from '../client.js';
import type { MemoryItem } from '../types.js';

const BASE_URL = 'http://test-server';

function makeRetainFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, bank_id: 'bank', items_count: 1 }),
  } as unknown as Response);
}

function getRetainBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    content: 'test content',
    context: 'decision',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('HindsightClient.retain() — async option', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('includes async: true in body when opts.async is true', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem()], { async: true });

    expect(getRetainBody(fetchMock).async).toBe(true);
  });

  it('does NOT include async in body when opts not provided', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem()]);

    expect(getRetainBody(fetchMock).async).toBeUndefined();
  });

  it('does NOT include async in body when opts.async is false', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem()], { async: false });

    expect(getRetainBody(fetchMock).async).toBeUndefined();
  });

  it('POSTs to the correct endpoint', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('my-bank', [makeItem()]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/default/banks/my-bank/memories`);
    expect(init.method).toBe('POST');
  });
});

describe('HindsightClient.retain() — item metadata forwarding', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('forwards document_id to retained item', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem({ document_id: 'doc-abc-123' })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].document_id).toBe('doc-abc-123');
  });

  it('forwards importance to retained item', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem({ importance: 0.85 })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].importance).toBe(0.85);
  });

  it('forwards metadata to retained item', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    const metadata = { workflowId: 'wf-123', nodeId: 'node-5' };
    await client.retain('bank', [makeItem({ metadata })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].metadata).toEqual(metadata);
  });

  it('forwards tags to retained item', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [makeItem({ tags: ['session:s1', 'project:myrepo'] })]);

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0].tags).toEqual(['session:s1', 'project:myrepo']);
  });

  it('retains multiple items in a single request', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain('bank', [
      makeItem({ content: 'Memory A', document_id: 'doc-A' }),
      makeItem({ content: 'Memory B', document_id: 'doc-B' }),
    ]);

    const items = (getRetainBody(fetchMock).items as Array<Record<string, unknown>>);
    expect(items).toHaveLength(2);
    expect(items[0].document_id).toBe('doc-A');
    expect(items[1].document_id).toBe('doc-B');
  });

  it('can combine async with document_id and metadata', async () => {
    const fetchMock = makeRetainFetch();
    global.fetch = fetchMock;

    await client.retain(
      'bank',
      [makeItem({
        document_id: 'doc-xyz',
        importance: 0.9,
        metadata: { sessionId: 'sess-1' },
      })],
      { async: true },
    );

    const body = getRetainBody(fetchMock);
    const items = body.items as Array<Record<string, unknown>>;
    expect(body.async).toBe(true);
    expect(items[0].document_id).toBe('doc-xyz');
    expect(items[0].importance).toBe(0.9);
    expect(items[0].metadata).toEqual({ sessionId: 'sess-1' });
  });
});
