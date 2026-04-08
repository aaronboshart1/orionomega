/**
 * @module routes/sessions
 * REST endpoints for session management.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SessionManager, DEFAULT_SESSION_ID } from '../sessions.js';
import { TtlCache, STATE_TTL_MS, ACTIVITY_TTL_MS } from './cache.js';
import type { ServerSessionStore } from '../state-store.js';
import type { PersistenceService } from '../persistence.js';

/** Module-scoped caches — one per endpoint family. */
const stateCache = new TtlCache<string>();
const activityCache = new TtlCache<string>();

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

/**
 * Handle GET /api/sessions/:id/state
 *
 * Returns the complete current session state suitable for UI reconstruction
 * after a new tab or window opens. The response is cached for STATE_TTL_MS
 * to avoid redundant serialisation of large message arrays when multiple
 * tabs open simultaneously.
 *
 * Response shape:
 * {
 *   id, createdAt, updatedAt,
 *   messages: Message[],
 *   memoryEvents: MemoryEventData[],
 *   activeWorkflows: string[],
 *   hindsightBank: string | null,
 *   clientCount: number,
 *   generatedAt: string   // ISO timestamp of when this snapshot was taken
 * }
 */
export function handleGetSessionState(
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

  const cacheKey = sessionId;
  const cached = stateCache.get(cacheKey);
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
    res.end(cached);
    return;
  }

  const body = JSON.stringify({
    ...sessionManager.toJSON(session),
    generatedAt: new Date().toISOString(),
  });

  stateCache.set(cacheKey, body, STATE_TTL_MS);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
  res.end(body);
}

/**
 * Handle GET /api/sessions/:id/activity?since=<ISO-timestamp>
 *
 * Returns messages and memory events that arrived after `since`, plus the
 * current active-workflow list. New browser tabs can call this after loading
 * the full state snapshot to catch any activity that occurred in the gap.
 *
 * Query parameters:
 *   since (required) — ISO-8601 timestamp; items with timestamps > this value
 *                      are included in the response.
 *
 * Response shape:
 * {
 *   sessionId: string,
 *   since: string,           // echoed back (normalised to ISO string)
 *   messages: Message[],
 *   memoryEvents: MemoryEventData[],
 *   activeWorkflows: string[],
 *   generatedAt: string
 * }
 *
 * Error responses:
 *   400 — missing or unparseable `since` parameter
 *   404 — session not found
 */
export function handleGetSessionActivity(
  req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  sessionId: string,
): void {
  // Parse `since` from the query string
  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);
  const sinceParam = params.get('since');

  if (!sinceParam) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required query parameter: since' }));
    return;
  }

  const sinceDate = new Date(sinceParam);
  if (isNaN(sinceDate.getTime())) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid `since` value — expected an ISO-8601 timestamp' }));
    return;
  }

  const cacheKey = `${sessionId}:${sinceDate.getTime()}`;
  const cached = activityCache.get(cacheKey);
  if (cached) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
    res.end(cached);
    return;
  }

  const activity = sessionManager.getActivitySince(sessionId, sinceDate);
  if (!activity) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const body = JSON.stringify({
    sessionId,
    since: sinceDate.toISOString(),
    messages: activity.messages,
    memoryEvents: activity.memoryEvents,
    activeWorkflows: activity.activeWorkflows,
    generatedAt: new Date().toISOString(),
  });

  activityCache.set(cacheKey, body, ACTIVITY_TTL_MS);
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
  res.end(body);
}

/**
 * Handle DELETE /api/sessions/:id — delete/cleanup a session.
 *
 * The default session cannot be deleted — returns 400 with an explanation.
 * For other sessions, removes from both SessionManager and StateStore.
 */
export function handleDeleteSession(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  stateStore: ServerSessionStore | undefined,
  sessionId: string,
): void {
  if (sessionId === DEFAULT_SESSION_ID) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Cannot delete the default session — use /reset to clear it' }));
    return;
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  sessionManager.deleteSession(sessionId);
  stateStore?.clearSession(sessionId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ deleted: true, sessionId }));
}

/**
 * Handle GET /api/sessions/:id/activity — paginated activity log from the state store.
 *
 * Query parameters:
 *   limit  (optional) — max items per page (default 100, max 500)
 *   offset (optional) — number of items to skip (default 0)
 *   types  (optional) — comma-separated event type filter (e.g. "message,dag_dispatched")
 *   since  (optional) — ISO-8601 timestamp; only events after this time
 *   before (optional) — ISO-8601 timestamp; only events before this time
 *   workflowId (optional) — filter to a specific workflow
 *
 * Response shape:
 * {
 *   items: StateEvent[],
 *   total: number,
 *   offset: number,
 *   limit: number,
 *   hasMore: boolean,
 *   sessionId: string
 * }
 */
