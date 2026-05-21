/**
 * Unit tests verifying that HindsightClient forwards the `types` parameter
 * (and tags/tags_match) to the Hindsight API recall endpoint.
 *
 * Mocks global.fetch so no running server is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HindsightClient } from '../client.js';

const BASE_URL = 'http://test-server';

function makeRecallFetch(results: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ results }),
  } as unknown as Response);
}

function getCallBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('HindsightClient.recall() — types parameter', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('forwards types array to request body', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recall('bank', 'query', {
      types: ['world', 'experience', 'observation'],
    });

    expect(getCallBody(fetchMock).types).toEqual(['world', 'experience', 'observation']);
  });

  it('does not include types when not specified', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recall('bank', 'query');

    expect(getCallBody(fetchMock).types).toBeUndefined();
  });

  it('forwards a partial types array', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recall('bank', 'query', { types: ['observation'] });

    expect(getCallBody(fetchMock).types).toEqual(['observation']);
  });

  it('forwards tags to request body', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recall('bank', 'query', {
      tags: ['session:xyz', 'project:myrepo'],
    });

    expect(getCallBody(fetchMock).tags).toEqual(['session:xyz', 'project:myrepo']);
  });

  it('forwards tags_match to request body when tags are set', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recall('bank', 'query', {
      tags: ['project:foo'],
      tags_match: 'all',
    });

    const body = getCallBody(fetchMock);
    expect(body.tags).toEqual(['project:foo']);
    expect(body.tags_match).toBe('all');
  });

  it('does not include tags_match when tags are not set', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recall('bank', 'query');

    const body = getCallBody(fetchMock);
    expect(body.tags).toBeUndefined();
    expect(body.tags_match).toBeUndefined();
  });

  it('can set types alongside tags', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recall('bank', 'query', {
      types: ['world', 'experience', 'observation'],
      tags: ['session:abc'],
      tags_match: 'any',
    });

    const body = getCallBody(fetchMock);
    expect(body.types).toEqual(['world', 'experience', 'observation']);
    expect(body.tags).toEqual(['session:abc']);
    expect(body.tags_match).toBe('any');
  });
});

describe('HindsightClient.recallWithTemporalDiversity() — types forwarding', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('forwards types to the primary recall request', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recallWithTemporalDiversity('bank', 'query', {
      types: ['world', 'experience', 'observation'],
    });

    // Primary recall is always the first fetch call
    expect(getCallBody(fetchMock, 0).types).toEqual(['world', 'experience', 'observation']);
  });

  it('forwards types to all temporal-diversity recall requests', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    // Use maxTokens=2000 to ensure temporal diversity buckets are generated
    await client.recallWithTemporalDiversity('bank', 'query', {
      types: ['world', 'experience', 'observation'],
      maxTokens: 2000,
    });

    // All calls (primary + temporal buckets) must include types
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      expect(getCallBody(fetchMock, i).types).toEqual(['world', 'experience', 'observation']);
    }
  });

  it('does not set types when not provided', async () => {
    const fetchMock = makeRecallFetch();
    global.fetch = fetchMock;

    await client.recallWithTemporalDiversity('bank', 'query');

    expect(getCallBody(fetchMock, 0).types).toBeUndefined();
  });
});
