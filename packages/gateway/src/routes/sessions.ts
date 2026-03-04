/**
 * @module routes/sessions
 * REST endpoints for session management.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionManager } from '../sessions.js';

/**
 * Handle GET /api/sessions — list all sessions.
 */
export function handleListSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
): void {
  const sessions = sessionManager.listSessions().map((s) => sessionManager.toJSON(s));
  const body = JSON.stringify({ sessions });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Handle GET /api/sessions/:id — get session detail.
 */
export function handleGetSession(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  sessionId: string,
): void {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const body = JSON.stringify(sessionManager.toJSON(session));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Handle POST /api/sessions — create a new session.
 */
export function handleCreateSession(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
): void {
  const session = sessionManager.createSession();
  const body = JSON.stringify(sessionManager.toJSON(session));
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(body);
}
