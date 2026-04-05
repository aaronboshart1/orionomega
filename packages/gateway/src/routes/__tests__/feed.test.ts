import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FeedService } from '../../feed/feed-service.js';
import {
  handleGetFeed,
  handleGetFeedMessage,
  handlePostFeedMessage,
  handleGetFeedCount,
} from '../feed.js';
import {
  createMockGetReq,
  createMockPostReq,
  createOversizedReq,
  createMockRes,
  createMockSessionManager,
  createTestSession,
} from './test-utils.js';
import type { SessionManager, Message } from '../../sessions.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function seedMessages(sm: SessionManager, sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const msg: Message = {
      id: `msg-${String(i).padStart(4, '0')}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    };
    sm.addMessage(sessionId, msg);
  }
}

describe('handleGetFeed', () => {
  let sm: SessionManager;
  let feedService: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    feedService = new FeedService(sm);
    createTestSession(sm, 'test-session');
  });

  afterEach(() => {
    feedService.destroy();
  });

  it('returns 200 with messages', () => {
    seedMessages(sm, 'test-session', 5);
    const req = createMockGetReq('/api/sessions/test-session/feed');
    const { mock, res } = createMockRes();
    handleGetFeed(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(200);
    const body = JSON.parse(mock.body);
    expect(body.sessionId).toBe('test-session');
    expect(body.data).toHaveLength(5);
    expect(body.pagination).toBeDefined();
  });

  it('returns 404 for unknown session', () => {
    const req = createMockGetReq('/api/sessions/no-session/feed');
    const { mock, res } = createMockRes();
    handleGetFeed(req, res, feedService, 'no-session');
    expect(mock.statusCode).toBe(404);
  });

  it('respects limit query param', () => {
    seedMessages(sm, 'test-session', 20);
    const req = createMockGetReq('/api/sessions/test-session/feed?limit=5');
    const { mock, res } = createMockRes();
    handleGetFeed(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(200);
    const body = JSON.parse(mock.body);
    expect(body.data).toHaveLength(5);
  });

  it('paginates correctly with cursor', () => {
    seedMessages(sm, 'test-session', 20);
    // First page: last 5 messages (msg-0015..msg-0019)
    const firstReq = createMockGetReq('/api/sessions/test-session/feed?limit=5');
    const { mock: firstMock, res: firstRes } = createMockRes();
    handleGetFeed(firstReq, firstRes, feedService, 'test-session');
    const firstBody = JSON.parse(firstMock.body);
    const oldestCursor = firstBody.pagination.oldestCursor;

    // Second page: 5 messages before oldestCursor
    const req = createMockGetReq(
      `/api/sessions/test-session/feed?limit=5&cursor=${oldestCursor}&direction=before`,
    );
    const { mock, res } = createMockRes();
    handleGetFeed(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(200);
    const body = JSON.parse(mock.body);
    expect(body.data).toHaveLength(5);
    // Should be messages msg-0010..msg-0014
    expect(body.data[0]!.id).toBe('msg-0010');
  });

  it('direction=after returns newer messages', () => {
    seedMessages(sm, 'test-session', 20);
    // Use msg-0010 as cursor, get 3 newer
    const req = createMockGetReq(
      '/api/sessions/test-session/feed?limit=3&cursor=msg-0010&direction=after',
    );
    const { mock, res } = createMockRes();
    handleGetFeed(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(200);
    const body = JSON.parse(mock.body);
    expect(body.data).toHaveLength(3);
    expect(body.data[0]!.id).toBe('msg-0011');
  });

  it('returns 400 for invalid limit', () => {
    const req = createMockGetReq('/api/sessions/test-session/feed?limit=-1');
    const { mock, res } = createMockRes();
    handleGetFeed(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(400);
    const body = JSON.parse(mock.body);
    expect(body.error).toBe('Invalid query parameters');
  });
});

describe('handlePostFeedMessage', () => {
  let sm: SessionManager;
  let feedService: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    feedService = new FeedService(sm);
    createTestSession(sm, 'test-session');
  });

  afterEach(() => {
    feedService.destroy();
  });

  it('returns 201 for new message', async () => {
    const body = JSON.stringify({ role: 'user', content: 'Hello', messageId: VALID_UUID });
    const req = createMockPostReq('/api/sessions/test-session/feed/messages', body);
    const { mock, res } = createMockRes();
    await handlePostFeedMessage(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(201);
    const responseBody = JSON.parse(mock.body);
    expect(responseBody.created).toBe(true);
    expect(responseBody.message.content).toBe('Hello');
  });

  it('returns 200 for duplicate message', async () => {
    const msgId = '550e8400-e29b-41d4-a716-446655440001';
    const body = JSON.stringify({ role: 'user', content: 'Hello', messageId: msgId });
    const req1 = createMockPostReq('/api/sessions/test-session/feed/messages', body);
    const { res: res1 } = createMockRes();
    await handlePostFeedMessage(req1, res1, feedService, 'test-session');

    const req2 = createMockPostReq('/api/sessions/test-session/feed/messages', body);
    const { mock: mock2, res: res2 } = createMockRes();
    await handlePostFeedMessage(req2, res2, feedService, 'test-session');
    expect(mock2.statusCode).toBe(200);
    const responseBody = JSON.parse(mock2.body);
    expect(responseBody.created).toBe(false);
  });

  it('sets X-Deduplicated header on duplicate', async () => {
    const msgId = '550e8400-e29b-41d4-a716-446655440002';
    const body = JSON.stringify({ role: 'user', content: 'Hello', messageId: msgId });
    const req1 = createMockPostReq('/api/sessions/test-session/feed/messages', body);
    const { res: res1 } = createMockRes();
    await handlePostFeedMessage(req1, res1, feedService, 'test-session');

    const req2 = createMockPostReq('/api/sessions/test-session/feed/messages', body);
    const { mock: mock2, res: res2 } = createMockRes();
    await handlePostFeedMessage(req2, res2, feedService, 'test-session');
    expect(mock2.headers['x-deduplicated']).toBe('true');
  });

  it('returns 400 for missing role', async () => {
    const body = JSON.stringify({ content: 'Hello' });
    const req = createMockPostReq('/api/sessions/test-session/feed/messages', body);
    const { mock, res } = createMockRes();
    await handlePostFeedMessage(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(400);
  });

  it('returns 400 for empty content', async () => {
    const body = JSON.stringify({ role: 'user', content: '' });
    const req = createMockPostReq('/api/sessions/test-session/feed/messages', body);
    const { mock, res } = createMockRes();
    await handlePostFeedMessage(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(400);
  });

  it('returns 413 for oversized body', async () => {
    const req = createOversizedReq('/api/sessions/test-session/feed/messages', 1_048_577);
    const { mock, res } = createMockRes();
    await handlePostFeedMessage(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(413);
  });
});

describe('handleGetFeedMessage', () => {
  let sm: SessionManager;
  let feedService: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    feedService = new FeedService(sm);
    createTestSession(sm, 'test-session');
    seedMessages(sm, 'test-session', 5);
  });

  afterEach(() => {
    feedService.destroy();
  });

  it('returns 200 for existing message', () => {
    const req = createMockGetReq('/api/sessions/test-session/feed/messages/msg-0002');
    const { mock, res } = createMockRes();
    handleGetFeedMessage(req, res, feedService, 'test-session', 'msg-0002');
    expect(mock.statusCode).toBe(200);
    const body = JSON.parse(mock.body);
    expect(body.message.id).toBe('msg-0002');
  });

  it('returns 404 for unknown message', () => {
    const req = createMockGetReq('/api/sessions/test-session/feed/messages/no-such-msg');
    const { mock, res } = createMockRes();
    handleGetFeedMessage(req, res, feedService, 'test-session', 'no-such-msg');
    expect(mock.statusCode).toBe(404);
  });
});

describe('handleGetFeedCount', () => {
  let sm: SessionManager;
  let feedService: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    feedService = new FeedService(sm);
    createTestSession(sm, 'test-session');
  });

  afterEach(() => {
    feedService.destroy();
  });

  it('returns correct count', () => {
    seedMessages(sm, 'test-session', 12);
    const req = createMockGetReq('/api/sessions/test-session/feed/count');
    const { mock, res } = createMockRes();
    handleGetFeedCount(req, res, feedService, 'test-session');
    expect(mock.statusCode).toBe(200);
    const body = JSON.parse(mock.body);
    expect(body.count).toBe(12);
    expect(body.sessionId).toBe('test-session');
  });

  it('returns 404 for unknown session', () => {
    const req = createMockGetReq('/api/sessions/no-session/feed/count');
    const { mock, res } = createMockRes();
    handleGetFeedCount(req, res, feedService, 'no-session');
    expect(mock.statusCode).toBe(404);
  });
});