export function handleGetSessionActivityPaginated(
  req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  stateStore: ServerSessionStore | undefined,
  sessionId: string,
): void {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  if (!stateStore) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'State store not available' }));
    return;
  }

  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);

  const typesParam = params.get('types');
  const types = typesParam ? typesParam.split(',').filter(Boolean) : undefined;

  const result = stateStore.queryEvents({
    sessionId,
    types: types as import('../state-types.js').StateEventType[] | undefined,
    workflowId: params.get('workflowId') ?? undefined,
    since: params.get('since') ?? undefined,
    before: params.get('before') ?? undefined,
    limit: params.has('limit') ? parseInt(params.get('limit')!, 10) : undefined,
    offset: params.has('offset') ? parseInt(params.get('offset')!, 10) : undefined,
  });

  const body = JSON.stringify({ ...result, sessionId });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Handle GET /api/events — gap recovery endpoint.
 *
 * Query parameters:
 *   sessionId (required) — session to query
 *   afterSeq  (optional) — return events with seq > this value (default 0)
 *   limit     (optional) — max events to return (default 500, max 500)
 */
export function handleGetEvents(
  req: IncomingMessage,
  res: ServerResponse,
  persistence: PersistenceService,
): void {
  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);

  const sessionId = params.get('sessionId');
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required query parameter: sessionId' }));
    return;
  }

  const afterSeq = parseInt(params.get('afterSeq') ?? '0', 10);
  const limit = Math.min(parseInt(params.get('limit') ?? '500', 10), 500);

  const evts = persistence.getEventsSince(sessionId, isNaN(afterSeq) ? 0 : afterSeq, limit);
  const latestSeq = persistence.getLatestSeq(sessionId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events: evts, latestSeq, sessionId, afterSeq }));
}

/**
 * Handle GET /api/sessions/:id/messages — paginated message list.
 *
 * Query parameters:
 *   afterSeq  (optional) — only messages with seq > this value
 *   beforeSeq (optional) — only messages with seq < this value
 *   limit     (optional) — max messages (default 200, max 500)
 */
export function handleGetSessionMessages(
  req: IncomingMessage,
  res: ServerResponse,
  persistence: PersistenceService,
  sessionId: string,
): void {
  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);

  const afterSeq = params.has('afterSeq') ? parseInt(params.get('afterSeq')!, 10) : undefined;
  const beforeSeq = params.has('beforeSeq') ? parseInt(params.get('beforeSeq')!, 10) : undefined;
  const limit = Math.min(parseInt(params.get('limit') ?? '200', 10), 500);

  const msgs = persistence.getMessages(sessionId, {
    afterSeq: afterSeq !== undefined && !isNaN(afterSeq) ? afterSeq : undefined,
    beforeSeq: beforeSeq !== undefined && !isNaN(beforeSeq) ? beforeSeq : undefined,
    limit,
  });
  const total = persistence.getMessageCount(sessionId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ messages: msgs, total, sessionId }));
}

/**
 * Handle GET /api/sessions/:id/events — session event log.
 *
 * Query parameters:
 *   afterSeq (optional) — return events with seq > this value (default 0)
 *   limit    (optional) — max events (default 500, max 500)
 */
export function handleGetSessionEvents(
  req: IncomingMessage,
  res: ServerResponse,
  persistence: PersistenceService,
  sessionId: string,
): void {
  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);

  const afterSeq = parseInt(params.get('afterSeq') ?? '0', 10);
  const limit = Math.min(parseInt(params.get('limit') ?? '500', 10), 500);

  const evts = persistence.getEventsSince(sessionId, isNaN(afterSeq) ? 0 : afterSeq, limit);
  const latestSeq = persistence.getLatestSeq(sessionId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events: evts, latestSeq, sessionId }));
}

/**
 * Handle GET /api/sessions/:id/export — full session snapshot export.
 *
 * Returns the complete persisted state for a session, suitable for
 * external archiving or client rehydration.
 */
export function handleExportSession(
  _req: IncomingMessage,
  res: ServerResponse,
  persistence: PersistenceService,
  _sessionManager: SessionManager,
  sessionId: string,
): void {
  const snapshot = persistence.buildSnapshot(sessionId);
  if (!snapshot) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sessionId, ...snapshot, exportedAt: new Date().toISOString() }));
}

/**
 * Handle GET /api/backup — create a point-in-time copy of the database.
 *
 * Copies `~/.orionomega/omega.db` to a timestamped backup file in the
 * same directory and returns the backup path.
 */
export function handleBackupDb(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const dir = resolve(homedir(), '.orionomega');
  const dbPath = resolve(dir, 'omega.db');

  if (!existsSync(dbPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Database file not found' }));
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(dir, `omega-backup-${timestamp}.db`);

  try {
    copyFileSync(dbPath, backupPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, backupPath }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}
