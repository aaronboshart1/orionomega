/**
 * @module routes/__tests__/auth-utils
 * Tests for request authentication and per-session authorization (Task #231):
 * default-authenticated requests, rejection of unauthenticated requests, and
 * cross-session isolation via session-scoped tokens.
 */

import { describe, it, expect } from 'vitest';
import { checkAuth, isSessionAuthorized } from '../auth-utils.js';
import { generateToken } from '../../auth.js';
import { createMockGetReq, createMockRes } from './test-utils.js';
import type { GatewayConfig } from '../../types.js';
import type { IncomingMessage } from 'node:http';

const SECRET = 'test-signing-secret';

function apiKeyConfig(): GatewayConfig {
  return {
    auth: { mode: 'api-key', keyHash: SECRET },
    cors: { origins: ['*'] },
  } as unknown as GatewayConfig;
}

function noneConfig(): GatewayConfig {
  return {
    auth: { mode: 'none', keyHash: '' },
    cors: { origins: ['*'] },
  } as unknown as GatewayConfig;
}

/** Attach an Authorization header to a mock request (mock headers default to {}). */
function withBearer(req: IncomingMessage, token: string): IncomingMessage {
  (req.headers as Record<string, string>).authorization = `Bearer ${token}`;
  return req;
}

describe('isSessionAuthorized', () => {
  it('allows a master token (no sessionId) for any session', () => {
    expect(isSessionAuthorized({ client: 'web-proxy' }, 'sess-a')).toBe(true);
    expect(isSessionAuthorized({ client: 'web-proxy' }, undefined)).toBe(true);
    expect(isSessionAuthorized(undefined, 'sess-a')).toBe(true);
  });

  it('allows a scoped token only for its own session', () => {
    expect(isSessionAuthorized({ sessionId: 'sess-a' }, 'sess-a')).toBe(true);
  });

  it('rejects a scoped token for a different session', () => {
    expect(isSessionAuthorized({ sessionId: 'sess-a' }, 'sess-b')).toBe(false);
  });

  it('rejects a scoped token when no session is targeted (global route)', () => {
    expect(isSessionAuthorized({ sessionId: 'sess-a' }, undefined)).toBe(false);
  });
});

describe('checkAuth — authentication', () => {
  it('passes through when auth mode is none', () => {
    const { res } = createMockRes();
    const ok = checkAuth(createMockGetReq('/api/sessions'), res, noneConfig());
    expect(ok).toBe(true);
  });

  it('rejects a request with no token (default-authenticated)', () => {
    const { mock, res } = createMockRes();
    const ok = checkAuth(createMockGetReq('/api/sessions'), res, apiKeyConfig());
    expect(ok).toBe(false);
    expect(mock.statusCode).toBe(401);
  });

  it('rejects a request with an invalid token', () => {
    const { mock, res } = createMockRes();
    const req = withBearer(createMockGetReq('/api/sessions'), 'not-a-real-token');
    const ok = checkAuth(req, res, apiKeyConfig());
    expect(ok).toBe(false);
    expect(mock.statusCode).toBe(401);
  });

  it('accepts a valid master token', () => {
    const { res } = createMockRes();
    const token = generateToken({ client: 'web-proxy' }, SECRET);
    const ok = checkAuth(withBearer(createMockGetReq('/api/sessions'), token), res, apiKeyConfig());
    expect(ok).toBe(true);
  });
});

describe('checkAuth — per-session authorization (cross-session isolation)', () => {
  it('lets a master token reach any session', () => {
    const { res } = createMockRes();
    const token = generateToken({ client: 'web-proxy' }, SECRET);
    const ok = checkAuth(
      withBearer(createMockGetReq('/api/sessions/sess-b'), token),
      res,
      apiKeyConfig(),
      'sess-b',
    );
    expect(ok).toBe(true);
  });

  it('lets a scoped token reach its own session', () => {
    const { res } = createMockRes();
    const token = generateToken({ sessionId: 'sess-a' }, SECRET);
    const ok = checkAuth(
      withBearer(createMockGetReq('/api/sessions/sess-a'), token),
      res,
      apiKeyConfig(),
      'sess-a',
    );
    expect(ok).toBe(true);
  });

  it('forbids a scoped token from reaching a different session (403)', () => {
    const { mock, res } = createMockRes();
    const token = generateToken({ sessionId: 'sess-a' }, SECRET);
    const ok = checkAuth(
      withBearer(createMockGetReq('/api/sessions/sess-b'), token),
      res,
      apiKeyConfig(),
      'sess-b',
    );
    expect(ok).toBe(false);
    expect(mock.statusCode).toBe(403);
  });

  it('forbids a scoped token on a global (unscoped) route (403)', () => {
    const { mock, res } = createMockRes();
    const token = generateToken({ sessionId: 'sess-a' }, SECRET);
    const ok = checkAuth(
      withBearer(createMockGetReq('/api/config'), token),
      res,
      apiKeyConfig(),
      undefined,
    );
    expect(ok).toBe(false);
    expect(mock.statusCode).toBe(403);
  });
});
