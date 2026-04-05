import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FeedService } from '../feed-service.js';
import type { SessionManager, Message, Session } from '../../sessions.js';

// Minimal in-memory mock of SessionManager for unit testing.
// Avoids disk I/O and filesystem dependencies.
function createMockSessionManager(): SessionManager {
  const sessions = new Map<string, Session>();

  const mock = {
    getSession(id: string): Session | undefined {
      return sessions.get(id);
    },
    addMessage(sessionId: string, message: Message): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.messages.push(message);
      session.updatedAt = new Date().toISOString();
    },
    // Helper for tests (not part of real SessionManager interface, used internally)
    _createSession(id: string): void {
      const now = new Date().toISOString();
      sessions.set(id, {
        id,
        createdAt: now,
        updatedAt: now,
        messages: [],
        memoryEvents: [],
        activeWorkflows: new Set(),
        clients: new Set(),
      });
    },
  };

  return mock as unknown as SessionManager;
}

// Typed helper for adding test sessions via the mock's internal method
function createTestSession(sm: SessionManager, id: string): void {
  (sm as unknown as { _createSession(id: string): void })._createSession(id);
}

// Helper to build N messages for a session
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

describe('FeedService.getMessages', () => {
  let sm: SessionManager;
  let service: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    service = new FeedService(sm);
    createTestSession(sm, 'sess-1');
  });

  afterEach(() => {
    service.destroy();
  });

  it('returns null for unknown session', () => {
    const result = service.getMessages('no-such-session', { limit: 10, direction: 'before' });
    expect(result).toBeNull();
  });

  it('returns empty data for session with no messages', () => {
    const result = service.getMessages('sess-1', { limit: 10, direction: 'before' });
    expect(result).not.toBeNull();
    expect(result!.data).toHaveLength(0);
    expect(result!.pagination.count).toBe(0);
    expect(result!.pagination.hasMore).toBe(false);
    expect(result!.pagination.oldestCursor).toBeNull();
    expect(result!.pagination.newestCursor).toBeNull();
  });

  it('returns latest messages when no cursor', () => {
    seedMessages(sm, 'sess-1', 100);
    const result = service.getMessages('sess-1', { limit: 10, direction: 'before' });
    expect(result).not.toBeNull();
    expect(result!.data).toHaveLength(10);
    // Last 10 messages: msg-0090 .. msg-0099
    expect(result!.data[0]!.id).toBe('msg-0090');
    expect(result!.data[9]!.id).toBe('msg-0099');
  });

  it('hasMore is true when there are older messages', () => {
    seedMessages(sm, 'sess-1', 100);
    const result = service.getMessages('sess-1', { limit: 10, direction: 'before' });
    expect(result!.pagination.hasMore).toBe(true);
  });

  it('hasMore is false when all messages fit in limit', () => {
    seedMessages(sm, 'sess-1', 5);
    const result = service.getMessages('sess-1', { limit: 50, direction: 'before' });
    expect(result!.pagination.hasMore).toBe(false);
    expect(result!.data).toHaveLength(5);
  });

  it('cursor with direction=before returns older messages', () => {
    seedMessages(sm, 'sess-1', 100);
    // cursor at msg-0050, get 10 before it → msgs 0040..0049
    const result = service.getMessages('sess-1', {
      limit: 10,
      cursor: 'msg-0050',
      direction: 'before',
    });
    expect(result).not.toBeNull();
    expect(result!.data).toHaveLength(10);
    expect(result!.data[0]!.id).toBe('msg-0040');
    expect(result!.data[9]!.id).toBe('msg-0049');
  });

  it('cursor with direction=after returns newer messages', () => {
    seedMessages(sm, 'sess-1', 100);
    // cursor at msg-0050, get 10 after it → msgs 0051..0060
    const result = service.getMessages('sess-1', {
      limit: 10,
      cursor: 'msg-0050',
      direction: 'after',
    });
    expect(result).not.toBeNull();
    expect(result!.data).toHaveLength(10);
    expect(result!.data[0]!.id).toBe('msg-0051');
    expect(result!.data[9]!.id).toBe('msg-0060');
  });

  it('invalid cursor falls back to latest', () => {
    seedMessages(sm, 'sess-1', 20);
    const result = service.getMessages('sess-1', {
      limit: 5,
      cursor: 'no-such-id',
      direction: 'before',
    });
    expect(result).not.toBeNull();
    expect(result!.data).toHaveLength(5);
    // Should return the last 5
    expect(result!.data[4]!.id).toBe('msg-0019');
  });

  it('oldestCursor and newestCursor point to correct messages', () => {
    seedMessages(sm, 'sess-1', 20);
    const result = service.getMessages('sess-1', { limit: 5, direction: 'before' });
    expect(result!.pagination.oldestCursor).toBe(result!.data[0]!.id);
    expect(result!.pagination.newestCursor).toBe(result!.data[4]!.id);
  });

  it('respects limit parameter', () => {
    seedMessages(sm, 'sess-1', 50);
    const result = service.getMessages('sess-1', { limit: 5, direction: 'before' });
    expect(result!.data).toHaveLength(5);
    expect(result!.pagination.limit).toBe(5);
  });
});

