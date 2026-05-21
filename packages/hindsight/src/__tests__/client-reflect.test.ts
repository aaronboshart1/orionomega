/**
 * Unit tests for HindsightClient.reflect().
 *
 * Mocks global.fetch so no running server is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HindsightClient } from '../client.js';
import { HindsightError } from '../errors.js';

const BASE_URL = 'http://test-server';

function makeOkFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function makeErrorFetch(status: number, errorBody?: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: `Error ${status}`,
    json: async () => errorBody ?? { error: `HTTP error ${status}` },
  } as unknown as Response);
}

function parseBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('HindsightClient.reflect()', () => {
  let client: HindsightClient;

  beforeEach(() => {
    client = new HindsightClient(BASE_URL);
  });

  it('POSTs to the correct endpoint', async () => {
    const fetchMock = makeOkFetch({ answer: 'test answer' });
    global.fetch = fetchMock;

    await client.reflect('my-bank', 'What patterns do we use?');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/default/banks/my-bank/reflect`);
    expect(init.method).toBe('POST');
  });

  it('includes query in request body', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'What architecture do we use?');

    expect(parseBody(fetchMock).query).toBe('What architecture do we use?');
  });

  it('uses mid as default budget', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'query');

    expect(parseBody(fetchMock).budget).toBe('mid');
  });

  it('forwards budget option to request body', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'query', { budget: 'high' });

    expect(parseBody(fetchMock).budget).toBe('high');
  });

  it('forwards maxTokens as max_tokens in request body', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'query', { maxTokens: 2048 });

    expect(parseBody(fetchMock).max_tokens).toBe(2048);
  });

  it('forwards tags to request body', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'query', { tags: ['session:abc', 'project:foo'] });

    expect(parseBody(fetchMock).tags).toEqual(['session:abc', 'project:foo']);
  });

  it('forwards tags_match to request body', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'query', { tags: ['session:abc'], tags_match: 'all' });

    expect(parseBody(fetchMock).tags_match).toBe('all');
  });

  it('forwards responseSchema as response_schema in request body', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok', structured_output: { key: 'val' } });
    global.fetch = fetchMock;

    const schema = { type: 'object', properties: { decision: { type: 'string' } } };
    await client.reflect('bank', 'query', { responseSchema: schema });

    expect(parseBody(fetchMock).response_schema).toEqual(schema);
  });

  it('parses answer from response', async () => {
    global.fetch = makeOkFetch({ answer: 'Use dependency injection pattern' });

    const result = await client.reflect('bank', 'query');

    expect(result.answer).toBe('Use dependency injection pattern');
  });

  it('parses structured_output from response', async () => {
    global.fetch = makeOkFetch({ answer: 'ok', structured_output: { decision: 'yes', confidence: 0.9 } });

    const result = await client.reflect('bank', 'query');

    expect(result.structured_output).toEqual({ decision: 'yes', confidence: 0.9 });
  });

  it('returns empty string answer when response lacks answer field', async () => {
    global.fetch = makeOkFetch({});

    const result = await client.reflect('bank', 'query');

    expect(result.answer).toBe('');
  });

  it('uses custom namespace in endpoint URL', async () => {
    const nsClient = new HindsightClient(BASE_URL, 'my-ns');
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await nsClient.reflect('project-bank', 'query');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/my-ns/banks/project-bank/reflect`);
  });

  it('throws HindsightError on network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    await expect(client.reflect('bank', 'query')).rejects.toBeInstanceOf(HindsightError);
  });

  it('throws HindsightError on 404 response', async () => {
    global.fetch = makeErrorFetch(404);

    await expect(client.reflect('bank', 'query')).rejects.toBeInstanceOf(HindsightError);
  });

  it('throws HindsightError on 501 response', async () => {
    global.fetch = makeErrorFetch(501);

    await expect(client.reflect('bank', 'query')).rejects.toBeInstanceOf(HindsightError);
  });

  it('error carries correct statusCode for 404', async () => {
    global.fetch = makeErrorFetch(404);

    const err = await client.reflect('bank', 'query').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HindsightError);
    expect((err as HindsightError).statusCode).toBe(404);
  });

  it('does not include response_schema when not specified', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'query');

    expect(parseBody(fetchMock).response_schema).toBeUndefined();
  });

  it('does not include tags when not specified', async () => {
    const fetchMock = makeOkFetch({ answer: 'ok' });
    global.fetch = fetchMock;

    await client.reflect('bank', 'query');

    const body = parseBody(fetchMock);
    expect(body.tags).toBeUndefined();
    expect(body.tags_match).toBeUndefined();
  });
});
