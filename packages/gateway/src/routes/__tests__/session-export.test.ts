/**
 * @module __tests__/session-export
 * Regression tests for Task #193 — `GET /api/sessions/:id/export` must
 * return the snapshot JSON with an attachment Content-Disposition for
 * existing sessions and 404 for unknown sessions. Covers both the
 * handler in isolation and the router pattern wired into server.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { closeDb, getDb } from '@orionomega/core';
import { PersistenceService } from '../../persistence.js';
import { SessionManager } from '../../sessions.js';
import { handleExportSession, SESSION_EXPORT_ROUTE } from '../sessions.js';
import { createMockGetReq, createMockRes } from './test-utils.js';

let originalHome: string | undefined;

function setupDb(): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'orion-export-'));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  closeDb();
  getDb();
  return homeDir;
}

function teardownDb(homeDir: string): void {
  closeDb();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('handleExportSession (handler-level)', () => {
  let homeDir: string;
  let persistence: PersistenceService;
  let sessionManager: SessionManager;
  const sid = 'sess-export-1';

  beforeEach(() => {
    homeDir = setupDb();
    persistence = new PersistenceService();
    sessionManager = new SessionManager(persistence);
    persistence.createSession(sid);
    persistence.appendMessage(sid, {
      id: 'm1', role: 'user', content: 'hello', status: 'text',
    });
  });

  afterEach(() => {
    teardownDb(homeDir);
  });

  it('returns 200 with snapshot JSON and attachment Content-Disposition', () => {
    const req = createMockGetReq(`/api/sessions/${sid}/export`);
    const { mock, res } = createMockRes();

    handleExportSession(req, res, persistence, sessionManager, sid);

    expect(mock.statusCode).toBe(200);
    expect(mock.headers['content-type']).toMatch(/application\/json/);
    expect(mock.headers['content-disposition']).toMatch(/^attachment; filename="orionomega-.*\.json"$/);

    const body = JSON.parse(mock.body);
    expect(body.sessionId).toBe(sid);
    expect(body.session?.id).toBe(sid);
    expect(Array.isArray(body.session?.messages)).toBe(true);
    expect(body.session.messages[0]?.id).toBe('m1');
    expect(typeof body.exportedAt).toBe('string');
  });

  it('returns 404 for an unknown session id', () => {
    const req = createMockGetReq('/api/sessions/no-such-session/export');
    const { mock, res } = createMockRes();

    handleExportSession(req, res, persistence, sessionManager, 'no-such-session');

    expect(mock.statusCode).toBe(404);
    const body = JSON.parse(mock.body);
    expect(body.error).toMatch(/not found/i);
  });
});

/**
 * Router-level integration: spin up a real `http.Server` whose router
 * mirrors the wiring in `packages/gateway/src/server.ts` for
 * `/api/sessions/:id/export`, using the SAME exported route regex
 * (`SESSION_EXPORT_ROUTE`) and the SAME pattern as the bare
 * `/api/sessions/:id` matcher. The bare-id matcher is included so the
 * test catches any regression where it accidentally swallows `/export`.
 *
 * Auth model: matches the sibling session routes in `server.ts`, which
 * have no per-route auth gate beyond the global `rateLimitRest` /
 * `setSecurityHeaders` / `setCorsHeaders` middleware. We re-enforce
 * that contract here by asserting the route returns 200 with no auth
 * headers attached, exactly like `GET /api/sessions/:id`.
 */
describe('GET /api/sessions/:id/export (router-level)', () => {
  let homeDir: string;
  let persistence: PersistenceService;
  let sessionManager: SessionManager;
  let server: Server;
  let baseUrl: string;
  const sid = 'sess-router-1';

  beforeEach(async () => {
    homeDir = setupDb();
    persistence = new PersistenceService();
    sessionManager = new SessionManager(persistence);
    persistence.createSession(sid);
    persistence.appendMessage(sid, {
      id: 'r1', role: 'user', content: 'hi from router', status: 'text',
    });

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      const rawUrl = req.url ?? '/';
      const method = req.method ?? 'GET';
      const pathname = rawUrl.split('?')[0]!.replace(/\/+$/, '') || '/';

      // Strict-id matcher mirroring server.ts; anchored, so /export must
      // NOT fall through to it. If it did, the export request would 404.
      const sessionMatch = pathname.match(/^\/api\/sessions\/([a-z0-9_-]+)$/);
      if (sessionMatch && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: sessionMatch[1]! }));
        return;
      }

      const exportMatch = pathname.match(SESSION_EXPORT_ROUTE);
      if (exportMatch && method === 'GET') {
        handleExportSession(req, res, persistence, sessionManager, exportMatch[1]!);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    };

    server = createServer(handler);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    teardownDb(homeDir);
  });

  it('routes /api/sessions/:id/export to the export handler (200, attachment, JSON snapshot)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions/${sid}/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="orionomega-.*\.json"$/);
    const body = await r.json() as { sessionId: string; session: { id: string; messages: Array<{ id: string }> } };
    expect(body.sessionId).toBe(sid);
    expect(body.session.id).toBe(sid);
    expect(body.session.messages[0]?.id).toBe('r1');
  });

  it('returns 404 (not the bare-session 200) for an unknown session id', async () => {
    const r = await fetch(`${baseUrl}/api/sessions/no-such-session/export`);
    expect(r.status).toBe(404);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it('the bare /api/sessions/:id matcher does NOT swallow the /export suffix', async () => {
    // Sanity check: the strict-id route works on its own…
    const bare = await fetch(`${baseUrl}/api/sessions/${sid}`);
    expect(bare.status).toBe(200);
    const bareBody = await bare.json() as { id: string };
    expect(bareBody.id).toBe(sid);

    // …and the export route returns the export payload, not the bare-id payload.
    const exp = await fetch(`${baseUrl}/api/sessions/${sid}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('matches sibling session-route auth contract (no per-route auth headers required)', async () => {
    // Sibling routes (handleGetSession, handleListSessions, etc.) are not
    // gated by per-route auth in server.ts — they rely on the global
    // middleware chain. The export route follows the same contract: an
    // unauthenticated request reaches the handler and gets 200.
    const r = await fetch(`${baseUrl}/api/sessions/${sid}/export`, {
      headers: {}, // no Authorization, no API key
    });
    expect(r.status).toBe(200);
  });
});
