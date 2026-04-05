/**
 * Test utilities for route handler testing.
 * Creates minimal mock IncomingMessage and ServerResponse objects.
 */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionManager, Message, Session } from '../../sessions.js';

// ─── Mock Request ───────────────────────────────────────────────────────────

/**
 * Create a mock IncomingMessage for GET requests (no body).
 */
export function createMockGetReq(url: string): IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(null); // immediately end the stream
  return Object.assign(readable, {
    url,
    method: 'GET',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

/**
 * Create a mock IncomingMessage for POST requests with a JSON body.
 */
export function createMockPostReq(url: string, body: string): IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(Buffer.from(body, 'utf-8'));
  readable.push(null);
  return Object.assign(readable, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

/**
 * Create a mock IncomingMessage that streams an oversized body (triggers 413).
 */
export function createOversizedReq(url: string, sizeBytes: number): IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(Buffer.alloc(sizeBytes, 'x'));
  readable.push(null);
  return Object.assign(readable, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

// ─── Mock Response ──────────────────────────────────────────────────────────

export interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Create a mock ServerResponse that captures writeHead/end calls.
 * Returns the mock along with a typed ServerResponse cast.
 */
export function createMockRes(): { mock: MockResponse; res: ServerResponse } {
  const mock: MockResponse = {
    statusCode: 0,
    headers: {},
    body: '',
  };

  const res = {
    writeHead(code: number, hdrs?: Record<string, string>): void {
      mock.statusCode = code;
      if (hdrs) {
        for (const [key, value] of Object.entries(hdrs)) {
          mock.headers[key.toLowerCase()] = value;
        }
      }
    },
    end(data = ''): void {
      mock.body = data;
    },
    setHeader(name: string, value: string): void {
      mock.headers[name.toLowerCase()] = value;
    },
  };

  return { mock, res: res as unknown as ServerResponse };
}

// ─── Mock SessionManager ────────────────────────────────────────────────────

/**
 * Creates a minimal in-memory mock SessionManager for route integration tests.
 */
export function createMockSessionManager(): SessionManager {
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

export function createTestSession(sm: SessionManager, id: string): void {
  (sm as unknown as { _createSession(id: string): void })._createSession(id);
}
