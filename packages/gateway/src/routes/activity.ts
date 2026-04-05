/**
 * @module routes/activity
 * REST endpoints for session activity log persistence.
 *
 *   POST /api/sessions/:id/activity  — log a custom action
 *   GET  /api/sessions/:id/activity  — fetch paginated activity history
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActivityService } from '../activity.js';
import type { SessionManager } from '../sessions.js';
import { readBody } from './utils.js';

/**
 * POST /api/sessions/:id/activity
 *
 * Body (JSON): { action: string, data?: object, actor?: string }
 *
 * Logs a custom activity entry for a session. Useful for client-side actions
 * that want a server-side audit trail (e.g. UI button clicks, settings opens).
 *
 * Returns 201 with the persisted entry, or 400/404 on validation errors.
 */
export async function handleLogActivity(
  req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  activityService: ActivityService,
  sessionId: string,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  let body: string;
  try {
    body = await readBody(req, 65_536); // 64 KB limit for activity payloads
  } catch {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body too large' }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Body must be a JSON object' }));
    return;
  }

  const payload = parsed as Record<string, unknown>;

  if (typeof payload.action !== 'string' || payload.action.trim().length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid "action" field (must be a non-empty string)' }));
    return;
  }

  const action = payload.action.trim().slice(0, 128); // cap action name length

  // Validate optional data field
  let data: Record<string, unknown> | undefined;
  if (payload.data !== undefined) {
    if (typeof payload.data !== 'object' || payload.data === null || Array.isArray(payload.data)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '"data" must be a JSON object when provided' }));
      return;
    }
    data = payload.data as Record<string, unknown>;
  }

  // Validate optional actor field
  let actor: string | undefined;
  if (payload.actor !== undefined) {
    if (typeof payload.actor !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '"actor" must be a string when provided' }));
      return;
    }
    actor = payload.actor.slice(0, 256);
  }

  // Fall back to remote address if actor not supplied
  const resolvedActor = actor ?? req.socket.remoteAddress ?? undefined;

  const entry = activityService.log(sessionId, action, data, resolvedActor);

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ entry }));
}

/**
 * GET /api/sessions/:id/activity
 *
 * Query params:
 *   limit  — max entries to return (1–1000, default 100)
 *   offset — entries to skip (default 0)
 *   action — filter by action type (optional)
 *
 * Returns 200 with { activity: ActivityEntry[], total: number }
 * or 404 if the session is unknown.
 */
export function handleGetActivity(
  req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  activityService: ActivityService,
  sessionId: string,
): void {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);

  const limitParam = params.get('limit');
  const offsetParam = params.get('offset');
  const actionFilter = params.get('action') ?? undefined;

  const limit = limitParam ? parseInt(limitParam, 10) : 100;
  const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

  if (isNaN(limit) || isNaN(offset)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '"limit" and "offset" must be integers' }));
    return;
  }

  const { entries, total } = activityService.getActivity(sessionId, limit, offset, actionFilter);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ activity: entries, total }));
}