describe('FeedService.getMessage', () => {
  let sm: SessionManager;
  let service: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    service = new FeedService(sm);
    createTestSession(sm, 'sess-2');
    seedMessages(sm, 'sess-2', 5);
  });

  afterEach(() => {
    service.destroy();
  });

  it('returns message for valid session and ID', () => {
    const msg = service.getMessage('sess-2', 'msg-0002');
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe('msg-0002');
    expect(msg!.content).toBe('Message 2');
  });

  it('returns null for unknown message ID', () => {
    const msg = service.getMessage('sess-2', 'no-such-message');
    expect(msg).toBeNull();
  });

  it('returns null for unknown session', () => {
    const msg = service.getMessage('no-session', 'msg-0000');
    expect(msg).toBeNull();
  });
});

describe('FeedService.insertMessage', () => {
  let sm: SessionManager;
  let service: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    service = new FeedService(sm);
    createTestSession(sm, 'sess-3');
  });

  afterEach(() => {
    service.destroy();
  });

  it('inserts new message and returns created: true', () => {
    const result = service.insertMessage('sess-3', {
      role: 'user',
      content: 'Hello',
      messageId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.message.content).toBe('Hello');
  });

  it('generates UUID if messageId not provided', () => {
    const result = service.insertMessage('sess-3', { role: 'user', content: 'Auto ID' });
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.message.id).toBeTruthy();
  });

  it('deduplicates by messageId and returns created: false', () => {
    const messageId = '550e8400-e29b-41d4-a716-446655440001';
    service.insertMessage('sess-3', { role: 'user', content: 'First', messageId });
    const result = service.insertMessage('sess-3', { role: 'user', content: 'Second', messageId });
    expect(result).not.toBeNull();
    expect(result!.created).toBe(false);
  });

  it('sets deduplicated flag on duplicate response', () => {
    const messageId = '550e8400-e29b-41d4-a716-446655440002';
    service.insertMessage('sess-3', { role: 'user', content: 'First', messageId });
    const result = service.insertMessage('sess-3', { role: 'user', content: 'Second', messageId });
    expect(result!.message.deduplicated).toBe(true);
  });

  it('returns null for unknown session', () => {
    const result = service.insertMessage('no-session', { role: 'user', content: 'Hello' });
    expect(result).toBeNull();
  });

  it('message appears in subsequent getMessages call', () => {
    service.insertMessage('sess-3', { role: 'user', content: 'Persisted message' });
    const feed = service.getMessages('sess-3', { limit: 10, direction: 'before' });
    expect(feed!.data).toHaveLength(1);
    expect(feed!.data[0]!.content).toBe('Persisted message');
  });

  it('preserves all optional fields (type, metadata, replyToId)', () => {
    const result = service.insertMessage('sess-3', {
      role: 'assistant',
      content: 'Rich message',
      type: 'plan',
      metadata: { key: 'value' },
      replyToId: 'parent-msg-id',
    });
    expect(result).not.toBeNull();
    expect(result!.message.type).toBe('plan');
    expect(result!.message.metadata).toEqual({ key: 'value' });
    expect(result!.message.replyToId).toBe('parent-msg-id');
  });
});

describe('FeedService.getMessageCount', () => {
  let sm: SessionManager;
  let service: FeedService;

  beforeEach(() => {
    sm = createMockSessionManager();
    service = new FeedService(sm);
    createTestSession(sm, 'sess-4');
  });

  afterEach(() => {
    service.destroy();
  });

  it('returns 0 for empty session', () => {
    expect(service.getMessageCount('sess-4')).toBe(0);
  });

  it('returns correct count after inserts', () => {
    seedMessages(sm, 'sess-4', 7);
    expect(service.getMessageCount('sess-4')).toBe(7);
  });

  it('returns null for unknown session', () => {
    expect(service.getMessageCount('no-session')).toBeNull();
  });
});
